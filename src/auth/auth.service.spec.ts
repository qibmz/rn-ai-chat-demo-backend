import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { createHmac } from 'crypto';
import { Mock } from 'vitest';
import { BotsService } from '../chat/bots.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailQueue } from '../queues/email/email.queue.js';
import { RedisService } from '../redis/redis.service.js';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';

describe('AuthService', () => {
  let service: AuthService;
  let usersService: {
    findByEmail: Mock;
    create: Mock;
    findById: Mock;
    markEmailVerified: Mock;
    updatePassword: Mock;
  };
  let redisService: {
    set: Mock;
    get: Mock;
    getdel: Mock;
    incr: Mock;
    del: Mock;
    exists: Mock;
    sadd: Mock;
    srem: Mock;
    smembers: Mock;
    expire: Mock;
  };
  let emailQueue: {
    enqueue: Mock;
  };
  let jwtService: {
    signAsync: Mock;
    verifyAsync: Mock;
  };
  let prismaService: {
    $transaction: Mock;
  };
  let botsService: {
    createMainBotWithConversation: Mock;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: {
            findByEmail: vi.fn(),
            create: vi.fn(),
            findById: vi.fn(),
            markEmailVerified: vi.fn(),
            updatePassword: vi.fn(),
          },
        },
        {
          provide: BotsService,
          useValue: {
            createMainBotWithConversation: vi.fn().mockResolvedValue({
              botId: 'aaaaaaaa-aaaa-4111-8111-aaaaaaaaaaaa',
              conversationId: 'bbbbbbbb-bbbb-4222-8222-bbbbbbbbbbbb',
            }),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
              fn({
                user: {
                  create: vi.fn().mockResolvedValue({
                    id: '11111111-1111-1111-1111-111111111111',
                    email: 'user@example.com',
                    passwordHash: 'hash',
                    emailVerifiedAt: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  }),
                },
              }),
            ),
          },
        },
        {
          provide: JwtService,
          useValue: {
            signAsync: vi.fn().mockResolvedValue('token'),
            verifyAsync: vi.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string, fallback?: string) => {
              const map: Record<string, string> = {
                JWT_ACCESS_EXPIRES_IN: '15m',
                JWT_REFRESH_EXPIRES_IN: '7d',
                EMAIL_VERIFY_EXPIRES_IN: '24h',
                EMAIL_VERIFY_COOLDOWN: '60s',
                PASSWORD_RESET_EXPIRES_IN: '15m',
                PASSWORD_RESET_COOLDOWN: '60s',
                EMAIL_VERIFICATION_REQUIRED: 'false',
                APP_URL: 'http://localhost:3000',
                APP_NAME: 'Test App',
              };
              return map[key] ?? fallback;
            }),
            getOrThrow: vi.fn((key: string) => {
              const map: Record<string, string> = {
                JWT_ACCESS_SECRET: 'access-secret-for-tests-32chars!!',
                JWT_REFRESH_SECRET: 'refresh-secret-for-tests-32chars!',
              };
              return map[key];
            }),
          },
        },
        {
          provide: RedisService,
          useValue: {
            set: vi.fn(),
            get: vi.fn(),
            getdel: vi.fn(),
            incr: vi.fn().mockResolvedValue(1),
            del: vi.fn(),
            exists: vi.fn().mockResolvedValue(false),
            sadd: vi.fn(),
            srem: vi.fn(),
            smembers: vi.fn().mockResolvedValue([]),
            expire: vi.fn(),
          },
        },
        {
          provide: EmailQueue,
          useValue: {
            enqueue: vi.fn().mockResolvedValue('1'),
          },
        },
      ],
    }).compile();

    service = module.get(AuthService);
    usersService = module.get(UsersService);
    redisService = module.get(RedisService);
    emailQueue = module.get(EmailQueue);
    jwtService = module.get(JwtService);
    prismaService = module.get(PrismaService);
    botsService = module.get(BotsService);
  });

  it('registers a new user and enqueues verification email', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    redisService.get.mockResolvedValue(null);

    const result = await service.register({
      email: 'User@Example.com',
      password: 'password123',
    });

    expect(prismaService.$transaction).toHaveBeenCalled();
    expect(botsService.createMainBotWithConversation).toHaveBeenCalledWith(
      expect.anything(),
      '11111111-1111-1111-1111-111111111111',
      'Test App',
    );
    expect(result.accessToken).toBe('token');
    expect(result.refreshToken).toBe('token');
    expect(jwtService.signAsync).toHaveBeenCalled();
    expect(emailQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: expect.stringContaining('验证'),
        html: expect.stringContaining('验证邮箱'),
      }),
    );
    expect(redisService.set).toHaveBeenCalled();
    expect(redisService.sadd).toHaveBeenCalled();
  });

  it('rejects duplicate registration', async () => {
    usersService.findByEmail.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
      passwordHash: 'hash',
      emailVerifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.register({ email: 'user@example.com', password: 'password123' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects invalid login', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    await expect(
      service.login({ email: 'user@example.com', password: 'password123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('logs in with valid credentials', async () => {
    const passwordHash = await bcrypt.hash('password123', 4);
    usersService.findByEmail.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
      passwordHash,
      emailVerifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.login({
      email: 'user@example.com',
      password: 'password123',
    });

    expect(result.accessToken).toBeDefined();
  });

  it('verifies email with a valid token', async () => {
    redisService.get.mockResolvedValue('11111111-1111-1111-1111-111111111111');
    usersService.findById.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
      passwordHash: 'hash',
      emailVerifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    usersService.markEmailVerified.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
      passwordHash: 'hash',
      emailVerifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.verifyEmail('a'.repeat(64));

    expect(result).toEqual({
      success: true,
      email: 'user@example.com',
    });
    expect(usersService.markEmailVerified).toHaveBeenCalled();
  });

  it('sends password reset code for existing user', async () => {
    usersService.findByEmail.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
      passwordHash: 'hash',
      emailVerifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.forgotPassword('user@example.com');

    expect(result).toEqual({ success: true });
    expect(emailQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: expect.stringContaining('密码重置'),
        html: expect.stringContaining('重置密码验证码'),
      }),
    );
    expect(redisService.set).toHaveBeenCalled();
  });

  it('skips sending when forgot-password cooldown is active', async () => {
    redisService.exists.mockResolvedValue(true);

    const result = await service.forgotPassword('user@example.com');

    expect(result).toEqual({ success: true });
    expect(usersService.findByEmail).not.toHaveBeenCalled();
    expect(emailQueue.enqueue).not.toHaveBeenCalled();
  });

  const hmac = (value: string) =>
    createHmac('sha256', 'access-secret-for-tests-32chars!!')
      .update(value)
      .digest('hex');

  it('resets password with a valid code and revokes refresh tokens', async () => {
    const code = '12345678';
    redisService.get.mockResolvedValue(hmac(code));
    redisService.smembers.mockResolvedValue(['abc123']);
    usersService.findByEmail.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
      passwordHash: 'hash',
      emailVerifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    usersService.updatePassword.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
      passwordHash: 'new-hash',
      emailVerifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.resetPassword({
      email: 'user@example.com',
      code,
      newPassword: 'newPassword123',
    });

    expect(result).toEqual({ success: true });
    expect(usersService.updatePassword).toHaveBeenCalled();
    expect(redisService.smembers).toHaveBeenCalled();
    expect(redisService.del).toHaveBeenCalled();
    expect(redisService.incr).not.toHaveBeenCalled();
  });

  it('resend verification never exposes alreadyVerified', async () => {
    usersService.findByEmail.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
      passwordHash: 'hash',
      emailVerifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.resendVerification('user@example.com'),
    ).resolves.toEqual({ success: true });
    expect(emailQueue.enqueue).not.toHaveBeenCalled();
  });

  it('rejects login with wrong password', async () => {
    const passwordHash = await bcrypt.hash('password123', 4);
    usersService.findByEmail.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
      passwordHash,
      emailVerifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.login({ email: 'user@example.com', password: 'wrong' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects login for missing user after dummy bcrypt compare', async () => {
    usersService.findByEmail.mockResolvedValue(null);

    await expect(
      service.login({ email: 'nobody@example.com', password: 'password123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects login when EMAIL_VERIFICATION_REQUIRED and unverified', async () => {
    const passwordHash = await bcrypt.hash('password123', 4);
    usersService.findByEmail.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
      passwordHash,
      emailVerifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const configService = (
      service as unknown as {
        configService: { get: Mock };
      }
    ).configService;
    configService.get.mockImplementation((key: string, fallback?: string) => {
      if (key === 'EMAIL_VERIFICATION_REQUIRED') {
        return 'true';
      }
      const map: Record<string, string> = {
        JWT_ACCESS_EXPIRES_IN: '15m',
        JWT_REFRESH_EXPIRES_IN: '7d',
        EMAIL_VERIFY_EXPIRES_IN: '24h',
        EMAIL_VERIFY_COOLDOWN: '60s',
        PASSWORD_RESET_EXPIRES_IN: '15m',
        PASSWORD_RESET_COOLDOWN: '60s',
        APP_URL: 'http://localhost:3000',
        APP_NAME: 'Test App',
      };
      return map[key] ?? fallback;
    });

    await expect(
      service.login({ email: 'user@example.com', password: 'password123' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refresh reuse path calls getdel then revokes when token missing', async () => {
    redisService.getdel.mockResolvedValue(null);
    jwtService.verifyAsync.mockResolvedValue({
      sub: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
    });
    redisService.smembers.mockResolvedValue(['abc']);

    await expect(service.refresh('stale-refresh-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(redisService.getdel).toHaveBeenCalled();
    expect(redisService.smembers).toHaveBeenCalled();
    expect(redisService.del).toHaveBeenCalled();
  });

  it('rejects verifyEmail with unknown token', async () => {
    redisService.get.mockResolvedValue(null);
    await expect(service.verifyEmail('x'.repeat(64))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects verifyEmail when user is missing', async () => {
    redisService.get.mockResolvedValue('11111111-1111-1111-1111-111111111111');
    usersService.findById.mockResolvedValue(null);

    await expect(service.verifyEmail('x'.repeat(64))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('resends verification for unverified user', async () => {
    usersService.findByEmail.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
      passwordHash: 'hash',
      emailVerifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    redisService.get.mockResolvedValue(null);

    await expect(
      service.resendVerification('user@example.com'),
    ).resolves.toEqual({ success: true });
    expect(emailQueue.enqueue).toHaveBeenCalled();
  });

  it('forgotPassword for missing email still succeeds without arming cooldown', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    redisService.exists.mockResolvedValue(false);

    await expect(service.forgotPassword('nobody@example.com')).resolves.toEqual(
      { success: true },
    );
    expect(emailQueue.enqueue).not.toHaveBeenCalled();
    expect(redisService.set).not.toHaveBeenCalled();
  });

  it('rejects resetPassword when code is missing', async () => {
    redisService.get.mockResolvedValue(null);
    await expect(
      service.resetPassword({
        email: 'user@example.com',
        code: '12345678',
        newPassword: 'newPassword123',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects resetPassword with wrong code and increments attempts', async () => {
    redisService.get.mockResolvedValue(hmac('99999999'));
    redisService.incr.mockResolvedValue(1);

    await expect(
      service.resetPassword({
        email: 'user@example.com',
        code: '12345678',
        newPassword: 'newPassword123',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(redisService.incr).toHaveBeenCalled();
  });

  it('rejects resetPassword after too many attempts', async () => {
    redisService.get.mockResolvedValue(hmac('12345678'));
    redisService.incr.mockResolvedValue(5);

    await expect(
      service.resetPassword({
        email: 'user@example.com',
        code: '00000000',
        newPassword: 'newPassword123',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(redisService.del).toHaveBeenCalled();
  });

  it('rejects refresh with unknown token', async () => {
    redisService.getdel.mockResolvedValue(null);
    jwtService.verifyAsync.mockRejectedValue(new Error('missing'));
    await expect(service.refresh('missing-refresh')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects refresh when jwt verify fails', async () => {
    redisService.getdel.mockResolvedValue(
      '11111111-1111-1111-1111-111111111111',
    );
    jwtService.verifyAsync.mockRejectedValue(new Error('bad'));

    await expect(service.refresh('bad-refresh-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('logout removes refresh token when present', async () => {
    redisService.getdel.mockResolvedValue(
      '11111111-1111-1111-1111-111111111111',
    );
    await expect(service.logout('refresh-token-value')).resolves.toEqual({
      success: true,
    });
    expect(redisService.srem).toHaveBeenCalled();
  });

  it('rejects me when user is missing', async () => {
    usersService.findById.mockResolvedValue(null);
    await expect(service.me('missing')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('returns profile for me', async () => {
    usersService.findById.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
      passwordHash: 'hash',
      emailVerifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.me('11111111-1111-1111-1111-111111111111'),
    ).resolves.toMatchObject({
      email: 'user@example.com',
      emailVerified: true,
    });
  });
});

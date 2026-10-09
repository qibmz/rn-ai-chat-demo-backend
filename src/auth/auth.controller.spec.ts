import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { Mock } from 'vitest';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

describe('AuthController (HTTP)', () => {
  let app: INestApplication;
  let authService: {
    register: Mock;
    login: Mock;
    verifyEmail: Mock;
    resendVerification: Mock;
    forgotPassword: Mock;
    resetPassword: Mock;
    refresh: Mock;
    logout: Mock;
    me: Mock;
  };

  const tokens = {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresIn: '15m',
  };

  beforeEach(async () => {
    authService = {
      register: vi.fn().mockResolvedValue(tokens),
      login: vi.fn().mockResolvedValue(tokens),
      verifyEmail: vi.fn().mockResolvedValue({
        success: true,
        email: 'user@example.com',
      }),
      resendVerification: vi.fn().mockResolvedValue({ success: true }),
      forgotPassword: vi.fn().mockResolvedValue({ success: true }),
      resetPassword: vi.fn().mockResolvedValue({ success: true }),
      refresh: vi.fn().mockResolvedValue(tokens),
      logout: vi.fn().mockResolvedValue({ success: true }),
      me: vi.fn().mockResolvedValue({
        id: '11111111-1111-1111-1111-111111111111',
        email: 'user@example.com',
        emailVerified: false,
        createdAt: new Date().toISOString(),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string, fallback?: string) =>
              key === 'APP_NAME' ? 'Test App' : fallback,
            ),
          },
        },
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /auth/register', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'user@example.com', password: 'password123' })
      .expect(201);

    expect(res.body).toMatchObject({ code: 200, data: tokens });
    expect(authService.register).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'password123',
    });
  });

  it('POST /auth/register 冲突返回 409', async () => {
    authService.register.mockRejectedValue(
      new ConflictException('该邮箱已注册'),
    );
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'user@example.com', password: 'password123' })
      .expect(409);
  });

  it('POST /auth/login', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'user@example.com', password: 'password123' })
      .expect(200);

    expect(res.body).toMatchObject({ code: 200, data: tokens });
  });

  it('POST /auth/login 401', async () => {
    authService.login.mockRejectedValue(
      new UnauthorizedException('邮箱或密码错误'),
    );
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'user@example.com', password: 'wrongpass1' })
      .expect(401);
  });

  it('POST /auth/login 403 未验证邮箱', async () => {
    authService.login.mockRejectedValue(new ForbiddenException('请先验证邮箱'));
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'user@example.com', password: 'password123' })
      .expect(403);
  });

  it('POST /auth/verify-email', async () => {
    const token = 'a'.repeat(64);
    await request(app.getHttpServer())
      .post('/auth/verify-email')
      .send({ token })
      .expect(200);
    expect(authService.verifyEmail).toHaveBeenCalledWith(token);
  });

  it('GET /auth/verify-email?token=… returns HTML success page', async () => {
    const token = 'b'.repeat(64);
    const res = await request(app.getHttpServer())
      .get('/auth/verify-email')
      .query({ token })
      .expect(200);

    expect(authService.verifyEmail).toHaveBeenCalledWith(token);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('邮箱验证成功');
  });

  it('GET /auth/verify-email without token returns HTML 400', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/verify-email')
      .expect(400);
    expect(authService.verifyEmail).not.toHaveBeenCalled();
    expect(res.text).toContain('验证信息不完整');
  });

  it('GET /auth/verify-email with invalid token returns HTML failure page', async () => {
    authService.verifyEmail.mockRejectedValue(
      new BadRequestException('验证链接无效或已过期'),
    );
    const res = await request(app.getHttpServer())
      .get('/auth/verify-email')
      .query({ token: 'c'.repeat(64) })
      .expect(400);
    expect(res.text).toContain('验证链接无效或已过期');
  });

  it('POST /auth/resend-verification', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/resend-verification')
      .send({ email: 'user@example.com' })
      .expect(200);
    expect(res.body.data).toEqual({ success: true });
  });

  it('POST /auth/forgot-password', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: 'user@example.com' })
      .expect(200);
    expect(res.body.data).toEqual({ success: true });
  });

  it('POST /auth/reset-password', async () => {
    const body = {
      email: 'user@example.com',
      code: '12345678',
      newPassword: 'newPassword123',
    };
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send(body)
      .expect(200);
    expect(authService.resetPassword).toHaveBeenCalledWith(body);
  });

  it('POST /auth/reset-password 400', async () => {
    authService.resetPassword.mockRejectedValue(
      new BadRequestException('验证码无效或已过期'),
    );
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({
        email: 'user@example.com',
        code: '00000000',
        newPassword: 'newPassword123',
      })
      .expect(400);
  });

  it('POST /auth/refresh', async () => {
    const refreshToken = 'refresh-token-value';
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    expect(res.body.data).toEqual(tokens);
  });

  it('POST /auth/refresh 401', async () => {
    authService.refresh.mockRejectedValue(
      new UnauthorizedException('登录已失效，请重新登录'),
    );
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: 'bad-refresh-token' })
      .expect(401);
  });

  it('POST /auth/logout', async () => {
    const refreshToken = 'refresh-token-value';
    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken })
      .expect(200);
    expect(authService.logout).toHaveBeenCalledWith(refreshToken);
  });
});

import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from '../../users/users.service.js';
import { JwtStrategy } from './jwt.strategy.js';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let usersService: { findById: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    usersService = { findById: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: vi
              .fn()
              .mockReturnValue('access-secret-for-tests-32chars!!'),
          },
        },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();

    strategy = module.get(JwtStrategy);
  });

  it('returns AuthUser for valid payload', async () => {
    usersService.findById.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
    });

    await expect(
      strategy.validate({
        sub: '11111111-1111-1111-1111-111111111111',
        email: 'user@example.com',
      }),
    ).resolves.toEqual({
      userId: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.com',
    });
  });

  it('rejects when user is missing', async () => {
    usersService.findById.mockResolvedValue(null);
    await expect(
      strategy.validate({
        sub: 'missing',
        email: 'user@example.com',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

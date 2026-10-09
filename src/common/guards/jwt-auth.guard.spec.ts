import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard.js';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: { getAllAndOverride: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    reflector = { getAllAndOverride: vi.fn() };
    guard = new JwtAuthGuard(reflector as unknown as Reflector);
  });

  it('allows public routes without JWT', () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
    } as ExecutionContext;

    expect(guard.canActivate(context)).toBe(true);
  });

  it('maps missing user to Chinese 401', () => {
    expect(() => guard.handleRequest(null, null)).toThrow(
      UnauthorizedException,
    );
    try {
      guard.handleRequest(null, null);
    } catch (error) {
      expect((error as UnauthorizedException).message).toBe(
        '请先登录，或登录状态已失效',
      );
    }
  });

  it('maps TokenExpiredError on err to Chinese 401', () => {
    const expired = Object.assign(new Error('jwt expired'), {
      name: 'TokenExpiredError',
    });
    try {
      guard.handleRequest(expired, null);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).message).toBe(
        '登录已过期，请重新登录',
      );
    }
  });

  it('maps TokenExpiredError on info (passport-jwt) to Chinese 401', () => {
    const expired = Object.assign(new Error('jwt expired'), {
      name: 'TokenExpiredError',
    });
    try {
      guard.handleRequest(null, null, expired);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).message).toBe(
        '登录已过期，请重新登录',
      );
    }
  });

  it('returns user when present', () => {
    const user = { userId: '1', email: 'a@b.c' };
    expect(guard.handleRequest(null, user)).toBe(user);
  });
});

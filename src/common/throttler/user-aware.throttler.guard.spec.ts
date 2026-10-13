import { Reflector } from '@nestjs/core';
import { ThrottlerStorage } from '@nestjs/throttler';
import { UserAwareThrottlerGuard } from './user-aware.throttler.guard.js';

describe('UserAwareThrottlerGuard', () => {
  let guard: UserAwareThrottlerGuard;

  beforeEach(async () => {
    guard = new UserAwareThrottlerGuard(
      {
        throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }],
      },
      {} as ThrottlerStorage,
      new Reflector(),
    );
    await guard.onModuleInit();
  });

  it('uses userId tracker when request.user is set', async () => {
    const tracker = await guard['getTracker']({
      ip: '203.0.113.10',
      user: {
        userId: '11111111-1111-4111-8111-111111111111',
        email: 'u@example.com',
      },
    });
    expect(tracker).toBe('user:11111111-1111-4111-8111-111111111111');
  });

  it('falls back to IP when anonymous', async () => {
    const tracker = await guard['getTracker']({ ip: '127.0.0.1' });
    expect(tracker).toBe('127.0.0.1');
  });
});

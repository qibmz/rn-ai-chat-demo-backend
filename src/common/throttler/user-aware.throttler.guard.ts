import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthUser } from '../decorators/current-user.decorator.js';

/**
 * Authenticated requests rate-limit per userId; anonymous requests per client IP.
 * Register JwtAuthGuard before this guard so `request.user` is populated.
 */
@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as AuthUser | undefined;
    if (user?.userId) {
      return `user:${user.userId}`;
    }
    return super.getTracker(req);
  }
}

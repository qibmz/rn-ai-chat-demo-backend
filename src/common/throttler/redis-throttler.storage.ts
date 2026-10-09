import { Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { RedisService } from '../../redis/redis.service.js';

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/**
 * Shared Redis-backed throttler storage (works across multiple app instances).
 * ttl / blockDuration are milliseconds (Nest Throttler v6).
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redisService: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const client = this.redisService.getClient();
    const hitKey = `throttle:hits:${throttlerName}:${key}`;
    const blockKey = `throttle:block:${throttlerName}:${key}`;

    const blockTtl = await client.pttl(blockKey);
    if (blockTtl > 0) {
      return {
        totalHits: limit + 1,
        timeToExpire: 0,
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockTtl / 1000),
      };
    }

    const hits = await client.incr(hitKey);
    if (hits === 1) {
      await client.pexpire(hitKey, ttl);
    }

    const hitPttl = await client.pttl(hitKey);
    const timeToExpire =
      hitPttl > 0 ? Math.ceil(hitPttl / 1000) : Math.ceil(ttl / 1000);

    if (hits > limit && blockDuration > 0) {
      await client.set(blockKey, '1', 'PX', blockDuration);
      return {
        totalHits: hits,
        timeToExpire,
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockDuration / 1000),
      };
    }

    return {
      totalHits: hits,
      timeToExpire,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}

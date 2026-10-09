import { Injectable } from '@nestjs/common';
import { HealthCheckAttempt, HealthIndicatorService } from '@nestjs/terminus';
import { RedisService } from '../redis/redis.service.js';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly redisService: RedisService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  isHealthy(key: string): HealthCheckAttempt {
    return this.healthIndicatorService
      .check(key)
      .attempt(async () => {
        const pong = await this.redisService.ping();
        if (pong !== 'PONG') {
          throw new Error(`Unexpected ping response: ${pong}`);
        }
      })
      .withTimeout(3_000);
  }
}

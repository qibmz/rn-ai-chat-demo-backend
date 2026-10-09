import { HealthIndicatorService } from '@nestjs/terminus';
import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from '../redis/redis.service.js';
import { RedisHealthIndicator } from './redis.health.js';

describe('RedisHealthIndicator', () => {
  let indicator: RedisHealthIndicator;
  let redis: { ping: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    redis = { ping: vi.fn().mockResolvedValue('PONG') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisHealthIndicator,
        { provide: RedisService, useValue: redis },
        HealthIndicatorService,
      ],
    }).compile();

    indicator = module.get(RedisHealthIndicator);
  });

  it('reports up when redis returns PONG', async () => {
    const result = await indicator.isHealthy('redis');
    expect(result.redis.status).toBe('up');
    expect(redis.ping).toHaveBeenCalled();
  });

  it('reports down when redis ping is unexpected', async () => {
    redis.ping.mockResolvedValue('NOPE');
    const result = await indicator.isHealthy('redis');
    expect(result.redis.status).toBe('down');
  });

  it('reports down when redis ping throws', async () => {
    redis.ping.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await indicator.isHealthy('redis');
    expect(result.redis.status).toBe('down');
  });
});

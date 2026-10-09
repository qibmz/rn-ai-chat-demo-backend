import { HealthCheckService, HealthIndicatorService } from '@nestjs/terminus';
import { Test, TestingModule } from '@nestjs/testing';
import { Mock } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { HealthController } from './health.controller.js';
import { RedisHealthIndicator } from './redis.health.js';

describe('HealthController', () => {
  let controller: HealthController;
  let health: { check: Mock };
  let redisHealth: { isHealthy: Mock };
  let prisma: { $queryRaw: Mock };

  beforeEach(async () => {
    health = { check: vi.fn().mockResolvedValue({ status: 'ok' }) };
    redisHealth = {
      isHealthy: vi.fn().mockResolvedValue({ redis: { status: 'up' } }),
    };
    prisma = { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: health },
        {
          provide: HealthIndicatorService,
          useValue: {
            check: vi.fn().mockReturnValue({
              attempt: (fn: () => Promise<void>) => {
                const promise = (async () => {
                  await fn();
                  return { postgres: { status: 'up' } };
                })();
                return Object.assign(promise, {
                  withTimeout() {
                    return promise;
                  },
                });
              },
            }),
          },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RedisHealthIndicator, useValue: redisHealth },
      ],
    }).compile();

    controller = module.get(HealthController);
  });

  it('GET /health runs postgres + redis checks', async () => {
    const result = await controller.check();

    expect(health.check).toHaveBeenCalledTimes(1);
    const indicators = health.check.mock.calls[0][0] as Array<
      () => Promise<unknown>
    >;
    expect(indicators).toHaveLength(2);
    await indicators[0]();
    await indicators[1]();
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(redisHealth.isHealthy).toHaveBeenCalledWith('redis');
    expect(result).toEqual({ status: 'ok' });
  });
});

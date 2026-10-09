import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisHealthIndicator } from './redis.health.js';

@ApiTags('健康检查')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly prisma: PrismaService,
    private readonly redisHealth: RedisHealthIndicator,
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Postgres + Redis 健康检查' })
  @ApiOkResponse({
    description: 'Terminus 健康检查结果（不包统一响应外壳）',
  })
  check() {
    return this.health.check([
      () =>
        this.healthIndicatorService
          .check('postgres')
          .attempt(async () => {
            await this.prisma.$queryRaw`SELECT 1`;
          })
          .withTimeout(3_000),
      () => this.redisHealth.isHealthy('redis'),
    ]);
  }
}

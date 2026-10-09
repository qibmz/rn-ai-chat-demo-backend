import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { SentryModule } from '@sentry/nestjs/setup';
import { WinstonModule } from 'nest-winston';
import { AuthModule } from './auth/auth.module.js';
import { validateEnv } from './common/config/env.validation.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { TransformInterceptor } from './common/interceptors/transform.interceptor.js';
import { createWinstonConfig } from './common/logger/winston.config.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { QueueModule } from './queues/queue.module.js';
import { RedisModule } from './redis/redis.module.js';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    SentryModule.forRoot(),
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    RedisModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule, RedisModule],
      inject: [ConfigService, RedisThrottlerStorage],
      useFactory: (
        configService: ConfigService,
        storage: RedisThrottlerStorage,
      ) => ({
        throttlers: [
          {
            name: 'default',
            ttl: Number(configService.get('THROTTLE_TTL_MS', '60000')),
            limit: Number(configService.get('THROTTLE_LIMIT', '100')),
          },
        ],
        storage,
      }),
    }),
    WinstonModule.forRoot(createWinstonConfig()),
    PrismaModule,
    QueueModule,
    UsersModule,
    AuthModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}

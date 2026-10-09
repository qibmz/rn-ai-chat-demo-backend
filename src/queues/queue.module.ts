import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EMAIL_QUEUE } from './queue.constants.js';
import { EmailProcessor } from './email/email.processor.js';
import { EmailQueue } from './email/email.queue.js';
import { EmailService } from './email/email.service.js';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const url = configService.get<string>('REDIS_URL');
        if (url) {
          return { connection: { url, maxRetriesPerRequest: null } };
        }
        return {
          connection: {
            host: configService.get<string>('REDIS_HOST', 'localhost'),
            port: Number(configService.get<string>('REDIS_PORT', '6379')),
            password: configService.get<string>('REDIS_PASSWORD') || undefined,
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    BullModule.registerQueue({ name: EMAIL_QUEUE }),
  ],
  providers: [EmailService, EmailQueue, EmailProcessor],
  exports: [EmailService, EmailQueue, BullModule],
})
export class QueueModule {}

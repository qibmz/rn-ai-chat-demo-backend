import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotsController } from './bots.controller.js';
import { BotsService } from './bots.service.js';
import { ChatAttachmentsController } from './chat-attachments.controller.js';
import { ChatAttachmentsService } from './chat-attachments.service.js';
import { ChatBillingService } from './chat-billing.service.js';
import { ChatConversationsController } from './chat-conversations.controller.js';
import { ChatConversationsService } from './chat-conversations.service.js';
import { ChatFileUploadInterceptor } from './chat-file-upload.interceptor.js';
import { ChatMessagesService } from './chat-messages.service.js';
import { ChatQuotaController } from './chat-quota.controller.js';
import { ChatQuotaService } from './chat-quota.service.js';
import { ChatStreamService } from './chat-stream.service.js';
import { DeepSeekToolsClient } from './llm/deepseek-tools.client.js';
import { R2Module } from '../storage/r2/r2.module.js';

@Module({
  imports: [R2Module],
  controllers: [
    BotsController,
    ChatAttachmentsController,
    ChatConversationsController,
    ChatQuotaController,
  ],
  providers: [
    BotsService,
    ChatAttachmentsService,
    ChatBillingService,
    ChatConversationsService,
    ChatMessagesService,
    ChatQuotaService,
    ChatStreamService,
    ChatFileUploadInterceptor,
    {
      provide: DeepSeekToolsClient,
      useFactory: (config: ConfigService) =>
        new DeepSeekToolsClient({
          apiKey: config.getOrThrow<string>('LLM_API_KEY'),
          baseURL: config.getOrThrow<string>('LLM_BASE_URL'),
        }),
      inject: [ConfigService],
    },
  ],
  exports: [
    BotsService,
    ChatAttachmentsService,
    ChatBillingService,
    ChatConversationsService,
    ChatMessagesService,
    ChatQuotaService,
    ChatStreamService,
  ],
})
export class ChatModule {}

import { Module } from '@nestjs/common';
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
import { R2Module } from '../storage/r2/r2.module.js';

@Module({
  imports: [R2Module],
  controllers: [
    ChatAttachmentsController,
    ChatConversationsController,
    ChatQuotaController,
  ],
  providers: [
    ChatAttachmentsService,
    ChatBillingService,
    ChatConversationsService,
    ChatMessagesService,
    ChatQuotaService,
    ChatStreamService,
    ChatFileUploadInterceptor,
  ],
  exports: [
    ChatAttachmentsService,
    ChatBillingService,
    ChatConversationsService,
    ChatMessagesService,
    ChatQuotaService,
    ChatStreamService,
  ],
})
export class ChatModule {}

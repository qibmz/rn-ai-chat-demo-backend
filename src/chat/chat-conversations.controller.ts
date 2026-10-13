import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AiUiStream } from '../common/decorators/ai-ui-stream.decorator.js';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator.js';
import { ChatConversationsService } from './chat-conversations.service.js';
import { ChatMessagesService } from './chat-messages.service.js';
import { ChatStreamService } from './chat-stream.service.js';
import { ListConversationsQueryDto } from './dto/list-conversations-query.dto.js';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto.js';
import { StreamMessagesDto } from './dto/stream-messages.dto.js';
import { UpdateConversationDto } from './dto/update-conversation.dto.js';

@ApiTags('聊天')
@ApiBearerAuth()
@Throttle({ default: { limit: 60, ttl: 60000 } })
@Controller('chat/conversations')
export class ChatConversationsController {
  constructor(
    private readonly conversationsService: ChatConversationsService,
    private readonly messagesService: ChatMessagesService,
    private readonly streamService: ChatStreamService,
  ) {}

  @Get()
  @ApiOperation({ summary: '会话列表' })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListConversationsQueryDto,
  ) {
    return this.conversationsService.list(user.userId, query.botId);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取会话详情' })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversationsService.getById(user.userId, id);
  }

  @Patch(':id')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({ summary: '更新会话标题或软删除' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConversationDto,
  ) {
    return this.conversationsService.update(user.userId, id, dto);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: '分页获取会话消息（图片附件现签）' })
  @ApiOkResponse({ description: '消息列表' })
  messages(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.messagesService.list(user.userId, id, query);
  }

  @Post(':id/messages/stream')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @AiUiStream()
  @ApiOperation({
    summary: '流式发送消息（DeepSeek + AI SDK UI Message Stream）',
  })
  stream(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StreamMessagesDto,
    @Res({ passthrough: false }) res: Response,
  ) {
    return this.streamService.stream(user.userId, id, dto, res);
  }
}

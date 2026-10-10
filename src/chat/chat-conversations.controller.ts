import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator.js';
import { ChatConversationsService } from './chat-conversations.service.js';
import { ChatMessagesService } from './chat-messages.service.js';
import { CreateConversationDto } from './dto/create-conversation.dto.js';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto.js';
import { UpdateConversationDto } from './dto/update-conversation.dto.js';

@ApiTags('聊天')
@ApiBearerAuth()
@Controller('chat/conversations')
export class ChatConversationsController {
  constructor(
    private readonly conversationsService: ChatConversationsService,
    private readonly messagesService: ChatMessagesService,
  ) {}

  @Post()
  @ApiOperation({ summary: '创建会话' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateConversationDto) {
    return this.conversationsService.create(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: '会话列表' })
  list(@CurrentUser() user: AuthUser) {
    return this.conversationsService.list(user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取会话详情' })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversationsService.getById(user.userId, id);
  }

  @Patch(':id')
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
}

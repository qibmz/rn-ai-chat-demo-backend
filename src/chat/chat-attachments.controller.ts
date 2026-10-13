import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator.js';
import { ChatAttachmentsService } from './chat-attachments.service.js';
import { ChatFileUploadInterceptor } from './chat-file-upload.interceptor.js';

@ApiTags('聊天')
@ApiBearerAuth()
@Throttle({ default: { limit: 60, ttl: 60000 } })
@Controller('chat/attachments')
export class ChatAttachmentsController {
  constructor(private readonly attachmentsService: ChatAttachmentsService) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: '上传聊天图片附件' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
      required: ['file'],
    },
  })
  @UseInterceptors(ChatFileUploadInterceptor)
  upload(
    @CurrentUser() user: AuthUser,
    @Req() req: Request & { file?: Express.Multer.File },
  ) {
    return this.attachmentsService.upload(
      user.userId,
      req.file as Express.Multer.File,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: '获取附件临时访问链接' })
  @ApiOkResponse({ description: '现签 GET URL' })
  presign(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.attachmentsService.presignForUser(user.userId, id);
  }
}

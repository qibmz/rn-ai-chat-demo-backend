import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

/**
 * AI SDK UIMessage 子集。用嵌套 class + @Type，避免全局
 * enableImplicitConversion 把普通对象误转成 Array，导致 @IsObject 误杀。
 */
export class StreamUiMessageDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty({ example: 'user' })
  @IsString()
  role!: string;

  @ApiPropertyOptional({
    description: 'UIMessage parts',
    type: 'array',
    items: { type: 'object' },
  })
  @IsOptional()
  @Allow()
  parts?: Array<{ type?: string; text?: string; [key: string]: unknown }>;

  /** AI SDK UIMessage.metadata（透传，服务端不消费） */
  @ApiPropertyOptional()
  @IsOptional()
  @Allow()
  metadata?: unknown;
}

/**
 * Body compatible with AI SDK UI `useChat` / `DefaultChatTransport`.
 * Transport 还会带上 id / trigger / messageId，需放行以免 forbidNonWhitelisted 误杀。
 */
export class StreamMessagesDto {
  @ApiProperty({
    description: 'AI SDK UIMessage 列表（useChat DefaultChatTransport）',
    type: [StreamUiMessageDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StreamUiMessageDto)
  messages!: StreamUiMessageDto[];

  /** DefaultChatTransport：useChat 的 chat id */
  @ApiPropertyOptional({ description: 'AI SDK chat id（transport 自动带）' })
  @IsOptional()
  @IsString()
  id?: string;

  /** DefaultChatTransport：submit-message | regenerate-message */
  @ApiPropertyOptional({
    description: 'AI SDK trigger（transport 自动带）',
    enum: ['submit-message', 'regenerate-message'],
  })
  @IsOptional()
  @IsIn(['submit-message', 'regenerate-message'])
  trigger?: 'submit-message' | 'regenerate-message';

  /** DefaultChatTransport：regenerate 时的 messageId */
  @ApiPropertyOptional({ description: 'AI SDK messageId（transport 自动带）' })
  @IsOptional()
  @IsString()
  messageId?: string;

  @ApiPropertyOptional({ description: '是否启用思考模式' })
  @IsOptional()
  @IsBoolean()
  thinking?: boolean;

  @ApiPropertyOptional({
    description: '思考强度',
    enum: ['low', 'high', 'max'],
  })
  @IsOptional()
  @IsIn(['low', 'high', 'max'])
  reasoningEffort?: 'low' | 'high' | 'max';

  @ApiPropertyOptional({
    description: '本轮用户消息关联的附件 ID',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  attachmentIds?: string[];
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsUUID,
} from 'class-validator';

/**
 * Body compatible with AI SDK UI `useChat` / `DefaultChatTransport`.
 * `messages` keep UIMessage shape (validated loosely).
 */
export class StreamMessagesDto {
  @ApiProperty({
    description: 'AI SDK UIMessage 列表（useChat DefaultChatTransport）',
    type: 'array',
    items: { type: 'object' },
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsObject({ each: true })
  messages!: Array<{
    id?: string;
    role: string;
    parts?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
  }>;

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

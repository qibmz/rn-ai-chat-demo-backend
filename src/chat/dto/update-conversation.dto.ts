import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateConversationDto {
  @ApiPropertyOptional({ description: '会话标题', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ description: '设为 true 软删除会话' })
  @IsOptional()
  @IsBoolean()
  deleted?: boolean;
}

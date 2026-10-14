import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateBotDto {
  @ApiProperty({ maxLength: 50 })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name!: string;

  @ApiProperty({ example: '#DB2777' })
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  faceColor!: string;

  @ApiProperty({ enum: ['circle', 'oval', 'squircle'] })
  @IsIn(['circle', 'oval', 'squircle'])
  faceShape!: 'circle' | 'oval' | 'squircle';

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  systemPrompt?: string;
}

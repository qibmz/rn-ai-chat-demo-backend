import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateBotDto {
  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  faceColor?: string;

  @ApiPropertyOptional({ enum: ['circle', 'oval', 'squircle'] })
  @IsOptional()
  @IsIn(['circle', 'oval', 'squircle'])
  faceShape?: 'circle' | 'oval' | 'squircle';

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  systemPrompt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  deleted?: boolean;
}

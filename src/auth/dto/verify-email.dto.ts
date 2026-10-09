import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MinLength } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({
    description: '邮件确认链接中的验证令牌',
    minLength: 32,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: '验证信息不完整' })
  @MinLength(32, { message: '验证链接无效' })
  token!: string;
}

import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ example: 'user@example.com', description: '注册邮箱' })
  @IsEmail()
  email!: string;

  @ApiProperty({
    example: '12345678',
    minLength: 8,
    maxLength: 8,
    description: '邮件中的 8 位验证码',
  })
  @IsString()
  @Length(8, 8)
  code!: string;

  @ApiProperty({
    example: 'newPassword123',
    minLength: 8,
    maxLength: 72,
    description: '新密码（8–72 位）',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword!: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class ResendVerificationDto {
  @ApiProperty({ example: 'user@example.com', description: '注册邮箱' })
  @IsEmail()
  email!: string;
}

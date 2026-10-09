import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com', description: '邮箱' })
  @IsEmail()
  email!: string;

  @ApiProperty({
    example: 'password123',
    minLength: 8,
    maxLength: 72,
    description: '密码（8–72 位，bcrypt 有效上限）',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}

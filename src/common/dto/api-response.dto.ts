import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiSuccessResponseDto<T = unknown> {
  @ApiProperty({ example: 200, description: '业务成功码' })
  code!: number;

  @ApiProperty({ example: 'OK', description: '提示信息' })
  message!: string;

  @ApiProperty({ description: '业务数据' })
  data!: T;

  @ApiProperty({
    example: '2026-10-08T10:00:00.000Z',
    description: '响应时间',
  })
  timestamp!: string;

  @ApiProperty({ example: '/auth/login', description: '请求路径' })
  path!: string;
}

export class ApiErrorResponseDto {
  @ApiProperty({ example: 400, description: 'HTTP / 业务错误码' })
  code!: number;

  @ApiProperty({ example: '参数校验失败', description: '错误信息' })
  message!: string;

  @ApiPropertyOptional({
    example: ['email must be an email'],
    nullable: true,
    type: [String],
    description: '字段级校验错误列表',
  })
  errors!: string[] | null;

  @ApiProperty({
    example: '2026-10-08T10:00:00.000Z',
    description: '响应时间',
  })
  timestamp!: string;

  @ApiProperty({ example: '/auth/register', description: '请求路径' })
  path!: string;
}

export class TokenPairDto {
  @ApiProperty({ description: '访问令牌' })
  accessToken!: string;

  @ApiProperty({ description: '刷新令牌' })
  refreshToken!: string;

  @ApiProperty({ example: '15m', description: '访问令牌有效期' })
  expiresIn!: string;
}

export class UserProfileDto {
  @ApiProperty({ format: 'uuid', description: '用户 ID' })
  id!: string;

  @ApiProperty({ example: 'user@example.com', description: '邮箱' })
  email!: string;

  @ApiProperty({ example: false, description: '邮箱是否已验证' })
  emailVerified!: boolean;

  @ApiProperty({ description: '注册时间' })
  createdAt!: Date;
}

export class LogoutResultDto {
  @ApiProperty({ example: true, description: '是否成功' })
  success!: boolean;
}

export class VerifyEmailResultDto {
  @ApiProperty({ example: true, description: '是否成功' })
  success!: boolean;

  @ApiProperty({ example: 'user@example.com', description: '已验证的邮箱' })
  email!: string;
}

export class ResendVerificationResultDto {
  @ApiProperty({ example: true, description: '是否成功' })
  success!: boolean;
}

export class PasswordActionResultDto {
  @ApiProperty({ example: true, description: '是否成功' })
  success!: boolean;
}

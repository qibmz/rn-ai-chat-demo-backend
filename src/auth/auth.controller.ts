import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import {
  ApiErrorResponseDto,
  ApiSuccessResponseDto,
  LogoutResultDto,
  PasswordActionResultDto,
  ResendVerificationResultDto,
  TokenPairDto,
  UserProfileDto,
  VerifyEmailResultDto,
} from '../common/dto/api-response.dto.js';
import { AuthService } from './auth.service.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { ResendVerificationDto } from './dto/resend-verification.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
import {
  renderVerifyEmailFailurePage,
  renderVerifyEmailSuccessPage,
} from './verify-email-page.js';

@ApiTags('认证')
@ApiExtraModels(
  ApiSuccessResponseDto,
  ApiErrorResponseDto,
  TokenPairDto,
  UserProfileDto,
  LogoutResultDto,
  VerifyEmailResultDto,
  ResendVerificationResultDto,
  PasswordActionResultDto,
)
@Throttle({ default: { limit: 30, ttl: 60000 } })
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  private appName(): string {
    return this.configService.get<string>('APP_NAME', 'App').trim() || 'App';
  }

  @Public()
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: '注册账号并发送邮箱确认邮件' })
  @ApiBody({ type: RegisterDto })
  @ApiOkResponse({
    description: '注册成功并签发令牌（邮箱可能尚未验证）',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ApiSuccessResponseDto) },
        {
          properties: {
            data: { $ref: getSchemaPath(TokenPairDto) },
          },
        },
      ],
    },
  })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: '邮箱密码登录' })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({
    description: '登录成功',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ApiSuccessResponseDto) },
        {
          properties: {
            data: { $ref: getSchemaPath(TokenPairDto) },
          },
        },
      ],
    },
  })
  @ApiUnauthorizedResponse({
    description: '邮箱或密码错误',
    type: ApiErrorResponseDto,
  })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: '使用确认令牌验证邮箱（POST）' })
  @ApiBody({ type: VerifyEmailDto })
  @ApiOkResponse({
    description: '邮箱验证成功',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ApiSuccessResponseDto) },
        {
          properties: {
            data: { $ref: getSchemaPath(VerifyEmailResultDto) },
          },
        },
      ],
    },
  })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.token);
  }

  @Public()
  @Get('verify-email')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: '通过邮件链接验证邮箱（返回 HTML 页面，非 JSON）',
  })
  @ApiQuery({
    name: 'token',
    required: true,
    description: '邮件确认链接中的验证令牌',
  })
  @ApiProduces('text/html')
  @ApiOkResponse({
    description: '验证成功或失败时均返回中文 HTML 页面',
    content: {
      'text/html': {
        schema: { type: 'string' },
      },
    },
  })
  async verifyEmailByQuery(
    @Query('token') token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const trimmed = typeof token === 'string' ? token.trim() : '';
    const appName = this.appName();
    if (!trimmed) {
      res
        .status(400)
        .type('html')
        .send(
          renderVerifyEmailFailurePage(
            '验证信息不完整，请通过邮件中的链接打开',
            appName,
          ),
        );
      return;
    }
    if (trimmed.length < 32) {
      res
        .status(400)
        .type('html')
        .send(renderVerifyEmailFailurePage('验证链接无效', appName));
      return;
    }

    try {
      const result = await this.authService.verifyEmail(trimmed);
      res
        .status(200)
        .type('html')
        .send(renderVerifyEmailSuccessPage(result.email, appName));
    } catch (error) {
      // Only map known HTTP failures to HTML; rethrow 5xx so filter/Sentry see them
      if (!(error instanceof HttpException)) {
        throw error;
      }
      const message = this.httpExceptionMessage(error);
      const status = error.getStatus();
      res
        .status(status >= 400 && status < 600 ? status : 400)
        .type('html')
        .send(renderVerifyEmailFailurePage(message, appName));
    }
  }

  private httpExceptionMessage(error: HttpException): string {
    const payload = error.getResponse();
    if (typeof payload === 'string') {
      return payload;
    }
    if (typeof payload === 'object' && payload !== null) {
      const raw = (payload as { message?: string | string[] }).message;
      if (Array.isArray(raw)) {
        return raw.map(String).join('；') || '参数校验失败';
      }
      if (raw !== undefined) {
        return String(raw);
      }
    }
    return error.message || '验证失败';
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: '重发邮箱确认邮件' })
  @ApiBody({ type: ResendVerificationDto })
  @ApiOkResponse({
    description: '已受理（不暴露邮箱是否存在或是否已验证）',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ApiSuccessResponseDto) },
        {
          properties: {
            data: { $ref: getSchemaPath(ResendVerificationResultDto) },
          },
        },
      ],
    },
  })
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.authService.resendVerification(dto.email);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: '发送 8 位找回密码验证码' })
  @ApiBody({ type: ForgotPasswordDto })
  @ApiOkResponse({
    description: '已受理（不暴露邮箱是否存在；有发送冷却）',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ApiSuccessResponseDto) },
        {
          properties: {
            data: { $ref: getSchemaPath(PasswordActionResultDto) },
          },
        },
      ],
    },
  })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: '使用邮箱验证码重置密码' })
  @ApiBody({ type: ResetPasswordDto })
  @ApiOkResponse({
    description: '重置成功，并吊销该用户全部刷新令牌',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ApiSuccessResponseDto) },
        {
          properties: {
            data: { $ref: getSchemaPath(PasswordActionResultDto) },
          },
        },
      ],
    },
  })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({ summary: '刷新访问令牌与刷新令牌' })
  @ApiBody({ type: RefreshTokenDto })
  @ApiOkResponse({
    description: '刷新成功，返回新的令牌对',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ApiSuccessResponseDto) },
        {
          properties: {
            data: { $ref: getSchemaPath(TokenPairDto) },
          },
        },
      ],
    },
  })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '退出登录（使刷新令牌失效）' })
  @ApiBody({ type: RefreshTokenDto })
  @ApiOkResponse({
    description: '退出成功',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ApiSuccessResponseDto) },
        {
          properties: {
            data: { $ref: getSchemaPath(LogoutResultDto) },
          },
        },
      ],
    },
  })
  logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @Get('me')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: '获取当前登录用户信息' })
  @ApiOkResponse({
    description: '当前用户资料',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ApiSuccessResponseDto) },
        {
          properties: {
            data: { $ref: getSchemaPath(UserProfileDto) },
          },
        },
      ],
    },
  })
  @ApiUnauthorizedResponse({
    description: '请先登录，或登录状态已失效',
    type: ApiErrorResponseDto,
  })
  me(@CurrentUser() user: AuthUser) {
    return this.authService.me(user.userId);
  }
}

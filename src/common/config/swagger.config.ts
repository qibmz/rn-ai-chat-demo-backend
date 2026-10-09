import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  ApiErrorResponseDto,
  ApiSuccessResponseDto,
  LogoutResultDto,
  TokenPairDto,
  UserProfileDto,
} from '../dto/api-response.dto.js';

export function setupSwagger(app: INestApplication): void {
  const configService = app.get(ConfigService);
  const isProd = configService.get<string>('NODE_ENV') === 'production';
  const configured = configService.get<string>('SWAGGER_ENABLED');
  const enabled = configured !== undefined ? configured !== 'false' : !isProd; // production defaults to off unless explicitly enabled
  if (!enabled) {
    return;
  }

  const swaggerPath = configService.get<string>('SWAGGER_PATH', 'api-docs');
  const appName = configService.get<string>('APP_NAME', 'App').trim() || 'App';

  const swaggerConfig = new DocumentBuilder()
    .setTitle(appName)
    .setDescription(
      `${appName} API（NestJS + Prisma + Redis + BullMQ）。成功响应格式为 \`{ code: 200, message, data, timestamp, path }\`。`,
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: '填写 /auth/login 返回的 accessToken',
      },
      'bearer',
    )
    .addTag('认证', '登录注册、邮箱验证、找回密码、当前用户')
    .addTag('健康检查', '存活 / 就绪探针')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig, {
    extraModels: [
      ApiSuccessResponseDto,
      ApiErrorResponseDto,
      TokenPairDto,
      UserProfileDto,
      LogoutResultDto,
    ],
  });

  SwaggerModule.setup(swaggerPath, app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
    customSiteTitle: `${appName} API 文档`,
  });
}

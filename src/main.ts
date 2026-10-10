import './instrument.js';

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { AppModule } from './app.module.js';
import { setupSwagger } from './common/config/swagger.config.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const isProd = configService.get<string>('NODE_ENV') === 'production';

  // Required behind nginx/ALB/Docker so Throttler sees real client IPs
  const trustProxy = configService.get<string>(
    'TRUST_PROXY',
    isProd ? '1' : '0',
  );
  if (trustProxy !== '0' && trustProxy.toLowerCase() !== 'false') {
    const httpAdapter = app.getHttpAdapter();
    const instance = httpAdapter.getInstance() as {
      set?: (key: string, value: unknown) => void;
    };
    instance.set?.(
      'trust proxy',
      trustProxy === '1' || trustProxy === 'true' ? 1 : trustProxy,
    );
  }

  app.use(
    helmet({
      // Swagger UI needs inline scripts/styles in non-locked CSP
      contentSecurityPolicy: isProd ? undefined : false,
    }),
  );

  const corsOrigins = (configService.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!isProd) {
    // Local/dev: reflect any Origin (Expo :8081, Vite, etc.) — ignore CORS_ORIGINS allowlist
    app.enableCors({ origin: true, credentials: true });
  } else if (corsOrigins.length > 0) {
    app.enableCors({ origin: corsOrigins, credentials: true });
  } else {
    // Production without CORS_ORIGINS: same-origin only (no ACAO *)
    app.enableCors({ origin: false });
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  setupSwagger(app);

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);
}

void bootstrap();

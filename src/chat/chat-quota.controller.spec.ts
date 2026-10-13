import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor.js';
import { ChatQuotaController } from './chat-quota.controller.js';
import { ChatQuotaService } from './chat-quota.service.js';

describe('ChatQuotaController (HTTP)', () => {
  let app: INestApplication;
  let quotaService: { getQuota: ReturnType<typeof vi.fn> };
  let authUser: { userId: string; email: string } | null;

  const quota = {
    usedPercent: 12.5,
    remainingPercent: 87.5,
    usedRatio: 0.125,
    period: '2026-W41',
    resetsAt: '2026-10-13T00:00:00.000Z',
    resetsInSeconds: 86400,
  };

  beforeEach(async () => {
    authUser = {
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'u@example.com',
    };
    quotaService = {
      getQuota: vi.fn().mockResolvedValue(quota),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatQuotaController],
      providers: [
        { provide: ChatQuotaService, useValue: quotaService },
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
        {
          provide: APP_GUARD,
          useValue: {
            canActivate: (ctx: {
              switchToHttp: () => { getRequest: () => { user?: unknown } };
            }) => {
              if (!authUser) {
                throw new UnauthorizedException('请先登录，或登录状态已失效');
              }
              const req = ctx.switchToHttp().getRequest();
              req.user = authUser;
              return true;
            },
          },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /chat/quota returns quota envelope', async () => {
    const res = await request(app.getHttpServer())
      .get('/chat/quota')
      .expect(200);

    expect(res.body).toMatchObject({ code: 200, data: quota });
    expect(quotaService.getQuota).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('GET /chat/quota returns 401 without auth user', async () => {
    authUser = null;
    const res = await request(app.getHttpServer())
      .get('/chat/quota')
      .expect(401);
    expect(res.body.message).toBe('请先登录，或登录状态已失效');
  });
});

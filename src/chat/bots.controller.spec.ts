import {
  BadRequestException,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor.js';
import { BotsController } from './bots.controller.js';
import { BotsService } from './bots.service.js';

describe('BotsController (HTTP)', () => {
  let app: INestApplication;
  let botsService: {
    list: ReturnType<typeof vi.fn>;
    createSub: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  let authUser: { userId: string; email: string } | null;

  const botId = 'aaaaaaaa-aaaa-4111-8111-aaaaaaaaaaaa';
  const bot = {
    id: botId,
    name: '子 Bot',
    kind: 'sub' as const,
    faceColor: '#DB2777',
    faceShape: 'circle' as const,
    systemPrompt: null,
    conversationId: 'bbbbbbbb-bbbb-4222-8222-bbbbbbbbbbbb',
    lastMessagePreview: null,
    lastMessageAt: null,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };

  beforeEach(async () => {
    authUser = {
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'u@example.com',
    };
    botsService = {
      list: vi.fn().mockResolvedValue([bot]),
      createSub: vi.fn().mockResolvedValue(bot),
      getById: vi.fn().mockResolvedValue(bot),
      update: vi.fn().mockResolvedValue(bot),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BotsController],
      providers: [
        { provide: BotsService, useValue: botsService },
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

  it('GET /bots lists bots', async () => {
    const res = await request(app.getHttpServer()).get('/bots').expect(200);
    expect(res.body.data).toEqual([bot]);
    expect(botsService.list).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('POST /bots creates sub bot', async () => {
    const body = {
      name: '子 Bot',
      faceColor: '#DB2777',
      faceShape: 'circle',
    };
    const res = await request(app.getHttpServer())
      .post('/bots')
      .send(body)
      .expect(201);

    expect(res.body).toMatchObject({ code: 200, data: bot });
    expect(botsService.createSub).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining(body),
    );
  });

  it('GET /bots/:id returns bot', async () => {
    const res = await request(app.getHttpServer())
      .get(`/bots/${botId}`)
      .expect(200);
    expect(res.body.data).toEqual(bot);
    expect(botsService.getById).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      botId,
    );
  });

  it('PATCH /bots/:id deleting main bot returns 400', async () => {
    botsService.update.mockRejectedValue(
      new BadRequestException('主 Bot 不可删除'),
    );
    const res = await request(app.getHttpServer())
      .patch(`/bots/${botId}`)
      .send({ deleted: true })
      .expect(400);
    expect(res.body.message).toBe('主 Bot 不可删除');
  });

  it('GET /bots returns 401 without auth', async () => {
    authUser = null;
    await request(app.getHttpServer()).get('/bots').expect(401);
    expect(botsService.list).not.toHaveBeenCalled();
  });
});

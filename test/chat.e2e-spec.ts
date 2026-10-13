import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

type ApiBody = {
  code: number;
  message: string;
  data: unknown;
  errors: string[] | null;
  timestamp: string;
  path: string;
};

describe('Chat API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('GET /chat/quota 无 JWT 时返回 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/chat/quota')
      .expect(401);
    const body = res.body as ApiBody;
    expect(body.code).toBe(401);
    expect(body.message).toBe('请先登录，或登录状态已失效');
  });

  it('GET /chat/conversations 无 JWT 时返回 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/chat/conversations')
      .expect(401);
    expect((res.body as ApiBody).code).toBe(401);
  });

  it('POST /chat/conversations/:id/messages/stream 无 JWT 时返回 401', async () => {
    const conversationId = 'bbbbbbbb-bbbb-4222-8222-bbbbbbbbbbbb';
    const res = await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages/stream`)
      .send({
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      })
      .expect(401);
    expect((res.body as ApiBody).code).toBe(401);
  });

  it('GET /bots 无 JWT 时返回 401', async () => {
    const res = await request(app.getHttpServer()).get('/bots').expect(401);
    expect((res.body as ApiBody).code).toBe(401);
  });

  it('注册后有主 Bot，可创建子 Bot 并拉空消息列表', async () => {
    const email = `chat-e2e-${randomUUID()}@example.com`;
    const password = 'password123';

    const register = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    const accessToken = (
      register.body as ApiBody & { data: { accessToken: string } }
    ).data.accessToken;

    const bots = await request(app.getHttpServer())
      .get('/bots')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const botsData = (bots.body as ApiBody).data as Array<{
      kind: string;
      conversationId: string;
    }>;
    expect(botsData.some((b) => b.kind === 'main')).toBe(true);

    const created = await request(app.getHttpServer())
      .post('/bots')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'e2e子Bot',
        faceColor: '#DB2777',
        faceShape: 'squircle',
      })
      .expect(201);
    const bot = (created.body as ApiBody).data as {
      conversationId: string;
      kind: string;
    };
    expect(bot.kind).toBe('sub');

    const messages = await request(app.getHttpServer())
      .get(`/chat/conversations/${bot.conversationId}/messages`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect((messages.body as ApiBody).data).toMatchObject({
      items: [],
      hasMore: false,
    });
  }, 60_000);
});

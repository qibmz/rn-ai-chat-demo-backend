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

  it('注册后可查询额度并创建会话', async () => {
    const email = `chat-e2e-${randomUUID()}@example.com`;
    const password = 'password123';

    const register = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    const accessToken = (
      register.body as ApiBody & { data: { accessToken: string } }
    ).data.accessToken;

    const quota = await request(app.getHttpServer())
      .get('/chat/quota')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const quotaBody = quota.body as ApiBody & {
      data: {
        usedPercent: number;
        remainingPercent: number;
        resetsAt: string;
        resetsInSeconds: number;
      };
    };
    expect(quotaBody.code).toBe(200);
    expect(quotaBody.data.usedPercent).toBeGreaterThanOrEqual(0);
    expect(quotaBody.data.remainingPercent).toBeGreaterThanOrEqual(0);
    expect(quotaBody.data.resetsAt).toBeDefined();
    expect(quotaBody.data.resetsInSeconds).toBeGreaterThan(0);

    const list = await request(app.getHttpServer())
      .get('/chat/conversations')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect((list.body as ApiBody).code).toBe(200);

    const created = await request(app.getHttpServer())
      .post('/chat/conversations')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'e2e' })
      .expect(201);
    expect((created.body as ApiBody).data).toMatchObject({ title: 'e2e' });
  }, 60_000);
});

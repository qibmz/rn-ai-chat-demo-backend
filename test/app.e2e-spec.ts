import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createHmac, randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { RedisService } from '../src/redis/redis.service.js';

type ApiBody = {
  code: number;
  message: string;
  data: unknown;
  errors: string[] | null;
  timestamp: string;
  path: string;
};

describe('HTTP API (e2e)', () => {
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

  it('POST /auth/register 参数非法时返回统一错误结构', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'not-an-email', password: 'short' })
      .expect(400);

    const body = res.body as ApiBody;
    expect(body.code).toBe(400);
    expect(body.message).toBeDefined();
    expect(body).toHaveProperty('errors');
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('path');
  });

  it('GET /auth/verify-email 缺少 token 时返回中文 HTML', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/verify-email')
      .expect(400);

    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('验证信息不完整');
  });

  it('GET /auth/me 无 JWT 时返回 401', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me').expect(401);
    const body = res.body as ApiBody;
    expect(body.code).toBe(401);
    expect(body.message).toBe('请先登录，或登录状态已失效');
  });

  it('注册 → 登录 → me → 刷新 → 退出', async () => {
    const email = `e2e-${randomUUID()}@example.com`;
    const password = 'password123';

    const register = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    const registerBody = register.body as ApiBody & {
      data: {
        accessToken: string;
        refreshToken: string;
        expiresIn: string;
      };
    };
    expect(registerBody.code).toBe(200);
    expect(registerBody.data.accessToken).toBeDefined();
    expect(registerBody.data.refreshToken).toBeDefined();

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: email.toUpperCase(), password })
      .expect(200);

    const loginBody = login.body as ApiBody & {
      data: { accessToken: string; refreshToken: string };
    };
    expect(loginBody.code).toBe(200);

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${loginBody.data.accessToken}`)
      .expect(200);

    const meBody = me.body as ApiBody & {
      data: { email: string; emailVerified: boolean };
    };
    expect(meBody.code).toBe(200);
    expect(meBody.data.email).toBe(email.toLowerCase());
    expect(meBody.data.emailVerified).toBe(false);

    const refresh = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: loginBody.data.refreshToken })
      .expect(200);

    const refreshBody = refresh.body as ApiBody & {
      data: { accessToken: string; refreshToken: string };
    };
    expect(refreshBody.code).toBe(200);
    expect(refreshBody.data.accessToken).toBeDefined();

    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken: refreshBody.data.refreshToken })
      .expect(200);
  }, 60_000);

  it('POST /auth/login 密码错误返回 401', async () => {
    const email = `e2e-bad-${randomUUID()}@example.com`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'wrong-password' })
      .expect(401);

    expect((res.body as ApiBody).message).toBe('邮箱或密码错误');
  }, 60_000);

  it('POST /auth/forgot-password 与 resend-verification 不暴露枚举信息', async () => {
    const email = `missing-${randomUUID()}@example.com`;

    const forgot = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(200);
    expect((forgot.body as ApiBody).code).toBe(200);
    expect((forgot.body as ApiBody).data).toEqual({ success: true });

    const resend = await request(app.getHttpServer())
      .post('/auth/resend-verification')
      .send({ email })
      .expect(200);
    expect((resend.body as ApiBody).data).toEqual({ success: true });
  });

  it('POST /auth/reset-password 可用 8 位验证码重置并登录', async () => {
    const email = `e2e-reset-${randomUUID()}@example.com`;
    const password = 'password123';
    const newPassword = 'newPassword123';

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(200);

    const code = '12345678';
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) {
      throw new Error('JWT_ACCESS_SECRET required for e2e reset test');
    }
    const redis = app.get(RedisService);
    await redis.set(
      `auth:password-reset:${email.toLowerCase()}`,
      createHmac('sha256', secret).update(code).digest('hex'),
      900,
    );

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ email, code, newPassword })
      .expect(200);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: newPassword })
      .expect(200);
    expect((login.body as ApiBody).code).toBe(200);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(401);
  }, 60_000);

  it('POST /auth/refresh 重用检测会吊销全部会话', async () => {
    const email = `e2e-reuse-${randomUUID()}@example.com`;
    const password = 'password123';

    const register = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    const oldRefresh = (
      register.body as ApiBody & { data: { refreshToken: string } }
    ).data.refreshToken;

    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: oldRefresh })
      .expect(200);
    const newRefresh = (
      rotated.body as ApiBody & { data: { refreshToken: string } }
    ).data.refreshToken;

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: oldRefresh })
      .expect(401);

    // Reuse detection must revoke the newly issued session too
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: newRefresh })
      .expect(401);
  }, 60_000);

  it('GET /auth/verify-email 无效 token 返回中文 HTML', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/verify-email')
      .query({ token: 'a'.repeat(64) })
      .expect(400);

    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('验证链接无效或已过期');
  });

  it('GET /health 返回 Terminus 状态', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toHaveProperty('status');
  });
});

import {
  INestApplication,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor.js';
import { ChatConversationsController } from './chat-conversations.controller.js';
import { ChatConversationsService } from './chat-conversations.service.js';
import { ChatMessagesService } from './chat-messages.service.js';
import { ChatStreamService } from './chat-stream.service.js';

describe('ChatConversationsController (HTTP)', () => {
  let app: INestApplication;
  let conversationsService: {
    list: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  let messagesService: { list: ReturnType<typeof vi.fn> };
  let streamService: { stream: ReturnType<typeof vi.fn> };
  let authUser: { userId: string; email: string } | null;

  const conversationId = 'bbbbbbbb-bbbb-4222-8222-bbbbbbbbbbbb';
  const botId = 'aaaaaaaa-aaaa-4111-8111-aaaaaaaaaaaa';
  const conversation = {
    id: conversationId,
    botId,
    title: '新对话',
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };

  beforeEach(async () => {
    authUser = {
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'u@example.com',
    };
    conversationsService = {
      list: vi.fn().mockResolvedValue([conversation]),
      getById: vi.fn().mockResolvedValue(conversation),
      update: vi.fn().mockResolvedValue(conversation),
    };
    messagesService = {
      list: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    };
    streamService = {
      stream: vi.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatConversationsController],
      providers: [
        { provide: ChatConversationsService, useValue: conversationsService },
        { provide: ChatMessagesService, useValue: messagesService },
        { provide: ChatStreamService, useValue: streamService },
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

  it('GET /chat/conversations lists conversations', async () => {
    const res = await request(app.getHttpServer())
      .get('/chat/conversations')
      .expect(200);
    expect(res.body.data).toEqual([conversation]);
    expect(conversationsService.list).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      undefined,
    );
  });

  it('GET /chat/conversations?botId= filters by bot', async () => {
    await request(app.getHttpServer())
      .get('/chat/conversations')
      .query({ botId })
      .expect(200);
    expect(conversationsService.list).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      botId,
    );
  });

  it('GET /chat/conversations/:id returns 404 cross-user', async () => {
    conversationsService.getById.mockRejectedValue(
      new NotFoundException('对话不存在'),
    );
    const res = await request(app.getHttpServer())
      .get(`/chat/conversations/${conversationId}`)
      .expect(404);
    expect(res.body.message).toBe('对话不存在');
  });

  it('GET /chat/conversations/:id/messages returns paginated messages', async () => {
    const res = await request(app.getHttpServer())
      .get(`/chat/conversations/${conversationId}/messages`)
      .expect(200);
    expect(res.body.data).toEqual({ items: [], hasMore: false });
    expect(messagesService.list).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      conversationId,
      expect.objectContaining({ limit: 50 }),
    );
  });

  it('GET /chat/conversations/:id returns 401 without auth', async () => {
    authUser = null;
    await request(app.getHttpServer())
      .get(`/chat/conversations/${conversationId}`)
      .expect(401);
  });

  it('POST /chat/conversations/:id/messages/stream returns 401 without auth', async () => {
    authUser = null;
    await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages/stream`)
      .send({
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      })
      .expect(401);
    expect(streamService.stream).not.toHaveBeenCalled();
  });

  it('POST /chat/conversations/:id/messages/stream returns 404 when conversation missing', async () => {
    streamService.stream.mockRejectedValue(new NotFoundException('对话不存在'));
    const res = await request(app.getHttpServer())
      .post(`/chat/conversations/${conversationId}/messages/stream`)
      .send({
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      })
      .expect(404);
    expect(res.body.message).toBe('对话不存在');
  });
});

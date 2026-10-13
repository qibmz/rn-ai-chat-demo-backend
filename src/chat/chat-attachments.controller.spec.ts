import {
  INestApplication,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor.js';
import { ChatAttachmentsController } from './chat-attachments.controller.js';
import { ChatAttachmentsService } from './chat-attachments.service.js';
import { ChatFileUploadInterceptor } from './chat-file-upload.interceptor.js';

describe('ChatAttachmentsController (HTTP)', () => {
  let app: INestApplication;
  let attachmentsService: {
    upload: ReturnType<typeof vi.fn>;
    presignForUser: ReturnType<typeof vi.fn>;
  };
  let authUser: { userId: string; email: string } | null;

  const attachmentId = 'aaaaaaaa-aaaa-4111-8111-aaaaaaaaaaaa';

  beforeEach(async () => {
    authUser = {
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'u@example.com',
    };
    attachmentsService = {
      upload: vi.fn().mockResolvedValue({
        id: attachmentId,
        mimeType: 'image/png',
        byteSize: 4,
      }),
      presignForUser: vi.fn().mockResolvedValue({
        id: attachmentId,
        url: 'https://example.com/signed',
        expiresAt: '2026-10-10T13:00:00.000Z',
        mimeType: 'image/png',
        byteSize: 4,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatAttachmentsController],
      providers: [
        { provide: ChatAttachmentsService, useValue: attachmentsService },
        {
          provide: ConfigService,
          useValue: { get: vi.fn((_k: string, fb?: string) => fb) },
        },
        ChatFileUploadInterceptor,
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

  it('GET /chat/attachments/:id presigns', async () => {
    const res = await request(app.getHttpServer())
      .get(`/chat/attachments/${attachmentId}`)
      .expect(200);

    expect(res.body.code).toBe(200);
    expect(res.body.data.url).toBe('https://example.com/signed');
    expect(attachmentsService.presignForUser).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      attachmentId,
    );
  });

  it('GET /chat/attachments/:id returns 404 cross-user', async () => {
    attachmentsService.presignForUser.mockRejectedValue(
      new NotFoundException('附件不存在'),
    );
    const res = await request(app.getHttpServer())
      .get(`/chat/attachments/${attachmentId}`)
      .expect(404);
    expect(res.body.message).toBe('附件不存在');
  });

  it('GET /chat/attachments/:id returns 401 without auth', async () => {
    authUser = null;
    await request(app.getHttpServer())
      .get(`/chat/attachments/${attachmentId}`)
      .expect(401);
  });
});

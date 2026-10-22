import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChatAttachmentsService } from './chat-attachments.service.js';
import { ChatMessagesService } from './chat-messages.service.js';

describe('ChatMessagesService', () => {
  let service: ChatMessagesService;
  let prisma: {
    conversation: { findFirst: ReturnType<typeof vi.fn> };
    message: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };
  let attachments: { presignMany: ReturnType<typeof vi.fn> };

  const userId = '11111111-1111-4111-8111-111111111111';
  const conversationId = 'bbbbbbbb-bbbb-4222-8222-bbbbbbbbbbbb';

  beforeEach(async () => {
    prisma = {
      conversation: { findFirst: vi.fn() },
      message: { findFirst: vi.fn(), findMany: vi.fn() },
    };
    attachments = {
      presignMany: vi.fn().mockResolvedValue(new Map()),
    };

    const module = await Test.createTestingModule({
      providers: [
        ChatMessagesService,
        { provide: PrismaService, useValue: prisma },
        { provide: ChatAttachmentsService, useValue: attachments },
      ],
    }).compile();

    service = module.get(ChatMessagesService);
    prisma.conversation.findFirst.mockResolvedValue({
      id: conversationId,
      userId,
    });
  });

  it('returns sources on assistant; omits cost/count fields', async () => {
    const createdAt = new Date('2026-01-02T12:00:00.000Z');
    prisma.message.findMany.mockResolvedValue([
      {
        id: 'msg-assistant',
        role: 'assistant',
        content: 'answer',
        parts: [],
        sources: [{ title: 't', url: 'https://a.com', snippet: 's' }],
        webSearchCount: 2,
        webFetchCount: 1,
        webToolsCostMicros: 5000n,
        costMicros: 999n,
        createdAt,
      },
    ]);

    const page = await service.list(userId, conversationId, {});

    expect(page.items[0].sources).toEqual([
      { title: 't', url: 'https://a.com', snippet: 's' },
    ]);
    expect(page.items[0]).not.toHaveProperty('webSearchCount');
    expect(page.items[0]).not.toHaveProperty('webToolsCostMicros');
    expect(page.items[0]).not.toHaveProperty('costMicros');
  });

  it('user messages expose sources as null', async () => {
    prisma.message.findMany.mockResolvedValue([
      {
        id: 'msg-user',
        role: 'user',
        content: 'hi',
        parts: [],
        sources: null,
        webSearchCount: 0,
        webFetchCount: 0,
        webToolsCostMicros: 0n,
        costMicros: null,
        createdAt: new Date('2026-01-02T12:00:00.000Z'),
      },
      {
        id: 'msg-assistant',
        role: 'assistant',
        content: 'hello',
        parts: [],
        sources: [{ title: 't', url: 'https://a.com', snippet: 's' }],
        webSearchCount: 1,
        webFetchCount: 0,
        webToolsCostMicros: 1000n,
        costMicros: 100n,
        createdAt: new Date('2026-01-02T12:01:00.000Z'),
      },
    ]);

    const page = await service.list(userId, conversationId, {});

    expect(page.items.find((m) => m.role === 'user')?.sources).toBeNull();
  });
});

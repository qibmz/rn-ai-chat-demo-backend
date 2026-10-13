// src/chat/bots.service.spec.ts
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotFaceShape, BotKind, Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { BotsService } from './bots.service.js';

describe('BotsService', () => {
  let service: BotsService;
  let prisma: {
    bot: {
      findFirst: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    conversation: {
      findMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
  };

  const userId = '11111111-1111-4111-8111-111111111111';
  const botId = 'aaaaaaaa-aaaa-4111-8111-aaaaaaaaaaaa';
  const conversationId = 'bbbbbbbb-bbbb-4222-8222-bbbbbbbbbbbb';

  beforeEach(async () => {
    prisma = {
      bot: {
        findFirst: vi.fn(),
        findFirstOrThrow: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      conversation: {
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
      $queryRaw: vi.fn().mockResolvedValue([]),
    };

    const module = await Test.createTestingModule({
      providers: [
        BotsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((k: string, fb?: string) =>
              k === 'APP_NAME' ? '牛马' : fb,
            ),
          },
        },
      ],
    }).compile();

    service = module.get(BotsService);
  });

  it('createSub creates bot + conversation in one transaction', async () => {
    const botRow = {
      id: botId,
      userId,
      name: '日程助手',
      kind: BotKind.sub,
      faceColor: '#DB2777',
      faceShape: BotFaceShape.squircle,
      systemPrompt: null,
      deletedAt: null,
      createdAt: new Date('2026-10-13T00:00:00.000Z'),
      updatedAt: new Date('2026-10-13T00:00:00.000Z'),
    };
    prisma.bot.findFirst.mockResolvedValue({
      id: 'cccccccc-cccc-4111-8111-cccccccccccc',
      userId,
      kind: BotKind.main,
      name: '牛马',
      faceColor: '#0A0A0A',
      faceShape: BotFaceShape.circle,
      systemPrompt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      conversation: { id: 'dddddddd-dddd-4111-8111-dddddddddddd' },
    });
    prisma.bot.create.mockResolvedValue(botRow);
    prisma.conversation.create.mockResolvedValue({
      id: conversationId,
      botId,
    });
    prisma.bot.findFirstOrThrow.mockResolvedValue({
      ...botRow,
      conversation: { id: conversationId },
    });

    const dto = await service.createSub(userId, {
      name: '日程助手',
      faceColor: '#DB2777',
      faceShape: 'squircle',
    });

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(dto).toMatchObject({
      id: botId,
      kind: 'sub',
      conversationId,
      lastMessagePreview: null,
      lastMessageAt: null,
    });
  });

  it('soft-delete sub also soft-deletes its conversation', async () => {
    prisma.bot.findFirst.mockResolvedValue({
      id: botId,
      userId,
      kind: BotKind.sub,
      name: 'x',
      faceColor: '#DB2777',
      faceShape: BotFaceShape.circle,
      systemPrompt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      conversation: { id: conversationId },
    });
    prisma.bot.update.mockResolvedValue({
      id: botId,
      userId,
      kind: BotKind.sub,
      name: 'x',
      faceColor: '#DB2777',
      faceShape: BotFaceShape.circle,
      systemPrompt: null,
      deletedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.conversation.update.mockResolvedValue({});

    await service.update(userId, botId, { deleted: true });

    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: conversationId },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it('rejects soft-delete of main bot', async () => {
    prisma.bot.findFirst.mockResolvedValue({
      id: botId,
      userId,
      kind: BotKind.main,
      name: '牛马',
      faceColor: '#0A0A0A',
      faceShape: BotFaceShape.circle,
      systemPrompt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      conversation: { id: conversationId },
    });

    await expect(
      service.update(userId, botId, { deleted: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ensureMainBot is idempotent on P2002', async () => {
    prisma.bot.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: botId,
      userId,
      kind: BotKind.main,
      name: '牛马',
      faceColor: '#0A0A0A',
      faceShape: BotFaceShape.circle,
      systemPrompt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      conversation: { id: conversationId },
    });
    prisma.bot.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    const main = await service.ensureMainBot(userId);
    expect(main.id).toBe(botId);
  });

  it('list attaches lastMessagePreview from one raw query', async () => {
    prisma.bot.findFirst.mockResolvedValue({
      id: botId,
      kind: BotKind.main,
      conversation: { id: conversationId },
    });
    prisma.bot.findMany.mockResolvedValue([
      {
        id: botId,
        userId,
        name: '牛马',
        kind: BotKind.main,
        faceColor: '#0A0A0A',
        faceShape: BotFaceShape.circle,
        systemPrompt: null,
        deletedAt: null,
        createdAt: new Date('2026-10-13T00:00:00.000Z'),
        updatedAt: new Date('2026-10-13T00:00:00.000Z'),
        conversation: { id: conversationId },
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([
      {
        conversation_id: conversationId,
        content: '你好世界',
        parts: [],
        created_at: new Date('2026-10-13T01:00:00.000Z'),
      },
    ]);

    const list = await service.list(userId);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(list[0]).toMatchObject({
      lastMessagePreview: '你好世界',
      conversationId,
    });
  });

  it('getById throws 404 when missing', async () => {
    prisma.bot.findFirst.mockResolvedValue(null);
    await expect(service.getById(userId, botId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

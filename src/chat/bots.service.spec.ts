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
    expect(prisma.bot.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: botId },
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
    ).rejects.toThrow(new BadRequestException('主 Bot 不可删除'));
  });

  it('ensureMainBot is idempotent on P2002', async () => {
    const existingMain = {
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
    };
    prisma.bot.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingMain);
    prisma.bot.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    const main = await service.ensureMainBot(userId);
    expect(prisma.bot.create).toHaveBeenCalled();
    expect(main.id).toBe(botId);
    expect(main.conversation?.id).toBe(conversationId);
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

  it('list preview uses [图片] when content empty and parts have image', async () => {
    const subId = 'cccccccc-cccc-4111-8111-cccccccccccc';
    const subConvId = 'dddddddd-dddd-4111-8111-dddddddddddd';
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
      {
        id: subId,
        userId,
        name: '子',
        kind: BotKind.sub,
        faceColor: '#DB2777',
        faceShape: BotFaceShape.circle,
        systemPrompt: null,
        deletedAt: null,
        createdAt: new Date('2026-10-13T00:00:00.000Z'),
        updatedAt: new Date('2026-10-13T00:00:00.000Z'),
        conversation: { id: subConvId },
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([
      {
        conversation_id: subConvId,
        content: '   ',
        parts: [{ type: 'image', url: 'https://example.com/x.png' }],
        created_at: new Date('2026-10-13T02:00:00.000Z'),
      },
    ]);

    const list = await service.list(userId);
    const sub = list.find((b) => b.id === subId);
    expect(sub).toMatchObject({
      lastMessagePreview: '[图片]',
      lastMessageAt: '2026-10-13T02:00:00.000Z',
    });
  });

  it('list preview truncates long text to 80 characters', async () => {
    const longText = 'a'.repeat(100);
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
        content: longText,
        parts: [],
        created_at: new Date('2026-10-13T01:00:00.000Z'),
      },
    ]);

    const list = await service.list(userId);
    expect(list[0].lastMessagePreview).toBe('a'.repeat(80));
    expect(list[0].lastMessageAt).toBe('2026-10-13T01:00:00.000Z');
  });

  it('list preview truncates by code point without splitting emoji', async () => {
    const longEmoji = '😂'.repeat(100);
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
        content: longEmoji,
        parts: [],
        created_at: new Date('2026-10-13T01:00:00.000Z'),
      },
    ]);

    const list = await service.list(userId);
    const preview = list[0]!.lastMessagePreview!;
    expect(preview).toBe('😂'.repeat(80));
    expect(Array.from(preview)).toHaveLength(80);
  });

  it('list orders main first then subs by updatedAt desc', async () => {
    const subOldId = 'cccccccc-cccc-4111-8111-cccccccccccc';
    const subNewId = 'dddddddd-dddd-4111-8111-dddddddddddd';
    const subOldConv = 'eeeeeeee-eeee-4111-8111-eeeeeeeeeeee';
    const subNewConv = 'ffffffff-ffff-4111-8111-ffffffffffff';
    prisma.bot.findFirst.mockResolvedValue({
      id: botId,
      kind: BotKind.main,
      conversation: { id: conversationId },
    });
    prisma.bot.findMany.mockResolvedValue([
      {
        id: subNewId,
        userId,
        name: '新子',
        kind: BotKind.sub,
        faceColor: '#DB2777',
        faceShape: BotFaceShape.circle,
        systemPrompt: null,
        deletedAt: null,
        createdAt: new Date('2026-10-10T00:00:00.000Z'),
        updatedAt: new Date('2026-10-13T12:00:00.000Z'),
        conversation: { id: subNewConv },
      },
      {
        id: botId,
        userId,
        name: '牛马',
        kind: BotKind.main,
        faceColor: '#0A0A0A',
        faceShape: BotFaceShape.circle,
        systemPrompt: null,
        deletedAt: null,
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
        conversation: { id: conversationId },
      },
      {
        id: subOldId,
        userId,
        name: '旧子',
        kind: BotKind.sub,
        faceColor: '#DB2777',
        faceShape: BotFaceShape.circle,
        systemPrompt: null,
        deletedAt: null,
        createdAt: new Date('2026-10-10T00:00:00.000Z'),
        updatedAt: new Date('2026-10-12T00:00:00.000Z'),
        conversation: { id: subOldConv },
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([]);

    const list = await service.list(userId);
    expect(list.map((b) => b.id)).toEqual([botId, subNewId, subOldId]);
  });

  it('getById throws 404 when missing', async () => {
    prisma.bot.findFirst.mockResolvedValue(null);
    await expect(service.getById(userId, botId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

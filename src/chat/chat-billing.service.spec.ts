import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { ChatBillingService } from './chat-billing.service.js';

describe('ChatBillingService', () => {
  let service: ChatBillingService;
  let redis: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    incrby: ReturnType<typeof vi.fn>;
  };
  let prisma: {
    chatWeeklySpend: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      incrby: vi.fn().mockResolvedValue(1),
    };
    prisma = {
      chatWeeklySpend: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatBillingService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string, fb?: string) => {
              if (key === 'CHAT_USER_WEEKLY_BUDGET_CNY') {
                return '10';
              }
              return fb;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(ChatBillingService);
  });

  it('reads weekly spend from Redis when present', async () => {
    redis.get.mockResolvedValue('3500000');
    await expect(service.getWeeklySpendMicros('user-1')).resolves.toBe(
      3_500_000n,
    );
    expect(prisma.chatWeeklySpend.findUnique).not.toHaveBeenCalled();
  });

  it('rebuilds Redis from ChatWeeklySpend on cache miss', async () => {
    redis.get.mockResolvedValue(null);
    prisma.chatWeeklySpend.findUnique.mockResolvedValue({
      spendMicros: 7_500_000n,
    });

    await expect(service.getWeeklySpendMicros('user-1')).resolves.toBe(
      7_500_000n,
    );
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^chat:spend:user-1:/),
      '7500000',
      expect.any(Number),
    );
  });

  it('treats missing DB row as zero spend and warms Redis', async () => {
    redis.get.mockResolvedValue(null);
    prisma.chatWeeklySpend.findUnique.mockResolvedValue(null);

    await expect(service.getWeeklySpendMicros('user-1')).resolves.toBe(0n);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^chat:spend:user-1:/),
      '0',
      expect.any(Number),
    );
  });

  it('increments weekly spend ledger via upsert', async () => {
    const tx = {
      chatWeeklySpend: { upsert: vi.fn().mockResolvedValue({}) },
    };
    await service.incrementWeeklySpend(tx as never, 'user-1', 123n, '2026-W41');
    expect(tx.chatWeeklySpend.upsert).toHaveBeenCalledWith({
      where: { userId_period: { userId: 'user-1', period: '2026-W41' } },
      create: {
        userId: 'user-1',
        period: '2026-W41',
        spendMicros: 123n,
      },
      update: {
        spendMicros: { increment: 123n },
      },
    });
  });

  it('skips ledger and redis when cost is zero', async () => {
    const tx = {
      chatWeeklySpend: { upsert: vi.fn() },
    };
    await service.incrementWeeklySpend(tx as never, 'user-1', 0n);
    await service.recordSpend('user-1', 0n);
    expect(tx.chatWeeklySpend.upsert).not.toHaveBeenCalled();
    expect(redis.incrby).not.toHaveBeenCalled();
  });
});

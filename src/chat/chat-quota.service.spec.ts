import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from '../redis/redis.service.js';
import { ChatQuotaService } from './chat-quota.service.js';

describe('ChatQuotaService', () => {
  let service: ChatQuotaService;
  let redis: { get: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    redis = { get: vi.fn().mockResolvedValue('5000000') };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatQuotaService,
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

    service = module.get(ChatQuotaService);
  });

  it('returns quota percentages without money fields', async () => {
    const result = await service.getQuota('user-1');
    expect(result).toMatchObject({
      usedPercent: expect.any(Number),
      remainingPercent: expect.any(Number),
      usedRatio: expect.any(Number),
      period: expect.stringMatching(/^\d{4}-W\d{2}$/),
      resetsInSeconds: expect.any(Number),
    });
    expect(result).not.toHaveProperty('budgetCny');
    expect(redis.get).toHaveBeenCalledWith(
      expect.stringMatching(/^chat:spend:user-1:/),
    );
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ChatBillingService } from './chat-billing.service.js';
import { ChatQuotaService } from './chat-quota.service.js';

describe('ChatQuotaService', () => {
  let service: ChatQuotaService;
  let billing: {
    getWeeklySpendMicros: ReturnType<typeof vi.fn>;
    getWeeklyBudgetMicros: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    billing = {
      getWeeklySpendMicros: vi.fn().mockResolvedValue(5_000_000n),
      getWeeklyBudgetMicros: vi.fn().mockReturnValue(10_000_000n),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatQuotaService,
        { provide: ChatBillingService, useValue: billing },
      ],
    }).compile();

    service = module.get(ChatQuotaService);
  });

  it('returns quota percentages without money fields', async () => {
    const result = await service.getQuota('user-1');
    expect(result).toMatchObject({
      usedPercent: 50,
      remainingPercent: 50,
      usedRatio: 0.5,
      period: expect.stringMatching(/^\d{4}-W\d{2}$/),
      resetsInSeconds: expect.any(Number),
    });
    expect(result).not.toHaveProperty('budgetCny');
    expect(billing.getWeeklySpendMicros).toHaveBeenCalledWith('user-1');
  });
});

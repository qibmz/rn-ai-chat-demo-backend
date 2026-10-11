import { Injectable } from '@nestjs/common';
import { ChatBillingService } from './chat-billing.service.js';
import { getShanghaiWeekInfo, roundRatio4 } from './utils/week-quota.util.js';

export type ChatQuotaDto = {
  usedPercent: number;
  remainingPercent: number;
  usedRatio: number;
  period: string;
  resetsAt: string;
  resetsInSeconds: number;
};

@Injectable()
export class ChatQuotaService {
  constructor(private readonly billing: ChatBillingService) {}

  async getQuota(userId: string): Promise<ChatQuotaDto> {
    const week = getShanghaiWeekInfo();
    const spendMicros = await this.billing.getWeeklySpendMicros(userId);
    const budgetMicros = this.billing.getWeeklyBudgetMicros();

    let usedRatio = 0;
    if (budgetMicros > 0n) {
      usedRatio = Number(spendMicros) / Number(budgetMicros);
    }

    usedRatio = roundRatio4(usedRatio);
    const usedPercent = roundRatio4(usedRatio * 100);
    const remainingPercent = roundRatio4(Math.max(0, 100 - usedPercent));

    return {
      usedPercent,
      remainingPercent,
      usedRatio,
      period: week.period,
      resetsAt: week.resetsAt.toISOString(),
      resetsInSeconds: week.resetsInSeconds,
    };
  }
}

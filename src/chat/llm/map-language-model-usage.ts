import type { LanguageModelUsage } from 'ai';
import type { ChatUsageForBilling } from '../utils/chat-billing.util.js';

export type MappedLlmUsage = ChatUsageForBilling & {
  promptTokens: number;
  totalTokens: number;
};

export function mapLanguageModelUsage(
  usage: LanguageModelUsage | null | undefined,
): MappedLlmUsage {
  if (!usage) {
    return {
      promptTokens: 0,
      totalTokens: 0,
      promptCacheMissTokens: 0,
      promptCacheHitTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
    };
  }
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? 0;
  const textTokens = usage.outputTokenDetails?.textTokens;
  const outputTokens = usage.outputTokens ?? 0;
  let completionTokens =
    typeof textTokens === 'number'
      ? textTokens
      : Math.max(0, outputTokens - (reasoningTokens || 0));
  if (
    typeof textTokens !== 'number' &&
    !(reasoningTokens > 0) &&
    outputTokens > 0
  ) {
    completionTokens = outputTokens;
  }
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const noCache = usage.inputTokenDetails?.noCacheTokens;
  const inputTokens = usage.inputTokens ?? 0;
  return {
    promptTokens: inputTokens,
    totalTokens: usage.totalTokens ?? 0,
    promptCacheHitTokens: cacheRead,
    promptCacheMissTokens:
      typeof noCache === 'number'
        ? noCache
        : Math.max(0, inputTokens - cacheRead),
    completionTokens,
    reasoningTokens,
  };
}

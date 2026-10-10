import { computeCostMicros } from './chat-billing.util.js';

describe('computeCostMicros', () => {
  const prices = {
    inputMiss: 1_065_000n,
    inputHit: 21_600n,
    output: 4_320_000n,
  };

  it('uses completion tokens only and ignores reasoning tokens', () => {
    const withReasoning = computeCostMicros(
      {
        promptCacheMissTokens: 0,
        promptCacheHitTokens: 0,
        completionTokens: 200,
        reasoningTokens: 180,
      },
      prices,
    );
    const completionOnly = computeCostMicros(
      {
        promptCacheMissTokens: 0,
        promptCacheHitTokens: 0,
        completionTokens: 200,
        reasoningTokens: 0,
      },
      prices,
    );

    expect(withReasoning).toBe(completionOnly);
    // 200 * 4_320_000 / 1_000_000 = 864
    expect(withReasoning).toBe(864n);
  });

  it('bills cache miss / hit / completion with BigInt formula', () => {
    const cost = computeCostMicros(
      {
        promptCacheMissTokens: 1_000_000,
        promptCacheHitTokens: 1_000_000,
        completionTokens: 1_000_000,
      },
      prices,
    );
    expect(cost).toBe(prices.inputMiss + prices.inputHit + prices.output);
  });
});

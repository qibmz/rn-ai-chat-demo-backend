import { mapLanguageModelUsage } from './map-language-model-usage.js';

describe('mapLanguageModelUsage', () => {
  it('maps cache + subtracts reasoning from completion when needed', () => {
    const mapped = mapLanguageModelUsage({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      inputTokenDetails: { cacheReadTokens: 4, noCacheTokens: 6 },
      outputTokenDetails: { reasoningTokens: 8, textTokens: 12 },
    } as never);
    expect(mapped).toMatchObject({
      promptTokens: 10,
      totalTokens: 30,
      promptCacheHitTokens: 4,
      promptCacheMissTokens: 6,
      completionTokens: 12,
      reasoningTokens: 8,
    });
  });

  it('returns zeros for null usage', () => {
    expect(mapLanguageModelUsage(null)).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('derives completionTokens from output minus reasoning when textTokens absent', () => {
    expect(
      mapLanguageModelUsage({
        inputTokens: 1,
        outputTokens: 20,
        outputTokenDetails: { reasoningTokens: 8 },
      } as never),
    ).toMatchObject({
      completionTokens: 12,
      reasoningTokens: 8,
    });
  });

  it('derives promptCacheMissTokens from input minus cache read when noCache absent', () => {
    expect(
      mapLanguageModelUsage({
        inputTokens: 10,
        inputTokenDetails: { cacheReadTokens: 4 },
      } as never),
    ).toMatchObject({
      promptCacheHitTokens: 4,
      promptCacheMissTokens: 6,
    });
  });

  it('returns zeros for undefined usage', () => {
    expect(mapLanguageModelUsage(undefined)).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
    });
  });
});

/** Token usage fields used for chat cost (micros of CNY). */
export type ChatUsageForBilling = {
  /** Uncached / cache-miss prompt tokens. */
  promptCacheMissTokens: number;
  /** Cache-hit prompt tokens. */
  promptCacheHitTokens: number;
  /**
   * Completion (final answer) tokens only.
   * Must NOT include reasoning/thinking tokens.
   */
  completionTokens: number;
  /** Stored separately; ignored by cost formula (Task 5 may revisit). */
  reasoningTokens?: number;
};

export type ChatPriceMicrosPerMTokens = {
  inputMiss: bigint;
  inputHit: bigint;
  output: bigint;
};

const MTOKENS = 1_000_000n;

/**
 * Cost in 微元 (CNY × 1e6), integer division.
 * output 仅用 completionTokens，不计 reasoningTokens。
 */
export function computeCostMicros(
  usage: ChatUsageForBilling,
  prices: ChatPriceMicrosPerMTokens,
): bigint {
  const miss = BigInt(Math.max(0, usage.promptCacheMissTokens));
  const hit = BigInt(Math.max(0, usage.promptCacheHitTokens));
  const completion = BigInt(Math.max(0, usage.completionTokens));

  return (
    (miss * prices.inputMiss +
      hit * prices.inputHit +
      completion * prices.output) /
    MTOKENS
  );
}

export type WebToolPriceMicros = {
  search: bigint;
  fetch: bigint;
};

/** Per-call web tool cost in 微元 (CNY × 1e6). */
export function computeWebToolsCostMicros(
  searchCount: number,
  fetchCount: number,
  prices: WebToolPriceMicros,
): bigint {
  return (
    BigInt(Math.max(0, searchCount)) * prices.search +
    BigInt(Math.max(0, fetchCount)) * prices.fetch
  );
}

export function streamLockRedisKey(userId: string): string {
  return `chat:streams:${userId}`;
}

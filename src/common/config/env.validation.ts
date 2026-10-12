const DURATION = /^\d+[smhd]$/;

/** Secrets shipped in .env.example — must never be accepted at runtime. */
const PLACEHOLDER_SECRETS = new Set([
  'change-me-access-secret-min-32-chars!!',
  'change-me-refresh-secret-min-32-chars!',
]);

const PLACEHOLDER_API_KEYS = new Set([
  '',
  'change-me',
  'your-api-key',
  'sk-xxx',
  're_xxx',
]);

/** 本迭代仅 deepseek；后续扩展时加白名单，不做运行时别名。 */
const LLM_PROVIDERS = ['deepseek'] as const;

function requireString(
  env: Record<string, unknown>,
  key: string,
  minLength = 1,
): string {
  const value = env[key];
  if (typeof value !== 'string' || value.trim().length < minLength) {
    throw new Error(`环境变量 ${key} 缺失或无效（至少 ${minLength} 个字符）`);
  }
  return value.trim();
}

function requireJwtSecret(env: Record<string, unknown>, key: string): string {
  const value = requireString(env, key, 32);
  if (PLACEHOLDER_SECRETS.has(value)) {
    throw new Error(
      `环境变量 ${key} 不能使用仓库占位密钥，请替换为随机强密钥（至少 32 字符）`,
    );
  }
  // Reject low-entropy all-same / obviously weak secrets
  if (new Set(value).size < 8) {
    throw new Error(`环境变量 ${key} 熵过低，请使用更随机的密钥`);
  }
  return value;
}

function requireApiKey(env: Record<string, unknown>, key: string): string {
  const value = requireString(env, key, 8);
  const lower = value.toLowerCase();
  if (
    PLACEHOLDER_API_KEYS.has(lower) ||
    lower.startsWith('change-me') ||
    lower === 'xxxxxxxx'
  ) {
    throw new Error(`环境变量 ${key} 不能使用占位值，请配置真实密钥`);
  }
  return value;
}

function optionalDuration(env: Record<string, unknown>, key: string): void {
  const value = env[key];
  if (value === undefined || value === '') {
    return;
  }
  if (typeof value !== 'string' || !DURATION.test(value.trim())) {
    throw new Error(
      `环境变量 ${key} 格式无效，应为数字 + s|m|h|d（例如 15m、7d）`,
    );
  }
}

function optionalPositiveInt(env: Record<string, unknown>, key: string): void {
  const value = env[key];
  if (value === undefined || value === '') {
    return;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`环境变量 ${key} 必须为正整数`);
  }
}

function optionalNonNegativeInt(
  env: Record<string, unknown>,
  key: string,
): void {
  const value = env[key];
  if (value === undefined || value === '') {
    return;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`环境变量 ${key} 必须为非负整数`);
  }
}

function optionalEnum(
  env: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): void {
  const value = env[key];
  if (value === undefined || value === '') {
    return;
  }
  if (typeof value !== 'string' || !allowed.includes(value.trim())) {
    throw new Error(`环境变量 ${key} 无效，允许值：${allowed.join(' | ')}`);
  }
}

/**
 * Fail-fast env validation for ConfigModule.forRoot({ validate }).
 */
export function validateEnv(env: Record<string, unknown>) {
  requireString(env, 'DATABASE_URL', 8);
  requireJwtSecret(env, 'JWT_ACCESS_SECRET');
  requireJwtSecret(env, 'JWT_REFRESH_SECRET');
  requireApiKey(env, 'LLM_API_KEY');

  optionalDuration(env, 'JWT_ACCESS_EXPIRES_IN');
  optionalDuration(env, 'JWT_REFRESH_EXPIRES_IN');
  optionalDuration(env, 'EMAIL_VERIFY_EXPIRES_IN');
  optionalDuration(env, 'PASSWORD_RESET_EXPIRES_IN');
  optionalDuration(env, 'PASSWORD_RESET_COOLDOWN');
  optionalDuration(env, 'EMAIL_VERIFY_COOLDOWN');

  optionalPositiveInt(env, 'PORT');
  optionalPositiveInt(env, 'THROTTLE_TTL_MS');
  optionalPositiveInt(env, 'THROTTLE_LIMIT');

  optionalPositiveInt(env, 'CHAT_MAX_TOKENS');
  optionalPositiveInt(env, 'CHAT_MAX_USER_CHARS');
  optionalPositiveInt(env, 'CHAT_MAX_IMAGE_BYTES');
  optionalPositiveInt(env, 'CHAT_MAX_IMAGES_PER_MESSAGE');
  optionalPositiveInt(env, 'CHAT_MAX_TOTAL_IMAGE_BYTES');
  optionalPositiveInt(env, 'CHAT_CONTEXT_MAX_TURNS');
  optionalPositiveInt(env, 'CHAT_CONTEXT_MAX_CHARS');
  optionalPositiveInt(env, 'CHAT_CONTEXT_IMAGE_TURNS');
  optionalPositiveInt(env, 'CHAT_MAX_CONCURRENT_STREAMS');
  optionalPositiveInt(env, 'CHAT_STREAM_LOCK_TTL_SEC');
  optionalPositiveInt(env, 'R2_PRESIGN_EXPIRES_SEC');
  optionalNonNegativeInt(env, 'CHAT_USER_WEEKLY_BUDGET_CNY');
  optionalNonNegativeInt(env, 'CHAT_PRICE_INPUT_MISS_MICROS_PER_MTOKENS');
  optionalNonNegativeInt(env, 'CHAT_PRICE_INPUT_HIT_MICROS_PER_MTOKENS');
  optionalNonNegativeInt(env, 'CHAT_PRICE_OUTPUT_MICROS_PER_MTOKENS');

  optionalEnum(env, 'LLM_PROVIDER', LLM_PROVIDERS);
  optionalEnum(env, 'CHAT_ATTACHMENT_STORAGE', ['r2', 'disabled'] as const);
  optionalEnum(env, 'CHAT_IMAGE_DETAIL', [
    'low',
    'high',
    'original',
    'auto',
  ] as const);
  optionalEnum(env, 'CHAT_REASONING_EFFORT_DEFAULT', [
    'low',
    'high',
    'max',
  ] as const);
  optionalEnum(env, 'CHAT_THINKING_DEFAULT', ['true', 'false'] as const);

  if (!env.REDIS_URL && !env.REDIS_HOST) {
    throw new Error('请配置 REDIS_URL 或 REDIS_HOST');
  }

  const storage =
    typeof env.CHAT_ATTACHMENT_STORAGE === 'string'
      ? env.CHAT_ATTACHMENT_STORAGE.trim()
      : 'r2';
  if (storage === 'r2') {
    requireString(env, 'R2_ACCOUNT_ID', 8);
    requireApiKey(env, 'R2_ACCESS_KEY_ID');
    requireApiKey(env, 'R2_SECRET_ACCESS_KEY');
    requireString(env, 'R2_BUCKET', 1);
    requireString(env, 'R2_ENDPOINT', 8);
  }

  return env;
}

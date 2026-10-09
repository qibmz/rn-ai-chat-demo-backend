const DURATION = /^\d+[smhd]$/;

/** Secrets shipped in .env.example — must never be accepted at runtime. */
const PLACEHOLDER_SECRETS = new Set([
  'change-me-access-secret-min-32-chars!!',
  'change-me-refresh-secret-min-32-chars!',
]);

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

/**
 * Fail-fast env validation for ConfigModule.forRoot({ validate }).
 */
export function validateEnv(env: Record<string, unknown>) {
  requireString(env, 'DATABASE_URL', 8);
  requireJwtSecret(env, 'JWT_ACCESS_SECRET');
  requireJwtSecret(env, 'JWT_REFRESH_SECRET');

  optionalDuration(env, 'JWT_ACCESS_EXPIRES_IN');
  optionalDuration(env, 'JWT_REFRESH_EXPIRES_IN');
  optionalDuration(env, 'EMAIL_VERIFY_EXPIRES_IN');
  optionalDuration(env, 'PASSWORD_RESET_EXPIRES_IN');
  optionalDuration(env, 'PASSWORD_RESET_COOLDOWN');
  optionalDuration(env, 'EMAIL_VERIFY_COOLDOWN');

  optionalPositiveInt(env, 'PORT');
  optionalPositiveInt(env, 'THROTTLE_TTL_MS');
  optionalPositiveInt(env, 'THROTTLE_LIMIT');

  if (!env.REDIS_URL && !env.REDIS_HOST) {
    throw new Error('请配置 REDIS_URL 或 REDIS_HOST');
  }

  return env;
}

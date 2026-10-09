import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'local-dev-access-secret-not-in-example!!',
  JWT_REFRESH_SECRET: 'local-dev-refresh-secret-not-in-example!',
};

describe('validateEnv', () => {
  it('accepts strong non-placeholder secrets', () => {
    expect(() => validateEnv({ ...base })).not.toThrow();
  });

  it('rejects .env.example placeholder JWT secrets', () => {
    expect(() =>
      validateEnv({
        ...base,
        JWT_ACCESS_SECRET: 'change-me-access-secret-min-32-chars!!',
      }),
    ).toThrow(/占位密钥/);
  });

  it('rejects short secrets', () => {
    expect(() =>
      validateEnv({
        ...base,
        JWT_ACCESS_SECRET: 'too-short',
      }),
    ).toThrow(/至少 32/);
  });

  it('rejects invalid PORT', () => {
    expect(() => validateEnv({ ...base, PORT: 'abc' })).toThrow(/PORT/);
  });
});

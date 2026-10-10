import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'local-dev-access-secret-not-in-example!!',
  JWT_REFRESH_SECRET: 'local-dev-refresh-secret-not-in-example!',
  DEEPSEEK_API_KEY: 'test-deepseek-key-not-placeholder',
  CHAT_ATTACHMENT_STORAGE: 'disabled',
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

  it('rejects placeholder DEEPSEEK_API_KEY', () => {
    expect(() =>
      validateEnv({ ...base, DEEPSEEK_API_KEY: 'change-me' }),
    ).toThrow(/DEEPSEEK_API_KEY/);
  });

  it('allows test- prefixed DEEPSEEK_API_KEY for e2e', () => {
    expect(() =>
      validateEnv({
        ...base,
        DEEPSEEK_API_KEY: 'test-deepseek-key-not-placeholder',
      }),
    ).not.toThrow();
  });

  it('requires R2_* when CHAT_ATTACHMENT_STORAGE=r2', () => {
    expect(() =>
      validateEnv({
        ...base,
        CHAT_ATTACHMENT_STORAGE: 'r2',
      }),
    ).toThrow(/R2_ACCOUNT_ID/);
  });

  it('accepts r2 storage with R2 credentials', () => {
    expect(() =>
      validateEnv({
        ...base,
        CHAT_ATTACHMENT_STORAGE: 'r2',
        R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
        R2_ACCESS_KEY_ID: 'test-r2-access-key-id',
        R2_SECRET_ACCESS_KEY: 'test-r2-secret-access-key',
        R2_BUCKET: 'niuma-ai-chat-attachments',
        R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
      }),
    ).not.toThrow();
  });

  it('rejects invalid CHAT_REASONING_EFFORT_DEFAULT', () => {
    expect(() =>
      validateEnv({ ...base, CHAT_REASONING_EFFORT_DEFAULT: 'medium' }),
    ).toThrow(/CHAT_REASONING_EFFORT_DEFAULT/);
  });
});

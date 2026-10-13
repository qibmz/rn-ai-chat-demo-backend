import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
    fileParallelism: false,
    // Avoid real Resend + raise global throttle so suite can re-run within 60s
    env: {
      RESEND_API_KEY: '',
      NODE_ENV: 'test',
      THROTTLE_LIMIT: '1000',
      THROTTLE_TTL_MS: '60000',
      LLM_API_KEY: 'test-llm-key-not-placeholder',
      LLM_BASE_URL: 'https://llm.example.com/v1',
      LLM_MODEL: 'test-model',
      LLM_PROVIDER: 'deepseek',
      CHAT_ATTACHMENT_STORAGE: 'disabled',
    },
  },
});

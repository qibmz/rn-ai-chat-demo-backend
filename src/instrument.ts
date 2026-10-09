import 'dotenv/config';
import * as Sentry from '@sentry/nestjs';

const dsn = process.env.SENTRY_DSN?.trim();

// Safe if loaded both via `node --import` and `main.ts` import
if (dsn && !Sentry.getClient()) {
  const tracesSampleRate = Number(
    process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1',
  );

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: Number.isFinite(tracesSampleRate)
      ? tracesSampleRate
      : 0.1,
  });
}

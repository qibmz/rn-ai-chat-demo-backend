import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, firstValueFrom } from 'rxjs';
import { AI_UI_STREAM_KEY } from '../decorators/ai-ui-stream.decorator.js';
import { TransformInterceptor } from './transform.interceptor.js';

describe('TransformInterceptor', () => {
  const reflector = new Reflector();
  const interceptor = new TransformInterceptor(reflector);

  function mockContext(
    url: string,
    method = 'GET',
    meta: Record<string, unknown> = {},
  ): ExecutionContext {
    const handler = () => undefined;
    Reflect.defineMetadata(AI_UI_STREAM_KEY, meta[AI_UI_STREAM_KEY], handler);
    return {
      switchToHttp: () => ({
        getRequest: () => ({ url, method }),
      }),
      getHandler: () => handler,
      getClass: () => class TestController {},
    } as ExecutionContext;
  }

  it('wraps successful responses in unified envelope', async () => {
    const next: CallHandler = { handle: () => of({ ok: true }) };
    const result = await firstValueFrom(
      interceptor.intercept(mockContext('/auth/me'), next),
    );

    expect(result).toMatchObject({
      code: 200,
      message: 'OK',
      data: { ok: true },
      path: '/auth/me',
    });
    expect(result.timestamp).toBeDefined();
  });

  it('skips wrapping for /health', async () => {
    const payload = { status: 'ok' };
    const next: CallHandler = { handle: () => of(payload) };
    const result = await firstValueFrom(
      interceptor.intercept(mockContext('/health'), next),
    );
    expect(result).toEqual(payload);
  });

  it('skips wrapping for GET /auth/verify-email HTML page', async () => {
    const html = '<html>ok</html>';
    const next: CallHandler = { handle: () => of(html) };
    const result = await firstValueFrom(
      interceptor.intercept(
        mockContext('/auth/verify-email?token=abc', 'GET'),
        next,
      ),
    );
    expect(result).toBe(html);
  });

  it('skips wrapping when handler has @AiUiStream metadata', async () => {
    const payload = { stream: true };
    const next: CallHandler = { handle: () => of(payload) };
    const result = await firstValueFrom(
      interceptor.intercept(
        mockContext('/conversations/x/messages/stream', 'POST', {
          [AI_UI_STREAM_KEY]: true,
        }),
        next,
      ),
    );
    expect(result).toEqual(payload);
  });
});

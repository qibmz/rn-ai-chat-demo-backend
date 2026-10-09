import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, firstValueFrom } from 'rxjs';
import { TransformInterceptor } from './transform.interceptor.js';

describe('TransformInterceptor', () => {
  const interceptor = new TransformInterceptor();

  function mockContext(url: string, method = 'GET'): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ url, method }),
      }),
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
});

import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

describe('AllExceptionsFilter', () => {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
  };
  const filter = new AllExceptionsFilter(logger as never);

  function mockHost(url = '/auth/login') {
    const json = vi.fn();
    const end = vi.fn();
    const status = vi.fn().mockReturnValue({ json, end });
    const response = { status, json, end };
    const request = { url, method: 'POST' };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as ArgumentsHost;
    return { host, status, json, end, response };
  }

  it('formats HttpException with Chinese validation message', () => {
    const { host, status, json } = mockHost();
    filter.catch(
      new HttpException(
        { message: ['邮箱格式不正确', '密码过短'] },
        HttpStatus.BAD_REQUEST,
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 400,
        message: '参数校验失败',
        errors: ['邮箱格式不正确', '密码过短'],
      }),
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it('formats UnauthorizedException message', () => {
    const { host, status, json } = mockHost('/auth/me');
    filter.catch(
      new HttpException('请先登录，或登录状态已失效', HttpStatus.UNAUTHORIZED),
      host,
    );

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 401,
        message: '请先登录，或登录状态已失效',
      }),
    );
  });

  it('returns 204 for favicon', () => {
    const { host, status, end } = mockHost('/favicon.ico');
    filter.catch(new Error('nope'), host);
    expect(status).toHaveBeenCalledWith(204);
    expect(end).toHaveBeenCalled();
  });

  it('redacts verify token in log path and response path', () => {
    const { host, json } = mockHost(
      '/auth/verify-email?token=super-secret-token-value',
    );
    filter.catch(
      new HttpException('验证链接无效或已过期', HttpStatus.BAD_REQUEST),
      host,
    );

    expect(logger.warn).toHaveBeenCalledWith(
      'HTTP exception',
      expect.objectContaining({
        path: '/auth/verify-email?token=%5BREDACTED%5D',
      }),
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/auth/verify-email?token=%5BREDACTED%5D',
      }),
    );
  });
});

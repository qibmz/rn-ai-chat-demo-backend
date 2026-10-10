import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

describe('AllExceptionsFilter', () => {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
  };
  const filter = new AllExceptionsFilter(logger as never);

  function mockHost(response: {
    headersSent: boolean;
    writableEnded?: boolean;
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  }): ArgumentsHost {
    return {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({
          url: '/conversations/1/messages/stream',
          method: 'POST',
        }),
      }),
    } as ArgumentsHost;
  }

  beforeEach(() => {
    logger.error.mockClear();
    logger.warn.mockClear();
  });

  it('returns JSON envelope when headers have not been sent', () => {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const write = vi.fn();
    const end = vi.fn();
    const response = {
      headersSent: false,
      writableEnded: false,
      status,
      json,
      write,
      end,
    };

    filter.catch(new BadRequestException('参数错误'), mockHost(response));

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 400,
        message: '参数错误',
      }),
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('does not call json when headers already sent; writes stream error and ends', () => {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const write = vi.fn();
    const end = vi.fn();
    const response = {
      headersSent: true,
      writableEnded: false,
      status,
      json,
      write,
      end,
    };

    filter.catch(new Error('upstream failed'), mockHost(response));

    expect(json).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(expect.stringContaining('event: error'));
    expect(end).toHaveBeenCalled();
  });
});

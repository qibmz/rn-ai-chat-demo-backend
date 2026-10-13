import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/nestjs';
import { Request, Response } from 'express';
import { MulterError } from 'multer';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { ApiErrorResponse } from '../interfaces/api-response.interface.js';
import { sanitizeRequestPath } from '../utils/sanitize-request-path.js';

type PrismaKnownRequestError = Prisma.PrismaClientKnownRequestError;

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (request.url === '/favicon.ico') {
      if (!response.headersSent) {
        response.status(204).end();
      }
      return;
    }

    const { statusCode, message, errors } = this.normalize(exception);
    const safePath = sanitizeRequestPath(request.url ?? '');

    // Only report server failures — 4xx/HttpException are usually control flow
    if (statusCode >= 500) {
      Sentry.captureException(exception);
    }

    const logPayload = {
      context: AllExceptionsFilter.name,
      path: safePath,
      method: request.method,
      statusCode,
      message,
      stack: exception instanceof Error ? exception.stack : undefined,
      headersSent: response.headersSent,
    };
    if (statusCode >= 500) {
      this.logger.error('Unhandled exception', logPayload);
    } else {
      this.logger.warn('HTTP exception', logPayload);
    }

    // Stream already started (AI SDK UI Message Stream / SSE): never call .json()
    if (response.headersSent) {
      if (!response.writableEnded) {
        try {
          // UI Message Stream schema: { type: 'error', errorText }
          response.write(
            `data: ${JSON.stringify({ type: 'error', errorText: message })}\n\n`,
          );
        } catch {
          // ignore write failures on a half-closed socket
        }
        response.end();
      }
      return;
    }

    const body: ApiErrorResponse = {
      code: statusCode,
      message,
      errors,
      timestamp: new Date().toISOString(),
      path: safePath,
    };

    response.status(statusCode).json(body);
  }

  private normalize(exception: unknown): {
    statusCode: number;
    message: string;
    errors: string[] | null;
  } {
    if (exception instanceof MulterError) {
      if (exception.code === 'LIMIT_FILE_SIZE') {
        return {
          statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
          message: '图片大小超出限制',
          errors: null,
        };
      }
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: '上传文件无效',
        errors: null,
      };
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        return { statusCode, message: res, errors: null };
      }

      if (typeof res === 'object' && res !== null) {
        const payload = res as {
          message?: string | string[];
          error?: string;
        };
        const raw = payload.message ?? exception.message;
        if (Array.isArray(raw)) {
          return {
            statusCode,
            message: '参数校验失败',
            errors: raw.map(String),
          };
        }
        return {
          statusCode,
          message: String(raw),
          errors: null,
        };
      }

      return { statusCode, message: exception.message, errors: null };
    }

    if (this.isPrismaKnownRequestError(exception)) {
      if (exception.code === 'P2002') {
        return {
          statusCode: HttpStatus.CONFLICT,
          message: '该邮箱已注册',
          errors: null,
        };
      }
      if (exception.code === 'P2025') {
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: '资源不存在',
          errors: null,
        };
      }
    }

    const isDev = process.env.NODE_ENV === 'development';
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message:
        isDev && exception instanceof Error
          ? exception.message
          : '服务器内部错误',
      errors: null,
    };
  }

  private isPrismaKnownRequestError(
    exception: unknown,
  ): exception is PrismaKnownRequestError {
    return (
      typeof exception === 'object' &&
      exception !== null &&
      'code' in exception &&
      'clientVersion' in exception &&
      typeof (exception as { code?: unknown }).code === 'string'
    );
  }
}

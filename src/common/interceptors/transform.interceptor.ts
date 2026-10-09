import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, map } from 'rxjs';
import { ApiSuccessResponse } from '../interfaces/api-response.interface.js';
import { sanitizeRequestPath } from '../utils/sanitize-request-path.js';

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponse<T | null>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<T | null>> {
    const request = context.switchToHttp().getRequest<Request>();
    const path = sanitizeRequestPath(request.url ?? '');
    const method = request.method ?? 'GET';

    if (this.shouldSkip(request.url ?? '', method)) {
      return next.handle() as unknown as Observable<
        ApiSuccessResponse<T | null>
      >;
    }

    return next.handle().pipe(
      map((data) => ({
        code: 200,
        message: 'OK',
        data: data === undefined ? null : data,
        timestamp: new Date().toISOString(),
        path,
      })),
    );
  }

  private shouldSkip(path: string, method: string): boolean {
    const clean = path.split('?')[0] ?? path;
    return (
      clean === '/health' ||
      clean.startsWith('/health/') ||
      clean === '/api-docs' ||
      clean.startsWith('/api-docs/') ||
      // 邮件链接落地页返回 HTML，不包统一 JSON 外壳
      (method.toUpperCase() === 'GET' && clean === '/auth/verify-email')
    );
  }
}

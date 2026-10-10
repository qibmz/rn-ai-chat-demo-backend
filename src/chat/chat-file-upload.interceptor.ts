import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import multer, { memoryStorage } from 'multer';
import type { NextFunction, Request, Response } from 'express';
import { from, switchMap } from 'rxjs';

@Injectable()
export class ChatFileUploadInterceptor implements NestInterceptor {
  private readonly upload: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void;

  constructor(configService: ConfigService) {
    const maxBytes = Number(
      configService.get('CHAT_MAX_IMAGE_BYTES', '8388608'),
    );
    this.upload = multer({
      storage: memoryStorage(),
      limits: { fileSize: maxBytes },
    }).single('file');
  }

  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    return from(
      new Promise<void>((resolve, reject) => {
        this.upload(req, res, (err: unknown) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
    ).pipe(switchMap(() => next.handle()));
  }
}

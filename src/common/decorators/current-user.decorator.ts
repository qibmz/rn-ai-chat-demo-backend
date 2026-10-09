import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export class AuthUser {
  userId!: string;
  email!: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();
    return request.user;
  },
);

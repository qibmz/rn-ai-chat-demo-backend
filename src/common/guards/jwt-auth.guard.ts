import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }

  handleRequest<TUser>(
    err: Error | null,
    user: TUser,
    info?: Error | { message?: string; name?: string },
  ): TUser {
    if (err || !user) {
      const name = err?.name ?? (info as { name?: string } | undefined)?.name;
      if (name === 'TokenExpiredError') {
        throw new UnauthorizedException('登录已过期，请重新登录');
      }
      throw new UnauthorizedException('请先登录，或登录状态已失效');
    }
    return user;
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { normalizeEmail } from '../common/utils/normalize-email.js';
import { EmailQueue } from '../queues/email/email.queue.js';
import { RedisService } from '../redis/redis.service.js';
import { UsersService } from '../users/users.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

interface TokenPayload {
  sub: string;
  email: string;
  jti?: string;
}

@Injectable()
export class AuthService {
  private readonly refreshPrefix = 'auth:refresh:';
  private readonly refreshUserPrefix = 'auth:refresh-user:';
  private readonly verifyPrefix = 'auth:email-verify:';
  private readonly verifyUserPrefix = 'auth:email-verify-user:';
  private readonly verifyCooldownPrefix = 'auth:email-verify-cooldown:';
  private readonly resetPrefix = 'auth:password-reset:';
  private readonly resetAttemptsPrefix = 'auth:password-reset-attempts:';
  private readonly resetCooldownPrefix = 'auth:password-reset-cooldown:';
  private readonly loginFailPrefix = 'auth:login-fail:';
  private readonly maxResetAttempts = 5;
  private readonly maxLoginFailures = 10;
  private readonly dummyPasswordHash: string;

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly emailQueue: EmailQueue,
  ) {
    // Match production compare cost; tests use cheaper rounds via NODE_ENV=test
    const rounds = process.env.NODE_ENV === 'test' ? 4 : 12;
    this.dummyPasswordHash = bcrypt.hashSync('__timing-dummy__', rounds);
  }

  async register(dto: RegisterDto): Promise<TokenPair> {
    const email = normalizeEmail(dto.email);
    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      throw new ConflictException('该邮箱已注册');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.usersService.create(email, passwordHash);

    try {
      await this.sendVerificationEmail(user.id, user.email);
    } catch {
      // User is already created — do not fail registration on mail/queue errors
    }

    return this.issueTokens(user.id, user.email);
  }

  async login(dto: LoginDto): Promise<TokenPair> {
    const email = normalizeEmail(dto.email);
    const failKey = `${this.loginFailPrefix}${email}`;
    const failsRaw = await this.redisService.get(failKey);
    const fails = failsRaw ? Number(failsRaw) : 0;
    if (fails >= this.maxLoginFailures) {
      throw new UnauthorizedException('登录尝试过多，请稍后再试');
    }

    const user = await this.usersService.findByEmail(email);
    const passwordHash = user?.passwordHash ?? this.dummyPasswordHash;
    const valid = await bcrypt.compare(dto.password, passwordHash);

    if (!user || !valid) {
      await this.redisService.incr(failKey, 15 * 60);
      throw new UnauthorizedException('邮箱或密码错误');
    }

    if (this.requireEmailVerified() && !user.emailVerifiedAt) {
      throw new ForbiddenException('请先验证邮箱');
    }

    await this.redisService.del(failKey);
    return this.issueTokens(user.id, user.email);
  }

  async verifyEmail(
    token: string,
  ): Promise<{ success: boolean; email: string }> {
    const tokenHash = this.hashToken(token);
    const userId = await this.redisService.get(
      `${this.verifyPrefix}${tokenHash}`,
    );
    if (!userId) {
      throw new BadRequestException('验证链接无效或已过期');
    }

    const user = await this.usersService.findById(userId);
    if (!user) {
      await this.clearVerificationTokens(userId, tokenHash);
      throw new BadRequestException('验证链接无效或已过期');
    }

    if (!user.emailVerifiedAt) {
      await this.usersService.markEmailVerified(user.id);
    }

    await this.clearVerificationTokens(user.id, tokenHash);

    return { success: true, email: user.email };
  }

  async resendVerification(email: string): Promise<{ success: boolean }> {
    const normalized = normalizeEmail(email);
    const cooldownKey = `${this.verifyCooldownPrefix}${normalized}`;

    if (await this.redisService.exists(cooldownKey)) {
      return { success: true };
    }

    const user = await this.usersService.findByEmail(normalized);
    // Avoid account enumeration — always return the same shape
    if (!user || user.emailVerifiedAt) {
      return { success: true };
    }

    await this.sendVerificationEmail(user.id, user.email);

    // Only arm cooldown after a real send (prevents pre-burn DoS)
    const cooldownSeconds = this.parseDurationToSeconds(
      this.configService.get<string>('EMAIL_VERIFY_COOLDOWN', '60s'),
    );
    await this.redisService.set(cooldownKey, '1', cooldownSeconds);

    return { success: true };
  }

  async forgotPassword(email: string): Promise<{ success: boolean }> {
    const normalized = normalizeEmail(email);
    const cooldownKey = `${this.resetCooldownPrefix}${normalized}`;

    // Always succeed outwardly; cooldown / missing user stay silent
    if (await this.redisService.exists(cooldownKey)) {
      return { success: true };
    }

    const user = await this.usersService.findByEmail(normalized);
    if (!user) {
      return { success: true };
    }

    // 8-digit code (~90M space)
    const code = String(randomInt(10_000_000, 100_000_000));
    const expiresIn = this.configService.get<string>(
      'PASSWORD_RESET_EXPIRES_IN',
      '15m',
    );
    const ttlSeconds = this.parseDurationToSeconds(expiresIn);
    const cooldownSeconds = this.parseDurationToSeconds(
      this.configService.get<string>('PASSWORD_RESET_COOLDOWN', '60s'),
    );

    await this.redisService.set(
      `${this.resetPrefix}${normalized}`,
      this.hashToken(code),
      ttlSeconds,
    );

    const appName = this.appName();
    await this.emailQueue.enqueue({
      to: user.email,
      subject: `密码重置验证码 — ${appName}`,
      body: `你的密码重置验证码是 ${code}，有效期 ${expiresIn}。如非本人操作请忽略本邮件。`,
      html: `<p>你正在重置 ${escapeHtml(appName)} 账号密码。</p><p style="font-size:24px;letter-spacing:4px"><strong>${code}</strong></p><p>验证码有效期为 ${expiresIn}。如非本人操作，请忽略本邮件。</p>`,
    });

    // Arm cooldown only after enqueue (prevents pre-burn DoS on victims)
    await this.redisService.set(cooldownKey, '1', cooldownSeconds);

    return { success: true };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ success: boolean }> {
    const normalizedEmail = normalizeEmail(dto.email);
    const resetKey = `${this.resetPrefix}${normalizedEmail}`;
    const attemptsKey = `${this.resetAttemptsPrefix}${normalizedEmail}`;

    const storedHash = await this.redisService.get(resetKey);
    if (!storedHash) {
      throw new BadRequestException('验证码无效或已过期');
    }

    const expiresIn = this.configService.get<string>(
      'PASSWORD_RESET_EXPIRES_IN',
      '15m',
    );
    const ttlSeconds = this.parseDurationToSeconds(expiresIn);

    if (!this.safe.equalHash(storedHash, this.hashToken(dto.code))) {
      const attempts = await this.redisService.incr(attemptsKey, ttlSeconds);
      if (attempts >= this.maxResetAttempts) {
        await this.redisService.del(resetKey, attemptsKey);
        throw new BadRequestException('尝试次数过多，请重新获取验证码');
      }
      throw new BadRequestException('验证码无效或已过期');
    }

    const user = await this.usersService.findByEmail(normalizedEmail);
    if (!user) {
      await this.redisService.del(resetKey, attemptsKey);
      throw new BadRequestException('验证码无效或已过期');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.usersService.updatePassword(user.id, passwordHash);
    await this.revokeAllRefreshTokens(user.id);
    await this.redisService.del(
      resetKey,
      attemptsKey,
      `${this.resetCooldownPrefix}${normalizedEmail}`,
    );

    return { success: true };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = this.hashToken(refreshToken);
    const key = `${this.refreshPrefix}${tokenHash}`;
    const stored = await this.redisService.getdel(key);

    if (!stored) {
      // Reuse / already rotated: if JWT still valid, revoke all sessions
      try {
        const payload = await this.jwtService.verifyAsync<TokenPayload>(
          refreshToken,
          {
            secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
          },
        );
        await this.revokeAllRefreshTokens(payload.sub);
      } catch {
        // ignore invalid JWT
      }
      throw new UnauthorizedException('登录已失效，请重新登录');
    }

    let payload: TokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<TokenPayload>(refreshToken, {
        secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      await this.redisService.srem(
        `${this.refreshUserPrefix}${stored}`,
        tokenHash,
      );
      throw new UnauthorizedException('登录已失效，请重新登录');
    }

    if (stored !== payload.sub) {
      await this.revokeAllRefreshTokens(stored);
      throw new UnauthorizedException('登录已失效，请重新登录');
    }

    await this.redisService.srem(
      `${this.refreshUserPrefix}${payload.sub}`,
      tokenHash,
    );
    return this.issueTokens(payload.sub, payload.email);
  }

  async logout(refreshToken: string): Promise<{ success: boolean }> {
    const tokenHash = this.hashToken(refreshToken);
    const userId = await this.redisService.getdel(
      `${this.refreshPrefix}${tokenHash}`,
    );
    if (userId) {
      await this.redisService.srem(
        `${this.refreshUserPrefix}${userId}`,
        tokenHash,
      );
    }
    return { success: true };
  }

  async me(userId: string) {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('账号不存在或已失效');
    }
    return {
      id: user.id,
      email: user.email,
      emailVerified: Boolean(user.emailVerifiedAt),
      createdAt: user.createdAt,
    };
  }

  private requireEmailVerified(): boolean {
    return (
      this.configService.get<string>('EMAIL_VERIFICATION_REQUIRED', 'false') ===
      'true'
    );
  }

  private async sendVerificationEmail(
    userId: string,
    email: string,
  ): Promise<void> {
    const previousHash = await this.redisService.get(
      `${this.verifyUserPrefix}${userId}`,
    );
    if (previousHash) {
      await this.redisService.del(`${this.verifyPrefix}${previousHash}`);
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    const expiresIn = this.configService.get<string>(
      'EMAIL_VERIFY_EXPIRES_IN',
      '24h',
    );
    const ttlSeconds = this.parseDurationToSeconds(expiresIn);

    await this.redisService.set(
      `${this.verifyPrefix}${tokenHash}`,
      userId,
      ttlSeconds,
    );
    await this.redisService.set(
      `${this.verifyUserPrefix}${userId}`,
      tokenHash,
      ttlSeconds,
    );

    const appUrl = this.configService
      .get<string>('APP_URL', 'http://localhost:3000')
      .replace(/\/$/, '');
    const verifyUrl = `${appUrl}/auth/verify-email?token=${token}`;

    const appName = this.appName();
    await this.emailQueue.enqueue({
      to: email,
      subject: `请验证你的邮箱 — ${appName}`,
      body: `请打开以下链接完成邮箱验证（有效期 ${expiresIn}）：\n${verifyUrl}\n\n如链接无法点击，可将完整地址复制到浏览器打开。`,
      html: `<p>欢迎使用 ${escapeHtml(appName)}，请验证你的邮箱。</p><p><a href="${verifyUrl}">点击验证邮箱</a></p><p>链接有效期为 ${expiresIn}。</p><p>若按钮无法打开，请复制以下地址到浏览器：</p><p><a href="${verifyUrl}">${escapeHtml(verifyUrl)}</a></p>`,
    });
  }

  private appName(): string {
    return this.configService.get<string>('APP_NAME', 'App').trim() || 'App';
  }

  private async clearVerificationTokens(
    userId: string,
    tokenHash: string,
  ): Promise<void> {
    await this.redisService.del(
      `${this.verifyPrefix}${tokenHash}`,
      `${this.verifyUserPrefix}${userId}`,
    );
  }

  private async revokeAllRefreshTokens(userId: string): Promise<void> {
    const userKey = `${this.refreshUserPrefix}${userId}`;
    const hashes = await this.redisService.smembers(userKey);
    if (hashes.length > 0) {
      await this.redisService.del(
        ...hashes.map((hash) => `${this.refreshPrefix}${hash}`),
      );
    }
    await this.redisService.del(userKey);
  }

  private async issueTokens(userId: string, email: string): Promise<TokenPair> {
    const accessExpiresIn = this.configService.get<string>(
      'JWT_ACCESS_EXPIRES_IN',
      '15m',
    );
    const refreshExpiresIn = this.configService.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
      '7d',
    );

    const accessToken = await this.jwtService.signAsync(
      { sub: userId, email },
      {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: accessExpiresIn as `${number}${'s' | 'm' | 'h' | 'd'}`,
      },
    );

    const refreshToken = await this.jwtService.signAsync(
      { sub: userId, email, jti: randomUUID() },
      {
        secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshExpiresIn as `${number}${'s' | 'm' | 'h' | 'd'}`,
      },
    );

    const ttlSeconds = this.parseDurationToSeconds(refreshExpiresIn);
    const tokenHash = this.hashToken(refreshToken);
    await this.redisService.set(
      `${this.refreshPrefix}${tokenHash}`,
      userId,
      ttlSeconds,
    );
    await this.redisService.sadd(
      `${this.refreshUserPrefix}${userId}`,
      tokenHash,
    );
    await this.redisService.expire(
      `${this.refreshUserPrefix}${userId}`,
      ttlSeconds,
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: accessExpiresIn,
    };
  }

  private hashToken(token: string): string {
    const secret = this.configService.getOrThrow<string>('JWT_ACCESS_SECRET');
    return createHmac('sha256', secret).update(token).digest('hex');
  }

  private safe = {
    equalHash: (a: string, b: string): boolean => {
      const left = Buffer.from(a);
      const right = Buffer.from(b);
      if (left.length !== right.length) {
        return false;
      }
      return timingSafeEqual(left, right);
    },
  };

  private parseDurationToSeconds(duration: string): number {
    const match = /^(\d+)([smhd])$/.exec(duration.trim());
    if (!match) {
      throw new Error(
        `无效的时长配置 "${duration}"，应为数字 + s|m|h|d（例如 15m）`,
      );
    }
    const value = Number(match[1]);
    const unit = match[2];
    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 60 * 60;
      case 'd':
        return value * 24 * 60 * 60;
      default:
        throw new Error(`无效的时长单位: ${unit}`);
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

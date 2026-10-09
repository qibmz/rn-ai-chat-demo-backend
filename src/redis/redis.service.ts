import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis, RedisOptions } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client!: Redis;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    // App/auth path: fail fast. BullMQ keeps its own connection with
    // maxRetriesPerRequest: null in QueueModule.
    const options: RedisOptions = {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 5_000,
      commandTimeout: 3_000,
      lazyConnect: false,
    };

    const url = this.configService.get<string>('REDIS_URL');
    if (url) {
      this.client = new Redis(url, options);
      return;
    }

    this.client = new Redis({
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get<string>('REDIS_PASSWORD') || undefined,
      ...options,
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit();
    }
  }

  getClient(): Redis {
    return this.client;
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.set(key, value, 'EX', ttlSeconds);
      return;
    }
    await this.client.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /** Atomically get and delete (Redis GETDEL). */
  async getdel(key: string): Promise<string | null> {
    return this.client.getdel(key);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    await this.client.del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  /**
   * Increment counter; set TTL only when the key is first created.
   * Returns the value after increment.
   */
  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const value = await this.client.incr(key);
    if (value === 1 && ttlSeconds && ttlSeconds > 0) {
      await this.client.expire(key, ttlSeconds);
    }
    return value;
  }

  async sadd(key: string, member: string): Promise<void> {
    await this.client.sadd(key, member);
  }

  async srem(key: string, member: string): Promise<void> {
    await this.client.srem(key, member);
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds > 0) {
      await this.client.expire(key, ttlSeconds);
    }
  }
}

import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Injectable,
  ServiceUnavailableException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class R2Service implements OnModuleInit {
  private client: S3Client | null = null;
  private bucket = '';
  private enabled = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const storage =
      this.configService.get<string>('CHAT_ATTACHMENT_STORAGE', 'r2')?.trim() ??
      'r2';
    this.enabled = storage === 'r2';
    if (!this.enabled) {
      return;
    }

    this.bucket = this.configService.get<string>('R2_BUCKET', '').trim();
    const endpoint = this.configService.get<string>('R2_ENDPOINT', '').trim();
    const region =
      this.configService.get<string>('R2_REGION', 'auto')?.trim() || 'auto';
    const accessKeyId = this.configService
      .get<string>('R2_ACCESS_KEY_ID', '')
      .trim();
    const secretAccessKey = this.configService
      .get<string>('R2_SECRET_ACCESS_KEY', '')
      .trim();

    this.client = new S3Client({
      region,
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private assertEnabled(): void {
    if (!this.enabled || !this.client) {
      throw new ServiceUnavailableException('附件存储未启用');
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    this.assertEnabled();
    await this.client!.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    this.assertEnabled();
    await this.client!.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async getPresignedGetUrl(
    key: string,
    expiresInSeconds: number,
  ): Promise<string> {
    this.assertEnabled();
    return getSignedUrl(
      this.client!,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
      { expiresIn: expiresInSeconds },
    );
  }
}

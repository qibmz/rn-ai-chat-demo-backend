import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fileTypeFromBuffer } from 'file-type';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { R2Service } from '../storage/r2/r2.service.js';
import {
  extensionForImageMime,
  isAllowedImageMime,
} from './utils/image-mime.util.js';

export type AttachmentPresignResult = {
  id: string;
  url: string;
  expiresAt: string;
  mimeType: string;
  byteSize: number;
};

export type AttachmentUploadResult = {
  id: string;
  mimeType: string;
  byteSize: number;
};

@Injectable()
export class ChatAttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly configService: ConfigService,
  ) {}

  private presignTtlSec(): number {
    return Number(this.configService.get('R2_PRESIGN_EXPIRES_SEC', '600'));
  }

  async upload(
    userId: string,
    file: Express.Multer.File,
  ): Promise<AttachmentUploadResult> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('请上传图片文件');
    }

    const maxBytes = Number(
      this.configService.get('CHAT_MAX_IMAGE_BYTES', '8388608'),
    );
    if (file.size > maxBytes) {
      throw new BadRequestException('图片大小超出限制');
    }

    const detected = await fileTypeFromBuffer(file.buffer);
    if (!isAllowedImageMime(detected?.mime)) {
      throw new BadRequestException('仅支持 JPEG、PNG、GIF、WebP 图片');
    }

    const mimeType = detected.mime;
    const ext = extensionForImageMime(mimeType);
    const objectId = randomUUID();
    const r2Key = `chat/${userId}/${objectId}.${ext}`;

    await this.r2.putObject(r2Key, file.buffer, mimeType);

    const attachment = await this.prisma.attachment.create({
      data: {
        userId,
        r2Key,
        mimeType,
        byteSize: file.buffer.length,
      },
    });

    return {
      id: attachment.id,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
    };
  }

  async presignForUser(
    userId: string,
    attachmentId: string,
  ): Promise<AttachmentPresignResult> {
    const attachment = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, userId },
    });
    if (!attachment) {
      throw new NotFoundException('附件不存在');
    }

    const ttl = this.presignTtlSec();
    const url = await this.r2.getPresignedGetUrl(attachment.r2Key, ttl);
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    return {
      id: attachment.id,
      url,
      expiresAt,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
    };
  }

  async presignMany(
    userId: string,
    attachmentIds: string[],
  ): Promise<Map<string, AttachmentPresignResult>> {
    const unique = [...new Set(attachmentIds.filter(Boolean))];
    const map = new Map<string, AttachmentPresignResult>();
    if (unique.length === 0) {
      return map;
    }

    const rows = await this.prisma.attachment.findMany({
      where: { id: { in: unique }, userId },
    });

    const ttl = this.presignTtlSec();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    await Promise.all(
      rows.map(async (row) => {
        const url = await this.r2.getPresignedGetUrl(row.r2Key, ttl);
        map.set(row.id, {
          id: row.id,
          url,
          expiresAt,
          mimeType: row.mimeType,
          byteSize: row.byteSize,
        });
      }),
    );

    return map;
  }
}

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BotFaceShape,
  BotKind,
  Prisma,
  type Bot,
  type Conversation,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateBotDto } from './dto/create-bot.dto.js';
import { UpdateBotDto } from './dto/update-bot.dto.js';

export type BotDto = {
  id: string;
  name: string;
  kind: 'main' | 'sub';
  faceColor: string;
  faceShape: 'circle' | 'oval' | 'squircle';
  systemPrompt: string | null;
  conversationId: string;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const PREVIEW_MAX = 80;
const MAIN_FACE_COLOR = '#0A0A0A';
const MAIN_FACE_SHAPE = BotFaceShape.circle;

type BotWithConversation = Bot & { conversation: Conversation | null };

@Injectable()
export class BotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private appNameSnapshot(): string {
    return this.configService.get<string>('APP_NAME', '牛马')?.trim() || '牛马';
  }

  private toDto(
    row: BotWithConversation,
    preview: { text: string | null; at: Date | null },
  ): BotDto {
    if (!row.conversation) {
      throw new Error(`Bot ${row.id} missing conversation`);
    }
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      faceColor: row.faceColor,
      faceShape: row.faceShape,
      systemPrompt: row.systemPrompt,
      conversationId: row.conversation.id,
      lastMessagePreview: preview.text,
      lastMessageAt: preview.at ? preview.at.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private formatPreview(content: string, parts: unknown): string | null {
    const trimmed = content?.trim() ?? '';
    if (trimmed) {
      return trimmed.length > PREVIEW_MAX
        ? trimmed.slice(0, PREVIEW_MAX)
        : trimmed;
    }
    const arr = Array.isArray(parts) ? parts : [];
    if (
      arr.some(
        (p) =>
          p &&
          typeof p === 'object' &&
          (p as { type?: string }).type === 'image',
      )
    ) {
      return '[图片]';
    }
    return null;
  }

  /** 一次查出多个 conversation 的最近 user/assistant 消息 */
  private async loadPreviews(
    conversationIds: string[],
  ): Promise<Map<string, { text: string | null; at: Date | null }>> {
    const map = new Map<string, { text: string | null; at: Date | null }>();
    if (conversationIds.length === 0) {
      return map;
    }
    const rows = await this.prisma.$queryRaw<
      Array<{
        conversation_id: string;
        content: string;
        parts: unknown;
        created_at: Date;
      }>
    >(Prisma.sql`
      SELECT DISTINCT ON (m.conversation_id)
        m.conversation_id,
        m.content,
        m.parts,
        m.created_at
      FROM messages m
      WHERE m.conversation_id IN (${Prisma.join(conversationIds)})
        AND m.role IN ('user'::"MessageRole", 'assistant'::"MessageRole")
      ORDER BY m.conversation_id, m.created_at DESC
    `);
    for (const r of rows) {
      map.set(r.conversation_id, {
        text: this.formatPreview(r.content, r.parts),
        at: r.created_at,
      });
    }
    return map;
  }

  async createMainBotWithConversation(
    tx: Prisma.TransactionClient,
    userId: string,
    name: string,
  ): Promise<{ botId: string; conversationId: string }> {
    const bot = await tx.bot.create({
      data: {
        userId,
        name,
        kind: BotKind.main,
        faceColor: MAIN_FACE_COLOR,
        faceShape: MAIN_FACE_SHAPE,
      },
    });
    const conversation = await tx.conversation.create({
      data: {
        userId,
        title: name,
        botId: bot.id,
      },
    });
    return { botId: bot.id, conversationId: conversation.id };
  }

  async ensureMainBot(userId: string): Promise<BotWithConversation> {
    const existing = await this.prisma.bot.findFirst({
      where: { userId, kind: BotKind.main, deletedAt: null },
      include: { conversation: true },
    });
    if (existing?.conversation) {
      return existing;
    }

    const name = this.appNameSnapshot();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const again = await tx.bot.findFirst({
          where: { userId, kind: BotKind.main, deletedAt: null },
          include: { conversation: true },
        });
        if (again?.conversation) {
          return again;
        }
        const { botId } = await this.createMainBotWithConversation(
          tx,
          userId,
          name,
        );
        const row = await tx.bot.findFirstOrThrow({
          where: { id: botId },
          include: { conversation: true },
        });
        return row;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const row = await this.prisma.bot.findFirst({
          where: { userId, kind: BotKind.main, deletedAt: null },
          include: { conversation: true },
        });
        if (row?.conversation) {
          return row;
        }
      }
      throw err;
    }
  }

  async list(userId: string): Promise<BotDto[]> {
    await this.ensureMainBot(userId);
    const rows = await this.prisma.bot.findMany({
      where: { userId, deletedAt: null },
      include: { conversation: true },
      orderBy: [{ updatedAt: 'desc' }],
    });
    rows.sort((a, b) => {
      if (a.kind === BotKind.main && b.kind !== BotKind.main) return -1;
      if (b.kind === BotKind.main && a.kind !== BotKind.main) return 1;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
    const ids = rows
      .map((r) => r.conversation?.id)
      .filter((id): id is string => !!id);
    const previews = await this.loadPreviews(ids);
    return rows.map((r) =>
      this.toDto(
        r,
        previews.get(r.conversation!.id) ?? { text: null, at: null },
      ),
    );
  }

  async getById(userId: string, id: string): Promise<BotDto> {
    const row = await this.prisma.bot.findFirst({
      where: { id, userId, deletedAt: null },
      include: { conversation: true },
    });
    if (!row?.conversation) {
      throw new NotFoundException('Bot 不存在');
    }
    const previews = await this.loadPreviews([row.conversation.id]);
    return this.toDto(
      row,
      previews.get(row.conversation.id) ?? { text: null, at: null },
    );
  }

  async createSub(userId: string, dto: CreateBotDto): Promise<BotDto> {
    await this.ensureMainBot(userId);
    const row = await this.prisma.$transaction(async (tx) => {
      const bot = await tx.bot.create({
        data: {
          userId,
          name: dto.name.trim(),
          kind: BotKind.sub,
          faceColor: dto.faceColor,
          faceShape: dto.faceShape as BotFaceShape,
          systemPrompt: dto.systemPrompt?.trim() || null,
        },
      });
      await tx.conversation.create({
        data: {
          userId,
          title: bot.name,
          botId: bot.id,
        },
      });
      return tx.bot.findFirstOrThrow({
        where: { id: bot.id },
        include: { conversation: true },
      });
    });
    return this.toDto(row, { text: null, at: null });
  }

  async update(userId: string, id: string, dto: UpdateBotDto): Promise<BotDto> {
    const row = await this.prisma.bot.findFirst({
      where: { id, userId, deletedAt: null },
      include: { conversation: true },
    });
    if (!row?.conversation) {
      throw new NotFoundException('Bot 不存在');
    }

    if (dto.deleted === true) {
      if (row.kind === BotKind.main) {
        throw new BadRequestException('主 Bot 不可删除');
      }
      const updated = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        await tx.conversation.update({
          where: { id: row.conversation!.id },
          data: { deletedAt: now },
        });
        return tx.bot.update({
          where: { id },
          data: { deletedAt: now },
          include: { conversation: true },
        });
      });
      return this.toDto(
        { ...updated, conversation: updated.conversation ?? row.conversation },
        { text: null, at: null },
      );
    }

    const data: Prisma.BotUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.faceColor !== undefined) data.faceColor = dto.faceColor;
    if (dto.faceShape !== undefined) {
      data.faceShape = dto.faceShape as BotFaceShape;
    }
    if (dto.systemPrompt !== undefined) {
      data.systemPrompt = dto.systemPrompt.trim() || null;
    }

    const updated = await this.prisma.bot.update({
      where: { id },
      data,
      include: { conversation: true },
    });
    const previews = await this.loadPreviews([updated.conversation!.id]);
    return this.toDto(
      updated,
      previews.get(updated.conversation!.id) ?? { text: null, at: null },
    );
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { UpdateConversationDto } from './dto/update-conversation.dto.js';

export type ConversationDto = {
  id: string;
  botId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class ChatConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  private toDto(row: {
    id: string;
    botId: string;
    title: string;
    createdAt: Date;
    updatedAt: Date;
  }): ConversationDto {
    return {
      id: row.id,
      botId: row.botId,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(userId: string, botId?: string): Promise<ConversationDto[]> {
    const rows = await this.prisma.conversation.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(botId ? { botId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async getById(userId: string, id: string): Promise<ConversationDto> {
    const row = await this.prisma.conversation.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException('对话不存在');
    }
    return this.toDto(row);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateConversationDto,
  ): Promise<ConversationDto> {
    await this.getById(userId, id);

    const data: { title?: string; deletedAt?: Date | null } = {};
    if (dto.title !== undefined) {
      data.title = dto.title.trim() || '新对话';
    }
    if (dto.deleted === true) {
      data.deletedAt = new Date();
    }

    const row = await this.prisma.conversation.update({
      where: { id },
      data,
    });

    return this.toDto(row);
  }
}

import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator.js';
import { BotsService } from './bots.service.js';
import { CreateBotDto } from './dto/create-bot.dto.js';
import { UpdateBotDto } from './dto/update-bot.dto.js';

@ApiTags('Bot')
@ApiBearerAuth()
@Throttle({ default: { limit: 60, ttl: 60000 } })
@Controller('bots')
export class BotsController {
  constructor(private readonly botsService: BotsService) {}

  @Get()
  @ApiOperation({ summary: 'Bot 列表（含最近消息预览；必要时懒补主 Bot）' })
  list(@CurrentUser() user: AuthUser) {
    return this.botsService.list(user.userId);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({ summary: '创建子 Bot（同时创建唯一会话）' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateBotDto) {
    return this.botsService.createSub(user.userId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Bot 详情' })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.botsService.getById(user.userId, id);
  }

  @Patch(':id')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({ summary: '更新 Bot 或软删除子 Bot' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBotDto,
  ) {
    return this.botsService.update(user.userId, id, dto);
  }
}

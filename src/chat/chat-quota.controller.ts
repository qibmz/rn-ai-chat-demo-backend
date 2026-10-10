import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator.js';
import { ChatQuotaService } from './chat-quota.service.js';

@ApiTags('聊天')
@ApiBearerAuth()
@Controller('chat')
export class ChatQuotaController {
  constructor(private readonly quotaService: ChatQuotaService) {}

  @Get('quota')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: '查询本周聊天额度（百分比）' })
  quota(@CurrentUser() user: AuthUser) {
    return this.quotaService.getQuota(user.userId);
  }
}

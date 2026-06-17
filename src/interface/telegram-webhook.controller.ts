import { Body, Controller, ForbiddenException, Headers, HttpCode, Post } from '@nestjs/common';
import type { Update } from 'telegraf/types';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';
import { Inject } from '@nestjs/common';
import { TelegramAdapter, TELEGRAM_WEBHOOK_PATH } from '../infra/telegram/telegram.adapter';

/**
 * Receives Telegram updates when running in webhook mode. In polling mode this
 * endpoint is simply never called. The secret token (if configured) is validated
 * against Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
 */
@Controller(TELEGRAM_WEBHOOK_PATH)
export class TelegramWebhookController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly telegram: TelegramAdapter,
  ) {}

  @Post()
  @HttpCode(200)
  async handle(
    @Body() update: Update,
    @Headers('x-telegram-bot-api-secret-token') secretToken?: string,
  ): Promise<{ ok: true }> {
    const expected = this.config.telegram.webhookSecret;
    if (expected && secretToken !== expected) {
      throw new ForbiddenException('Invalid Telegram secret token');
    }
    await this.telegram.handleUpdate(update);
    return { ok: true };
  }
}

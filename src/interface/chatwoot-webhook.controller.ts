import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';
import { DedupPort, DEDUP_PORT, OutboxPort, OUTBOX_PORT } from '../domain/ports';
import { ChatwootWebhookEvent } from '../infra/chatwoot/chatwoot.types';

/**
 * Receives Chatwoot webhooks. Verifies the optional HMAC signature, deduplicates
 * redeliveries, enqueues the event for asynchronous delivery, and returns 200
 * immediately so Chatwoot is never blocked on our processing.
 */
@Controller()
export class ChatwootWebhookController {
  private readonly logger = new Logger(ChatwootWebhookController.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OUTBOX_PORT) private readonly outbox: OutboxPort,
    @Inject(DEDUP_PORT) private readonly dedup: DedupPort,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Body() event: ChatwootWebhookEvent,
    @Headers() headers: Record<string, string>,
  ): Promise<{ ok: true }> {
    this.verifySignature(req, headers);

    if (event?.event !== 'message_created') {
      return { ok: true };
    }

    const dedupKey = `chatwoot:${event.event}:${event.id}`;
    if (!this.dedup.firstSeen(dedupKey)) {
      this.logger.debug(`Duplicate webhook ignored: ${dedupKey}`);
      return { ok: true };
    }

    await this.outbox.enqueue('chatwoot', event);
    return { ok: true };
  }

  private verifySignature(
    req: RawBodyRequest<FastifyRequest>,
    headers: Record<string, string>,
  ): void {
    const secret = this.config.chatwoot.webhookSecret;
    if (!secret) return; // verification disabled

    const provided = headers['x-chatwoot-signature'] ?? headers['x-hub-signature-256'];
    const raw = req.rawBody;
    if (!provided || !raw) {
      throw new ForbiddenException('Missing webhook signature');
    }

    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const normalized = provided.replace(/^sha256=/, '');

    const a = Buffer.from(expected);
    const b = Buffer.from(normalized);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException('Invalid webhook signature');
    }
  }
}

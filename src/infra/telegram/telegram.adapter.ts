import { Inject, Injectable, Logger } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/config.schema';
import {
  Capability,
  InboundAttachment,
  InboundMessage,
  MediaType,
  OutboundInteractive,
  OutboundMessage,
  SendOptions,
  SentRef,
} from '../../domain/message';
import { MessengerAdapter, OnInboundMessage } from '../../domain/ports';

export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

interface NormalizedMedia {
  fileId: string;
  type: MediaType;
  filename: string;
  contentType?: string;
}

/**
 * Telegram integration built on Telegraf. Normalizes every inbound update into a
 * channel-neutral {@link InboundMessage} and renders outbound messages back to
 * Telegram (text, media, inline keyboards), streaming media without touching disk.
 */
@Injectable()
export class TelegramAdapter implements MessengerAdapter {
  readonly channel = 'telegram';
  readonly inboxId: number;

  private readonly logger = new Logger(TelegramAdapter.name);
  private readonly bot: Telegraf;
  private handler?: OnInboundMessage;

  // Maps short callback tokens to the value echoed back to Chatwoot on tap.
  private readonly callbackValues = new Map<string, string>();
  private callbackSeq = 0;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.inboxId = config.telegram.inboxId;
    this.bot = new Telegraf(config.telegram.botToken);
    this.registerHandlers();
  }

  capabilities(): Set<Capability> {
    return new Set([Capability.Text, Capability.Media, Capability.Interactive, Capability.Reply]);
  }

  onMessage(handler: OnInboundMessage): void {
    this.handler = handler;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    const me = await this.bot.telegram.getMe();
    this.logger.log(`Telegram bot @${me.username} authorized (inbox ${this.inboxId})`);

    if (this.config.telegram.mode === 'webhook') {
      const url = `${this.config.telegram.webhookDomain}${TELEGRAM_WEBHOOK_PATH}`;
      await this.bot.telegram.setWebhook(url, {
        secret_token: this.config.telegram.webhookSecret || undefined,
        drop_pending_updates: true,
      });
      this.logger.log(`Telegram webhook set to ${url}`);
    } else {
      // Long polling. launch() resolves only when the bot stops, so do not await.
      void this.bot
        .launch({ dropPendingUpdates: true })
        .catch((err) => this.logger.error(`Telegram polling crashed: ${String(err)}`));
      this.logger.log('Telegram long polling started');
    }
  }

  async stop(): Promise<void> {
    try {
      this.bot.stop();
    } catch {
      // ignore stop errors during shutdown
    }
  }

  /** Entry point for webhook mode: feed a raw Telegram update to the bot. */
  async handleUpdate(update: Update): Promise<void> {
    await this.bot.handleUpdate(update);
  }

  // -------------------------------------------------------------------------
  // Inbound normalization
  // -------------------------------------------------------------------------

  private registerHandlers(): void {
    this.bot.on('message', async (ctx) => {
      try {
        const message = this.normalizeMessage(ctx.message as any, ctx);
        if (message && this.handler) {
          await this.handler(message);
        }
      } catch (err) {
        this.logger.error(`Failed to process inbound message: ${String(err)}`);
      }
    });

    this.bot.on('callback_query', async (ctx) => {
      try {
        await this.handleCallbackQuery(ctx);
      } catch (err) {
        this.logger.error(`Failed to process callback query: ${String(err)}`);
      }
    });
  }

  private normalizeMessage(message: any, _ctx: unknown): InboundMessage | undefined {
    if (!message?.from || !message?.chat) return undefined;

    const media = this.extractMedia(message);
    const text: string | undefined = message.text ?? message.caption ?? undefined;

    if (!media && !text) {
      // Unsupported content (e.g. location, poll); ignore for now.
      return undefined;
    }

    const attachments: InboundAttachment[] = media
      ? [
          {
            type: media.type,
            filename: media.filename,
            contentType: media.contentType,
            download: () => this.downloadFile(media.fileId),
          },
        ]
      : [];

    return {
      channel: this.channel,
      senderId: String(message.from.id),
      recipientId: String(message.chat.id),
      senderName: [message.from.first_name, message.from.last_name].filter(Boolean).join(' '),
      senderUsername: message.from.username,
      text,
      attachments,
      providerMessageId: String(message.message_id),
      replyToProviderMessageId: message.reply_to_message
        ? String(message.reply_to_message.message_id)
        : undefined,
      raw: message,
    };
  }

  /** Map any Telegram media field to a single normalized attachment descriptor. */
  private extractMedia(message: any): NormalizedMedia | undefined {
    if (message.photo?.length) {
      const largest = message.photo[message.photo.length - 1];
      return {
        fileId: largest.file_id,
        type: 'image',
        filename: `photo_${largest.file_unique_id}.jpg`,
        contentType: 'image/jpeg',
      };
    }
    if (message.document) {
      return {
        fileId: message.document.file_id,
        type: 'file',
        filename: message.document.file_name ?? `document_${message.document.file_unique_id}`,
        contentType: message.document.mime_type,
      };
    }
    if (message.video) {
      return {
        fileId: message.video.file_id,
        type: 'video',
        filename: message.video.file_name ?? `video_${message.video.file_unique_id}.mp4`,
        contentType: message.video.mime_type ?? 'video/mp4',
      };
    }
    if (message.video_note) {
      // "Кружочки": round video messages.
      return {
        fileId: message.video_note.file_id,
        type: 'video',
        filename: `video_note_${message.video_note.file_unique_id}.mp4`,
        contentType: 'video/mp4',
      };
    }
    if (message.animation) {
      return {
        fileId: message.animation.file_id,
        type: 'video',
        filename:
          message.animation.file_name ?? `animation_${message.animation.file_unique_id}.mp4`,
        contentType: message.animation.mime_type ?? 'video/mp4',
      };
    }
    if (message.voice) {
      return {
        fileId: message.voice.file_id,
        type: 'audio',
        filename: `voice_${message.voice.file_unique_id}.ogg`,
        contentType: message.voice.mime_type ?? 'audio/ogg',
      };
    }
    if (message.audio) {
      return {
        fileId: message.audio.file_id,
        type: 'audio',
        filename: message.audio.file_name ?? `audio_${message.audio.file_unique_id}.mp3`,
        contentType: message.audio.mime_type ?? 'audio/mpeg',
      };
    }
    if (message.sticker) {
      const s = message.sticker;
      const ext = s.is_video ? 'webm' : s.is_animated ? 'tgs' : 'webp';
      const type: MediaType = s.is_video ? 'video' : s.is_animated ? 'file' : 'image';
      return {
        fileId: s.file_id,
        type,
        filename: `sticker_${s.file_unique_id}.${ext}`,
        contentType: undefined,
      };
    }
    return undefined;
  }

  private async downloadFile(fileId: string): Promise<Buffer> {
    const link = await this.bot.telegram.getFileLink(fileId);
    const response = await fetch(link.href);
    if (!response.ok) {
      throw new Error(`Telegram file download failed: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private async handleCallbackQuery(ctx: any): Promise<void> {
    const data: string | undefined = ctx.callbackQuery?.data;
    const value = data ? this.callbackValues.get(data) : undefined;

    // Always acknowledge so Telegram stops the loading spinner.
    await ctx.answerCbQuery().catch(() => undefined);

    if (!value || !this.handler) return;
    const from = ctx.callbackQuery.from;
    const chat = ctx.callbackQuery.message?.chat;
    if (!from || !chat) return;

    await this.handler({
      channel: this.channel,
      senderId: String(from.id),
      recipientId: String(chat.id),
      senderName: [from.first_name, from.last_name].filter(Boolean).join(' '),
      senderUsername: from.username,
      text: value,
      attachments: [],
      providerMessageId: ctx.callbackQuery.message
        ? String(ctx.callbackQuery.message.message_id)
        : undefined,
      raw: ctx.callbackQuery,
    });
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  async sendText(recipientId: string, text: string, opts?: SendOptions): Promise<SentRef> {
    const sent = await this.bot.telegram.sendMessage(recipientId, text, {
      parse_mode: 'HTML',
      ...this.replyExtra(opts),
    });
    return { providerMessageId: String(sent.message_id) };
  }

  async sendMedia(
    recipientId: string,
    message: OutboundMessage,
    opts?: SendOptions,
  ): Promise<SentRef> {
    const attachments = message.attachments ?? [];
    let lastRef: SentRef | undefined;

    for (let i = 0; i < attachments.length; i++) {
      const attachment = attachments[i];
      // Caption goes on the first attachment only.
      const caption = i === 0 ? message.text : undefined;
      lastRef = await this.sendSingleMedia(recipientId, attachment, caption, opts);
    }

    if (!lastRef) {
      // No attachments after all; fall back to text.
      return this.sendText(recipientId, message.text ?? '', opts);
    }
    return lastRef;
  }

  private async sendSingleMedia(
    recipientId: string,
    attachment: NonNullable<OutboundMessage['attachments']>[number],
    caption: string | undefined,
    opts?: SendOptions,
  ): Promise<SentRef> {
    const extra = {
      caption,
      parse_mode: 'HTML' as const,
      ...this.replyExtra(opts),
    };

    try {
      // First try letting Telegram fetch the (public) Chatwoot URL directly.
      return await this.dispatchMedia(recipientId, attachment.type, attachment.url, extra);
    } catch (err) {
      this.logger.warn(`Sending media by URL failed (${String(err)}); falling back to upload`);
    }

    if (attachment.fetch) {
      try {
        const buffer = await attachment.fetch();
        return await this.dispatchMedia(
          recipientId,
          attachment.type,
          { source: buffer, filename: attachment.filename },
          extra,
        );
      } catch (err) {
        this.logger.warn(`Uploading media failed (${String(err)}); sending link instead`);
      }
    }

    // Last resort: send the link as text so the message is not lost.
    const linkText = [caption, attachment.url].filter(Boolean).join('\n');
    return this.sendText(recipientId, linkText, opts);
  }

  private async dispatchMedia(
    recipientId: string,
    type: MediaType,
    media: any,
    extra: any,
  ): Promise<SentRef> {
    let sent;
    switch (type) {
      case 'image':
        sent = await this.bot.telegram.sendPhoto(recipientId, media, extra);
        break;
      case 'video':
        sent = await this.bot.telegram.sendVideo(recipientId, media, extra);
        break;
      case 'audio':
        sent = await this.bot.telegram.sendAudio(recipientId, media, extra);
        break;
      default:
        sent = await this.bot.telegram.sendDocument(recipientId, media, extra);
        break;
    }
    return { providerMessageId: String(sent.message_id) };
  }

  async sendInteractive(
    recipientId: string,
    interactive: OutboundInteractive,
    opts?: SendOptions,
  ): Promise<SentRef> {
    const inlineKeyboard = interactive.buttons.map((button) => {
      if (button.url) {
        return [{ text: button.title, url: button.url }];
      }
      const token = this.storeCallbackValue(button.value);
      return [{ text: button.title, callback_data: token }];
    });

    const sent = await this.bot.telegram.sendMessage(recipientId, interactive.text || '\u2063', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard },
      ...this.replyExtra(opts),
    });
    return { providerMessageId: String(sent.message_id) };
  }

  private storeCallbackValue(value: string): string {
    const token = `a2c:${this.callbackSeq++}`;
    this.callbackValues.set(token, value);
    // Keep the map bounded.
    if (this.callbackValues.size > 5_000) {
      const oldest = this.callbackValues.keys().next().value;
      if (oldest !== undefined) this.callbackValues.delete(oldest);
    }
    return token;
  }

  private replyExtra(opts?: SendOptions): Record<string, unknown> {
    if (!opts?.replyToProviderMessageId) return {};
    const messageId = Number(opts.replyToProviderMessageId);
    if (!Number.isFinite(messageId)) return {};
    return { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } };
  }
}

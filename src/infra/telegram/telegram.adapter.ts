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

/** A single callback button's payload, kept so a tap can be echoed and reflected. */
interface CallbackEntry {
  /** Value posted back to Chatwoot when the button is tapped. */
  value: string;
  /** Human-readable label shown on the button (used to reflect the choice). */
  title: string;
  /** Key of the prompt this button belongs to: `${chatId}:${messageId}`. */
  promptKey?: string;
}

/** A sent interactive message, tracked so its keyboard can be collapsed on reply. */
interface InteractivePrompt {
  /** Original (already rendered) message text, so we can re-render on collapse. */
  text: string;
  /** Callback tokens of every button in this prompt. */
  tokens: string[];
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

  // Maps short callback tokens to the button payload echoed back to Chatwoot on tap.
  private readonly callbackTokens = new Map<string, CallbackEntry>();
  // Tracks sent interactive prompts by `${chatId}:${messageId}` so their inline
  // keyboard can be collapsed once any option is chosen.
  private readonly prompts = new Map<string, InteractivePrompt>();
  private callbackSeq = 0;

  // Upper bound for the in-memory callback/prompt maps; oldest entries are evicted.
  private static readonly MAX_TRACKED = 5_000;
  // Prefix shown in front of the chosen option after a tap.
  private static readonly SELECTED_MARK = '\u2705'; // ✅

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
    const entry = data ? this.callbackTokens.get(data) : undefined;
    const message = ctx.callbackQuery?.message;

    // Always acknowledge so Telegram stops the loading spinner.
    await ctx.answerCbQuery().catch(() => undefined);

    // Collapse the keyboard so the options can no longer be tapped, mirroring the
    // native behavior of single-choice prompts. Chatwoot itself never edits the
    // message, so the bridge has to do it. Best-effort: never block the relay.
    if (message) {
      await this.collapsePrompt(ctx, message, entry).catch((err) =>
        this.logger.warn(`Failed to collapse interactive keyboard: ${String(err)}`),
      );
    }

    if (!entry || !this.handler) return;
    const from = ctx.callbackQuery.from;
    const chat = message?.chat;
    if (!from || !chat) return;

    await this.handler({
      channel: this.channel,
      senderId: String(from.id),
      recipientId: String(chat.id),
      senderName: [from.first_name, from.last_name].filter(Boolean).join(' '),
      senderUsername: from.username,
      text: entry.value,
      attachments: [],
      providerMessageId: message ? String(message.message_id) : undefined,
      raw: ctx.callbackQuery,
    });
  }

  /**
   * Remove the inline keyboard of a tapped prompt. When we still know the prompt
   * (not lost to a restart), re-render the original text with the chosen option
   * appended so the customer keeps a record of their selection; otherwise just
   * strip the buttons so a stale keyboard cannot be tapped again.
   */
  private async collapsePrompt(ctx: any, message: any, entry?: CallbackEntry): Promise<void> {
    const promptKey = `${message.chat?.id}:${message.message_id}`;
    const prompt = this.prompts.get(promptKey);

    if (prompt && entry) {
      const selected = `${TelegramAdapter.SELECTED_MARK} ${this.escapeHtml(entry.title)}`;
      const base = prompt.text.trim();
      const newText = base ? `${base}\n\n${selected}` : selected;
      this.forgetPrompt(promptKey);
      // Editing the text and omitting reply_markup also removes the keyboard.
      await ctx.editMessageText(newText, { parse_mode: 'HTML' });
      return;
    }

    // Unknown/stale prompt: at least drop the keyboard (empty inline_keyboard).
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  }

  /** Drop a prompt and all of its callback tokens once it has been answered. */
  private forgetPrompt(promptKey: string): void {
    const prompt = this.prompts.get(promptKey);
    if (!prompt) return;
    for (const token of prompt.tokens) this.callbackTokens.delete(token);
    this.prompts.delete(promptKey);
  }

  private escapeHtml(input: string): string {
    return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    const tokens: string[] = [];
    const inlineKeyboard = interactive.buttons.map((button) => {
      if (button.url) {
        // Link buttons never emit a callback_query, so they need no tracking.
        return [{ text: button.title, url: button.url }];
      }
      const token = this.storeCallbackValue(button.value, button.title);
      tokens.push(token);
      return [{ text: button.title, callback_data: token }];
    });

    const sent = await this.bot.telegram.sendMessage(recipientId, interactive.text || '\u2063', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard },
      ...this.replyExtra(opts),
    });

    // Remember the prompt so the keyboard can be collapsed when a button is tapped.
    if (tokens.length > 0) {
      const promptKey = `${recipientId}:${sent.message_id}`;
      for (const token of tokens) {
        const stored = this.callbackTokens.get(token);
        if (stored) stored.promptKey = promptKey;
      }
      this.prompts.set(promptKey, { text: interactive.text ?? '', tokens });
      this.evictOldest(this.prompts, (key) => this.forgetPrompt(key));
    }

    return { providerMessageId: String(sent.message_id) };
  }

  private storeCallbackValue(value: string, title: string): string {
    const token = `a2c:${this.callbackSeq++}`;
    this.callbackTokens.set(token, { value, title });
    this.evictOldest(this.callbackTokens, (key) => this.callbackTokens.delete(key));
    return token;
  }

  /** Keep an insertion-ordered map bounded by evicting the oldest entry. */
  private evictOldest(map: Map<string, unknown>, evict: (key: string) => void): void {
    if (map.size <= TelegramAdapter.MAX_TRACKED) return;
    const oldest = map.keys().next().value;
    if (oldest !== undefined) evict(oldest);
  }

  private replyExtra(opts?: SendOptions): Record<string, unknown> {
    if (!opts?.replyToProviderMessageId) return {};
    const messageId = Number(opts.replyToProviderMessageId);
    if (!Number.isFinite(messageId)) return {};
    return { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } };
  }
}

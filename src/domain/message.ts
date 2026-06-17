/**
 * Channel-agnostic message model shared across the application.
 *
 * Adapters normalize provider-specific updates into these structures, and the
 * application layer renders these structures back into provider-specific calls.
 * Keeping this model free of any messenger/Chatwoot detail is what makes the
 * bridge pluggable for new messengers (MAX, WhatsApp, VK, ...).
 */

/** A messenger channel identifier, e.g. `telegram`, `whatsapp`. */
export type Channel = string;

/** Optional features an adapter can advertise so the core can degrade gracefully. */
export enum Capability {
  Text = 'text',
  Media = 'media',
  Interactive = 'interactive',
  Reply = 'reply',
}

/**
 * Attachment type understood by Chatwoot. We normalize every provider media kind
 * (photo, document, voice, video note, sticker, ...) into one of these.
 */
export type MediaType = 'image' | 'audio' | 'video' | 'file';

/**
 * Inbound attachment (messenger -> Chatwoot). The bytes are fetched lazily via
 * {@link download} and streamed straight to Chatwoot; nothing is persisted to disk.
 */
export interface InboundAttachment {
  type: MediaType;
  filename: string;
  contentType?: string;
  download: () => Promise<Buffer>;
}

/** A normalized message coming from a messenger towards Chatwoot. */
export interface InboundMessage {
  channel: Channel;
  /** Stable provider id of the end user (e.g. Telegram user id). */
  senderId: string;
  /** Provider chat id used to deliver replies back (for Telegram DM equals senderId). */
  recipientId: string;
  senderName?: string;
  senderUsername?: string;
  text?: string;
  attachments: InboundAttachment[];
  /** Provider message id of this message (used to build reply maps). */
  providerMessageId?: string;
  /** Provider message id this message replies to, if any. */
  replyToProviderMessageId?: string;
  raw?: unknown;
}

/** Outbound attachment (Chatwoot -> messenger). */
export interface OutboundAttachment {
  type: MediaType;
  /** Publicly reachable URL (Chatwoot `data_url`). Adapters try this first. */
  url: string;
  filename?: string;
  /** Fallback byte fetch when the URL cannot be sent directly. */
  fetch?: () => Promise<Buffer>;
}

/** Interactive prompt (Chatwoot `input_select`/`cards`) mapped to messenger buttons. */
export interface OutboundInteractive {
  text: string;
  buttons: OutboundButton[];
}

export interface OutboundButton {
  title: string;
  /** Value echoed back to Chatwoot as an incoming message when the user taps it. */
  value: string;
  /** Optional link button instead of a callback button. */
  url?: string;
}

/** A normalized message going from Chatwoot towards a messenger. */
export interface OutboundMessage {
  channel: Channel;
  recipientId: string;
  /** Already rendered to the messenger's markup (e.g. Telegram HTML). */
  text?: string;
  attachments?: OutboundAttachment[];
  interactive?: OutboundInteractive;
  replyToProviderMessageId?: string;
}

/** Options accepted by adapter send methods. */
export interface SendOptions {
  replyToProviderMessageId?: string;
  /** Parse mode hint; adapters may ignore it. */
  parseMode?: 'HTML' | 'MarkdownV2';
}

/** Reference returned after a successful send, used for reply threading. */
export interface SentRef {
  providerMessageId: string;
}

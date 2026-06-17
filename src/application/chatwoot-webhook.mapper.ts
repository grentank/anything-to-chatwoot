import { MediaType, OutboundInteractive } from '../domain/message';
import { ChatwootWebhookEvent } from '../infra/chatwoot/chatwoot.types';
import { escapeHtml, markdownToTelegramHtml } from './formatter';

/**
 * Pure mapping from a Chatwoot `message_created` webhook into a transport-neutral
 * plan describing what (if anything) to deliver to the messenger. Kept free of
 * I/O so it is straightforward to unit test.
 */

export type OutboundPlanKind = 'text' | 'media' | 'interactive' | 'skip';

export interface OutboundPlanAttachment {
  type: MediaType;
  url: string;
}

export interface OutboundPlan {
  kind: OutboundPlanKind;
  reason?: string;
  text?: string;
  attachments?: OutboundPlanAttachment[];
  interactive?: OutboundInteractive;
  /** Chatwoot message id this message replies to. */
  inReplyTo?: number;
}

const SKIP = (reason: string): OutboundPlan => ({ kind: 'skip', reason });

/** Chatwoot sometimes sends numeric message types; normalize to a string. */
export function normalizeMessageType(value: string | number | undefined): string {
  if (typeof value === 'number') {
    return { 0: 'incoming', 1: 'outgoing', 2: 'activity', 3: 'template' }[value] ?? 'unknown';
  }
  return value ?? 'unknown';
}

export function mapAttachmentType(fileType: string | undefined): MediaType {
  switch (fileType) {
    case 'image':
      return 'image';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    default:
      return 'file';
  }
}

export interface PlanOptions {
  forwardSystemMessages: boolean;
}

export function planOutbound(event: ChatwootWebhookEvent, options: PlanOptions): OutboundPlan {
  if (event.event !== 'message_created') {
    return SKIP(`unsupported event: ${event.event}`);
  }

  // Internal/private notes must never reach the customer.
  if (event.private) {
    return SKIP('private note');
  }

  const messageType = normalizeMessageType(event.message_type);

  // Incoming messages are what we created from the messenger; do not echo them.
  if (messageType === 'incoming') {
    return SKIP('incoming message (echo)');
  }

  if (messageType === 'activity') {
    if (options.forwardSystemMessages && event.content) {
      return { kind: 'text', text: escapeHtml(event.content), inReplyTo: undefined };
    }
    return SKIP('system/activity message (disabled)');
  }

  if (messageType !== 'outgoing' && messageType !== 'template') {
    return SKIP(`unhandled message_type: ${messageType}`);
  }

  const inReplyTo = event.content_attributes?.in_reply_to;

  // Interactive content (buttons / forms).
  const interactive = buildInteractive(event);
  if (interactive) {
    return { kind: 'interactive', interactive, inReplyTo };
  }

  const attachments = (event.attachments ?? [])
    .filter((a) => !!a.data_url)
    .map((a) => ({ type: mapAttachmentType(a.file_type), url: a.data_url as string }));

  const text = event.content ? markdownToTelegramHtml(event.content) : undefined;

  if (attachments.length > 0) {
    return { kind: 'media', text, attachments, inReplyTo };
  }

  if (text) {
    return { kind: 'text', text, inReplyTo };
  }

  return SKIP('no deliverable content');
}

function buildInteractive(event: ChatwootWebhookEvent): OutboundInteractive | undefined {
  const items = event.content_attributes?.items ?? [];

  if (event.content_type === 'input_select' && items.length > 0) {
    return {
      text: event.content ? markdownToTelegramHtml(event.content) : '',
      buttons: items
        .filter((i) => i.title && i.value)
        .map((i) => ({ title: i.title as string, value: i.value as string })),
    };
  }

  if (event.content_type === 'cards') {
    // Cards carry per-item actions (link/postback). Flatten them into buttons.
    const rawItems = (event.content_attributes as { items?: any[] } | undefined)?.items ?? [];
    const buttons = rawItems.flatMap((card: any) =>
      (card?.actions ?? [])
        .map((action: any) => {
          if (action?.type === 'link' && action?.uri) {
            return { title: String(action.text ?? action.uri), value: '', url: String(action.uri) };
          }
          if (action?.type === 'postback' && action?.payload) {
            return { title: String(action.text ?? action.payload), value: String(action.payload) };
          }
          return undefined;
        })
        .filter(Boolean),
    );
    if (buttons.length > 0) {
      const title = rawItems
        .map((c: any) => [c?.title, c?.description].filter(Boolean).join(' - '))
        .filter(Boolean)
        .join('\n');
      const text = [event.content, title].filter(Boolean).join('\n');
      return { text: markdownToTelegramHtml(text), buttons };
    }
  }

  return undefined;
}

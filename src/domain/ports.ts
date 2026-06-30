/**
 * Ports (interfaces) that decouple the application core from concrete
 * infrastructure (messengers, Chatwoot HTTP client, storage, queue).
 *
 * Each port has a DI token so Nest can inject an implementation without the
 * core depending on it directly. Swapping the in-memory store for SQLite/Redis
 * later is just a matter of providing a different class for the same token.
 */
import {
  Capability,
  Channel,
  InboundMessage,
  OutboundInteractive,
  OutboundMessage,
  SendOptions,
  SentRef,
} from './message';

// ---------------------------------------------------------------------------
// Messenger adapter port
// ---------------------------------------------------------------------------

export const MESSENGER_ADAPTERS = Symbol('MESSENGER_ADAPTERS');

export type OnInboundMessage = (message: InboundMessage) => Promise<void>;

/**
 * Contract every messenger integration implements. A new messenger only needs
 * a class implementing this interface plus its own config block.
 */
export interface MessengerAdapter {
  /** Unique channel key, e.g. `telegram`. Must match {@link OutboundMessage.channel}. */
  readonly channel: Channel;
  /** Chatwoot API-channel inbox id this adapter is wired to. */
  readonly inboxId: number;

  start(): Promise<void>;
  stop(): Promise<void>;

  /** Register the handler invoked for every inbound message from this messenger. */
  onMessage(handler: OnInboundMessage): void;

  sendText(recipientId: string, text: string, opts?: SendOptions): Promise<SentRef>;
  sendMedia(recipientId: string, media: OutboundMessage, opts?: SendOptions): Promise<SentRef>;
  sendInteractive(
    recipientId: string,
    interactive: OutboundInteractive,
    opts?: SendOptions,
  ): Promise<SentRef>;

  capabilities(): Set<Capability>;
}

// ---------------------------------------------------------------------------
// Contact identity port (per-channel contact shaping)
// ---------------------------------------------------------------------------

export const CONTACT_IDENTITY_STRATEGIES = Symbol('CONTACT_IDENTITY_STRATEGIES');

/**
 * Builds the {@link ContactSpec} for one channel's inbound message: how to look
 * the contact up, and how to shape it on creation (identifier, source id, custom
 * and additional attributes). A new messenger either relies on the generic
 * default or contributes its own strategy to {@link CONTACT_IDENTITY_STRATEGIES}.
 */
export interface ContactIdentityStrategy {
  /** Channel this strategy applies to; must match {@link InboundMessage.channel}. */
  readonly channel: Channel;
  build(message: InboundMessage): ContactSpec;
}

// ---------------------------------------------------------------------------
// Chatwoot port
// ---------------------------------------------------------------------------

export const CHATWOOT_PORT = Symbol('CHATWOOT_PORT');

export interface ChatwootContactRef {
  id: number;
  /** `source_id` of the contact_inbox tying the contact to our inbox. */
  sourceId: string;
}

export type ContactFilterOperator = 'equal_to' | 'not_equal_to' | 'contains' | 'does_not_contain';

/** A single predicate for Chatwoot `POST /contacts/filter`. */
export interface ContactFilterQuery {
  /** Attribute name, e.g. a custom attribute key `telegram_user_id` or standard `identifier`. */
  attributeKey: string;
  filterOperator: ContactFilterOperator;
  values: string[];
}

/**
 * Channel-neutral description of how to find and (only if missing) create the
 * Chatwoot contact for an inbound sender. Built per channel by a
 * {@link ContactIdentityStrategy}, consumed by the {@link ChatwootPort}.
 *
 * The bridge never overwrites an existing contact's `identifier`: a contact that
 * already lives in the CRM may carry its own `auth_id` there. `identifier` below
 * is therefore only applied when the contact is created by the bridge.
 */
export interface ContactSpec {
  /** Lookup predicates tried in order; the first that matches an existing contact wins. */
  lookup: ContactFilterQuery[];
  /** `identifier` for a brand-new contact only (e.g. `telegram:123456`). */
  identifier: string;
  name?: string;
  /** `source_id` tying the contact to our inbox and reused when creating the conversation. */
  sourceId: string;
  customAttributes: Record<string, unknown>;
  additionalAttributes: Record<string, unknown>;
}

export interface EnsureContactInput {
  /** Chatwoot inbox this bridge instance is wired to for the sender's channel. */
  inboxId: number;
  spec: ContactSpec;
}

export interface EnsureConversationInput {
  inboxId: number;
  contactId: number;
  sourceId: string;
}

export interface ChatwootOutboundAttachment {
  filename: string;
  contentType?: string;
  data: Buffer;
}

export interface CreateIncomingMessageInput {
  conversationId: number;
  content?: string;
  /** Chatwoot message id this message is a reply to. */
  inReplyTo?: number;
  attachments?: ChatwootOutboundAttachment[];
}

export interface ChatwootMessageRef {
  id: number;
}

export interface ChatwootPort {
  ensureContact(input: EnsureContactInput): Promise<ChatwootContactRef>;
  ensureConversation(input: EnsureConversationInput): Promise<number>;
  createIncomingMessage(input: CreateIncomingMessageInput): Promise<ChatwootMessageRef>;
  /** Download an attachment by URL (with auth) when it cannot be sent by URL. */
  fetchAttachment(url: string): Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Repository port (mappings cache)
// ---------------------------------------------------------------------------

export const REPOSITORY_PORT = Symbol('REPOSITORY_PORT');

/** Links a messenger user/chat to its Chatwoot contact + conversation. */
export interface ConversationLink {
  channel: Channel;
  senderId: string;
  recipientId: string;
  contactId: number;
  sourceId: string;
  conversationId: number;
}

export interface RepositoryPort {
  getLinkBySender(channel: Channel, senderId: string): ConversationLink | undefined;
  getLinkByConversation(conversationId: number): ConversationLink | undefined;
  saveLink(link: ConversationLink): void;

  /** Record a Chatwoot <-> provider message id pair for reply threading. */
  mapMessage(channel: Channel, chatwootMessageId: number, providerMessageId: string): void;
  getProviderMessageId(channel: Channel, chatwootMessageId: number): string | undefined;
  getChatwootMessageId(channel: Channel, providerMessageId: string): number | undefined;
}

// ---------------------------------------------------------------------------
// Outbox port (delivery queue)
// ---------------------------------------------------------------------------

export const OUTBOX_PORT = Symbol('OUTBOX_PORT');

export interface OutboxJob<T = unknown> {
  id: string;
  channel: Channel;
  payload: T;
  attempts: number;
  /** Epoch millis after which the job is eligible for processing. */
  nextAttemptAt: number;
}

export interface OutboxPort {
  enqueue<T>(channel: Channel, payload: T): Promise<void>;
  /** Return jobs whose `nextAttemptAt <= now`, marking them as leased. */
  pullDue(now: number, limit: number): Promise<OutboxJob[]>;
  markDone(id: string): Promise<void>;
  /** Increase attempts and set the next attempt time (retry). */
  reschedule(id: string, nextAttemptAt: number): Promise<void>;
  /** Drop a job permanently after exhausting retries. */
  markFailed(id: string): Promise<void>;
  size(): number;
}

// ---------------------------------------------------------------------------
// Dedup port
// ---------------------------------------------------------------------------

export const DEDUP_PORT = Symbol('DEDUP_PORT');

export interface DedupPort {
  /** Returns true the first time a key is seen, false on subsequent calls. */
  firstSeen(key: string): boolean;
}

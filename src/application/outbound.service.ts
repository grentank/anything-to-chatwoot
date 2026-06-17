import { Inject, Injectable, Logger } from '@nestjs/common';
import { KeyedMutex } from '../common/keyed-mutex';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/config.schema';
import { OutboundAttachment, OutboundMessage, SendOptions, SentRef } from '../domain/message';
import {
  ChatwootPort,
  CHATWOOT_PORT,
  MessengerAdapter,
  RepositoryPort,
  REPOSITORY_PORT,
} from '../domain/ports';
import { ChatwootWebhookEvent } from '../infra/chatwoot/chatwoot.types';
import { MessengerRegistry } from './messenger-registry';
import { OutboundPlan, planOutbound } from './chatwoot-webhook.mapper';

/**
 * Chatwoot -> messenger. Turns a Chatwoot webhook event into a delivery to the
 * right messenger, resolving the recipient and reply target along the way.
 *
 * Throwing from {@link process} signals the outbox worker to retry.
 */
@Injectable()
export class OutboundService {
  private readonly logger = new Logger(OutboundService.name);
  private readonly mutex = new KeyedMutex();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CHATWOOT_PORT) private readonly chatwoot: ChatwootPort,
    @Inject(REPOSITORY_PORT) private readonly repo: RepositoryPort,
    private readonly registry: MessengerRegistry,
  ) {}

  async process(event: ChatwootWebhookEvent): Promise<void> {
    const adapter = this.registry.getByInboxId(event.inbox?.id);
    if (!adapter) {
      this.logger.debug(`No adapter for inbox ${event.inbox?.id}; skipping`);
      return;
    }

    const plan = planOutbound(event, {
      forwardSystemMessages: this.config.forwardSystemMessages,
    });
    if (plan.kind === 'skip') {
      this.logger.debug(`Skipping outbound message ${event.id}: ${plan.reason}`);
      return;
    }

    const recipientId = this.resolveRecipient(adapter, event);
    if (!recipientId) {
      this.logger.warn(`Cannot resolve recipient for conversation ${event.conversation?.id}`);
      return;
    }

    const conversationKey = `${adapter.channel}|${event.conversation?.id ?? recipientId}`;
    await this.mutex.runExclusive(conversationKey, () =>
      this.deliver(adapter, recipientId, plan, event),
    );
  }

  private async deliver(
    adapter: MessengerAdapter,
    recipientId: string,
    plan: OutboundPlan,
    event: ChatwootWebhookEvent,
  ): Promise<void> {
    const opts: SendOptions = {
      replyToProviderMessageId: plan.inReplyTo
        ? this.repo.getProviderMessageId(adapter.channel, plan.inReplyTo)
        : undefined,
      parseMode: 'HTML',
    };

    let sent: SentRef;
    switch (plan.kind) {
      case 'text':
        sent = await adapter.sendText(recipientId, plan.text ?? '', opts);
        break;
      case 'interactive':
        sent = await adapter.sendInteractive(recipientId, plan.interactive!, opts);
        break;
      case 'media': {
        const outbound: OutboundMessage = {
          channel: adapter.channel,
          recipientId,
          text: plan.text,
          attachments: (plan.attachments ?? []).map<OutboundAttachment>((a) => ({
            type: a.type,
            url: a.url,
            fetch: () => this.chatwoot.fetchAttachment(a.url),
          })),
        };
        sent = await adapter.sendMedia(recipientId, outbound, opts);
        break;
      }
      default:
        return;
    }

    if (event.id) {
      this.repo.mapMessage(adapter.channel, event.id, sent.providerMessageId);
    }
  }

  /** Resolve the messenger recipient id from the cache or the webhook payload. */
  private resolveRecipient(
    adapter: MessengerAdapter,
    event: ChatwootWebhookEvent,
  ): string | undefined {
    const conversationId = event.conversation?.id;
    if (conversationId !== undefined) {
      const link = this.repo.getLinkByConversation(conversationId);
      if (link) return link.recipientId;
    }

    // Fall back to the contact identifier we set on creation, e.g. `telegram:123`.
    const identifier = event.conversation?.meta?.sender?.identifier ?? event.sender?.identifier;
    const recipientId = this.recipientFromIdentifier(adapter.channel, identifier);

    // Best-effort cache so subsequent messages skip the lookup.
    if (recipientId && conversationId !== undefined) {
      this.repo.saveLink({
        channel: adapter.channel,
        senderId: recipientId,
        recipientId,
        contactId: event.conversation?.meta?.sender?.id ?? 0,
        sourceId: event.source_id ?? '',
        conversationId,
      });
    }
    return recipientId;
  }

  private recipientFromIdentifier(channel: string, identifier?: string): string | undefined {
    if (!identifier) return undefined;
    const prefix = `${channel}:`;
    return identifier.startsWith(prefix) ? identifier.slice(prefix.length) : identifier;
  }
}

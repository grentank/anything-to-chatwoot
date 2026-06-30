import { Inject, Injectable, Logger } from '@nestjs/common';
import { KeyedMutex } from '../common/keyed-mutex';
import { InboundMessage } from '../domain/message';
import {
  ChatwootOutboundAttachment,
  ChatwootPort,
  CHATWOOT_PORT,
  ConversationLink,
  MessengerAdapter,
  MESSENGER_ADAPTERS,
  RepositoryPort,
  REPOSITORY_PORT,
} from '../domain/ports';
import { ContactIdentityRegistry } from './contact-identity';

/**
 * Messenger -> Chatwoot. Ensures the contact + conversation exist, then posts the
 * incoming message (with any attachments streamed through) into Chatwoot.
 */
@Injectable()
export class InboundService {
  private readonly logger = new Logger(InboundService.name);
  private readonly mutex = new KeyedMutex();
  private readonly inboxByChannel = new Map<string, number>();

  constructor(
    @Inject(CHATWOOT_PORT) private readonly chatwoot: ChatwootPort,
    @Inject(REPOSITORY_PORT) private readonly repo: RepositoryPort,
    private readonly identities: ContactIdentityRegistry,
    @Inject(MESSENGER_ADAPTERS) adapters: MessengerAdapter[],
  ) {
    for (const adapter of adapters) {
      this.inboxByChannel.set(adapter.channel, adapter.inboxId);
    }
  }

  async handle(message: InboundMessage): Promise<void> {
    // Serialize per sender so a conversation is created at most once and the
    // message ordering within a chat is preserved.
    await this.mutex.runExclusive(`${message.channel}|${message.senderId}`, () =>
      this.process(message),
    );
  }

  private async process(message: InboundMessage): Promise<void> {
    const link = await this.resolveLink(message);

    const inReplyTo = message.replyToProviderMessageId
      ? this.repo.getChatwootMessageId(message.channel, message.replyToProviderMessageId)
      : undefined;

    const attachments = await this.downloadAttachments(message);

    const created = await this.chatwoot.createIncomingMessage({
      conversationId: link.conversationId,
      content: message.text,
      inReplyTo,
      attachments,
    });

    if (message.providerMessageId) {
      this.repo.mapMessage(message.channel, created.id, message.providerMessageId);
    }

    this.logger.debug(
      `Relayed ${message.channel} message from ${message.senderId} to conversation ${link.conversationId}`,
    );
  }

  /** Find (cache) or create the Chatwoot contact + conversation for this sender. */
  private async resolveLink(message: InboundMessage): Promise<ConversationLink> {
    const cached = this.repo.getLinkBySender(message.channel, message.senderId);
    if (cached) return cached;

    const inboxId = this.inboxIdFor(message);
    const spec = this.identities.build(message);

    const contact = await this.chatwoot.ensureContact({ inboxId, spec });

    const conversationId = await this.chatwoot.ensureConversation({
      inboxId,
      contactId: contact.id,
      sourceId: contact.sourceId,
    });

    const link: ConversationLink = {
      channel: message.channel,
      senderId: message.senderId,
      recipientId: message.recipientId,
      contactId: contact.id,
      sourceId: contact.sourceId,
      conversationId,
    };
    this.repo.saveLink(link);
    return link;
  }

  private async downloadAttachments(
    message: InboundMessage,
  ): Promise<ChatwootOutboundAttachment[]> {
    const result: ChatwootOutboundAttachment[] = [];
    for (const attachment of message.attachments) {
      try {
        const data = await attachment.download();
        result.push({ filename: attachment.filename, contentType: attachment.contentType, data });
      } catch (err) {
        this.logger.warn(`Failed to fetch attachment ${attachment.filename}: ${String(err)}`);
      }
    }
    return result;
  }

  /** Resolve which Chatwoot inbox a channel's messages belong to. */
  private inboxIdFor(message: InboundMessage): number {
    const inboxId = this.inboxByChannel.get(message.channel);
    if (inboxId === undefined) {
      throw new Error(`No inbox configured for channel '${message.channel}'`);
    }
    return inboxId;
  }
}

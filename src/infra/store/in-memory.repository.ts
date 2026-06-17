import { Injectable } from '@nestjs/common';
import { Channel } from '../../domain/message';
import { ConversationLink, RepositoryPort } from '../../domain/ports';

/**
 * In-memory implementation of {@link RepositoryPort}.
 *
 * Chatwoot remains the source of truth; these maps are a cache/optimization and
 * the reply-threading index. A durable backend (SQLite/Redis) can later
 * implement the same port without touching the application layer.
 */
@Injectable()
export class InMemoryRepository implements RepositoryPort {
  private readonly linksBySender = new Map<string, ConversationLink>();
  private readonly linksByConversation = new Map<number, ConversationLink>();

  // channel|chatwootMessageId -> providerMessageId
  private readonly chatwootToProvider = new Map<string, string>();
  // channel|providerMessageId -> chatwootMessageId
  private readonly providerToChatwoot = new Map<string, number>();

  private senderKey(channel: Channel, senderId: string): string {
    return `${channel}|${senderId}`;
  }

  getLinkBySender(channel: Channel, senderId: string): ConversationLink | undefined {
    return this.linksBySender.get(this.senderKey(channel, senderId));
  }

  getLinkByConversation(conversationId: number): ConversationLink | undefined {
    return this.linksByConversation.get(conversationId);
  }

  saveLink(link: ConversationLink): void {
    this.linksBySender.set(this.senderKey(link.channel, link.senderId), link);
    this.linksByConversation.set(link.conversationId, link);
  }

  mapMessage(channel: Channel, chatwootMessageId: number, providerMessageId: string): void {
    this.chatwootToProvider.set(`${channel}|${chatwootMessageId}`, providerMessageId);
    this.providerToChatwoot.set(`${channel}|${providerMessageId}`, chatwootMessageId);
  }

  getProviderMessageId(channel: Channel, chatwootMessageId: number): string | undefined {
    return this.chatwootToProvider.get(`${channel}|${chatwootMessageId}`);
  }

  getChatwootMessageId(channel: Channel, providerMessageId: string): number | undefined {
    return this.providerToChatwoot.get(`${channel}|${providerMessageId}`);
  }
}

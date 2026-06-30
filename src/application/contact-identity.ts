import { Inject, Injectable, Optional } from '@nestjs/common';
import { Channel, InboundMessage } from '../domain/message';
import { CONTACT_IDENTITY_STRATEGIES, ContactIdentityStrategy, ContactSpec } from '../domain/ports';

/** Drop `undefined`/`null`/empty-string entries so we never send noise to Chatwoot. */
export function pruneEmpty<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as T;
}

/**
 * Generic, channel-agnostic contact shaping used when a channel has no dedicated
 * {@link ContactIdentityStrategy}. Everything is derived from the channel name
 * and the normalized sender fields, so a brand-new messenger works out of the box:
 *
 *  - lookup:     custom attribute `${channel}_user_id` equals the sender id
 *  - identifier: `${channel}:${senderId}` (applied to NEW contacts only)
 *  - source_id:  the sender id
 *  - custom:     `${channel}_user_id`, `${channel}_username`
 */
export function buildGenericContactSpec(message: InboundMessage): ContactSpec {
  const { channel, senderId, senderName, senderUsername } = message;
  const identifier = `${channel}:${senderId}`;

  return {
    lookup: [
      {
        attributeKey: `${channel}_user_id`,
        filterOperator: 'equal_to',
        values: [senderId],
      },
    ],
    identifier,
    name: senderName || senderUsername || identifier,
    sourceId: senderId,
    customAttributes: pruneEmpty({
      [`${channel}_user_id`]: senderId,
      [`${channel}_username`]: senderUsername,
    }),
    additionalAttributes: {},
  };
}

/**
 * Resolves the {@link ContactIdentityStrategy} for a channel, falling back to
 * {@link buildGenericContactSpec}. Channel-specific strategies are contributed to
 * the {@link CONTACT_IDENTITY_STRATEGIES} multi-provider, so adding one for a new
 * messenger requires no change here.
 */
@Injectable()
export class ContactIdentityRegistry {
  private readonly byChannel = new Map<Channel, ContactIdentityStrategy>();

  constructor(
    @Optional()
    @Inject(CONTACT_IDENTITY_STRATEGIES)
    strategies: ContactIdentityStrategy[] = [],
  ) {
    for (const strategy of strategies) {
      this.byChannel.set(strategy.channel, strategy);
    }
  }

  build(message: InboundMessage): ContactSpec {
    const strategy = this.byChannel.get(message.channel);
    return strategy ? strategy.build(message) : buildGenericContactSpec(message);
  }
}

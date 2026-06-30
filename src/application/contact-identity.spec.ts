import { describe, expect, it } from 'vitest';
import { InboundMessage } from '../domain/message';
import { ContactIdentityStrategy } from '../domain/ports';
import { ContactIdentityRegistry, buildGenericContactSpec, pruneEmpty } from './contact-identity';

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'telegram',
    senderId: '123',
    recipientId: '123',
    senderName: 'Alice',
    senderUsername: 'alice',
    attachments: [],
    ...overrides,
  };
}

describe('pruneEmpty', () => {
  it('drops undefined, null and empty-string values', () => {
    expect(pruneEmpty({ a: '1', b: undefined, c: null, d: '', e: 0 })).toEqual({ a: '1', e: 0 });
  });
});

describe('buildGenericContactSpec', () => {
  it('derives lookup, identifier, source id and custom attributes from the channel', () => {
    const spec = buildGenericContactSpec(message());

    expect(spec.lookup).toEqual([
      { attributeKey: 'telegram_user_id', filterOperator: 'equal_to', values: ['123'] },
    ]);
    expect(spec.identifier).toBe('telegram:123');
    expect(spec.sourceId).toBe('123');
    expect(spec.name).toBe('Alice');
    expect(spec.customAttributes).toEqual({
      telegram_user_id: '123',
      telegram_username: 'alice',
    });
    expect(spec.additionalAttributes).toEqual({});
  });

  it('omits a missing username and falls back to identifier for the name', () => {
    const spec = buildGenericContactSpec(
      message({ senderName: undefined, senderUsername: undefined }),
    );

    expect(spec.customAttributes).toEqual({ telegram_user_id: '123' });
    expect(spec.name).toBe('telegram:123');
  });

  it('works for an arbitrary channel without any dedicated strategy', () => {
    const spec = buildGenericContactSpec(
      message({ channel: 'whatsapp', senderId: '79990001122', senderUsername: undefined }),
    );

    expect(spec.lookup[0].attributeKey).toBe('whatsapp_user_id');
    expect(spec.identifier).toBe('whatsapp:79990001122');
    expect(spec.customAttributes).toEqual({ whatsapp_user_id: '79990001122' });
  });
});

describe('ContactIdentityRegistry', () => {
  it('falls back to the generic spec when no strategy is registered', () => {
    const registry = new ContactIdentityRegistry([]);
    expect(registry.build(message()).identifier).toBe('telegram:123');
  });

  it('uses a channel-specific strategy when present', () => {
    const custom: ContactIdentityStrategy = {
      channel: 'telegram',
      build: (msg) => ({
        ...buildGenericContactSpec(msg),
        additionalAttributes: { social_profiles: { telegram: msg.senderUsername } },
      }),
    };
    const registry = new ContactIdentityRegistry([custom]);

    expect(registry.build(message()).additionalAttributes).toEqual({
      social_profiles: { telegram: 'alice' },
    });
  });
});

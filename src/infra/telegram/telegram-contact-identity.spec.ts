import { describe, expect, it } from 'vitest';
import { InboundMessage } from '../../domain/message';
import { TelegramContactIdentityStrategy } from './telegram-contact-identity';

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

describe('TelegramContactIdentityStrategy', () => {
  const strategy = new TelegramContactIdentityStrategy();

  it('builds the generic spec plus the Telegram social profile', () => {
    const spec = strategy.build(message());

    expect(spec.lookup).toEqual([
      { attributeKey: 'telegram_user_id', filterOperator: 'equal_to', values: ['123'] },
    ]);
    expect(spec.identifier).toBe('telegram:123');
    expect(spec.sourceId).toBe('123');
    expect(spec.customAttributes).toEqual({
      telegram_user_id: '123',
      telegram_username: 'alice',
    });
    expect(spec.additionalAttributes).toEqual({
      social_profiles: { telegram: 'alice' },
    });
  });

  it('omits the social profile when there is no username', () => {
    const spec = strategy.build(message({ senderUsername: undefined }));

    expect(spec.additionalAttributes).toEqual({});
    expect(spec.customAttributes).toEqual({ telegram_user_id: '123' });
  });
});

import { Injectable } from '@nestjs/common';
import { buildGenericContactSpec, pruneEmpty } from '../../application/contact-identity';
import { InboundMessage } from '../../domain/message';
import { ContactIdentityStrategy, ContactSpec } from '../../domain/ports';

/**
 * Telegram contact shaping. Reuses the generic spec (lookup by `telegram_user_id`,
 * identifier `telegram:<id>` for new contacts, `source_id` = the Telegram user id,
 * custom attributes `telegram_user_id`/`telegram_username`) and additionally
 * records the Telegram handle under Chatwoot `additional_attributes.social_profiles`.
 */
@Injectable()
export class TelegramContactIdentityStrategy implements ContactIdentityStrategy {
  readonly channel = 'telegram';

  build(message: InboundMessage): ContactSpec {
    const base = buildGenericContactSpec({ ...message, channel: this.channel });

    return {
      ...base,
      additionalAttributes: pruneEmpty({
        social_profiles: message.senderUsername ? { telegram: message.senderUsername } : undefined,
      }),
    };
  }
}

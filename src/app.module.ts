import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import {
  CHATWOOT_PORT,
  DEDUP_PORT,
  MESSENGER_ADAPTERS,
  MessengerAdapter,
  OUTBOX_PORT,
  REPOSITORY_PORT,
} from './domain/ports';
import { ChatwootClient } from './infra/chatwoot/chatwoot.client';
import { TelegramAdapter } from './infra/telegram/telegram.adapter';
import { InMemoryRepository } from './infra/store/in-memory.repository';
import { InMemoryOutbox } from './infra/store/in-memory.outbox';
import { InMemoryDedup } from './infra/store/in-memory.dedup';
import { InboundService } from './application/inbound.service';
import { OutboundService } from './application/outbound.service';
import { MessengerRegistry } from './application/messenger-registry';
import { OutboxProcessor } from './application/outbox.processor';
import { ChatwootWebhookController } from './interface/chatwoot-webhook.controller';
import { TelegramWebhookController } from './interface/telegram-webhook.controller';
import { HealthController } from './interface/health.controller';

/**
 * Composition root. Ports are bound to their in-memory / HTTP implementations
 * here; swapping an implementation (e.g. a durable outbox) is a one-line change.
 * Messenger adapters are contributed to the {@link MESSENGER_ADAPTERS} multi-token.
 */
@Module({
  imports: [ConfigModule],
  controllers: [ChatwootWebhookController, TelegramWebhookController, HealthController],
  providers: [
    // Infrastructure adapters bound to domain ports.
    { provide: CHATWOOT_PORT, useClass: ChatwootClient },
    { provide: REPOSITORY_PORT, useClass: InMemoryRepository },
    { provide: OUTBOX_PORT, useClass: InMemoryOutbox },
    { provide: DEDUP_PORT, useClass: InMemoryDedup },

    // Messenger adapters.
    TelegramAdapter,
    {
      provide: MESSENGER_ADAPTERS,
      useFactory: (telegram: TelegramAdapter): MessengerAdapter[] => [telegram],
      inject: [TelegramAdapter],
    },

    // Application services.
    InboundService,
    OutboundService,
    MessengerRegistry,
    OutboxProcessor,
  ],
})
export class AppModule {}

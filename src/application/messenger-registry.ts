import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Channel } from '../domain/message';
import { MessengerAdapter, MESSENGER_ADAPTERS } from '../domain/ports';
import { InboundService } from './inbound.service';

/**
 * Owns the lifecycle of all messenger adapters and routes their inbound messages
 * into the application core. Adding a messenger requires no change here: the new
 * adapter is simply contributed to the {@link MESSENGER_ADAPTERS} multi-provider.
 */
@Injectable()
export class MessengerRegistry implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MessengerRegistry.name);
  private readonly byChannel = new Map<Channel, MessengerAdapter>();
  private readonly byInbox = new Map<number, MessengerAdapter>();

  constructor(
    @Inject(MESSENGER_ADAPTERS) private readonly adapters: MessengerAdapter[],
    private readonly inbound: InboundService,
  ) {
    for (const adapter of adapters) {
      this.byChannel.set(adapter.channel, adapter);
      this.byInbox.set(adapter.inboxId, adapter);
    }
  }

  getByChannel(channel: Channel): MessengerAdapter | undefined {
    return this.byChannel.get(channel);
  }

  getByInboxId(inboxId: number | undefined): MessengerAdapter | undefined {
    if (inboxId === undefined) return undefined;
    return this.byInbox.get(inboxId);
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const adapter of this.adapters) {
      adapter.onMessage((message) => this.inbound.handle(message));
      try {
        await adapter.start();
      } catch (err) {
        this.logger.error(`Failed to start adapter '${adapter.channel}': ${String(err)}`);
        throw err;
      }
    }
    this.logger.log(`Started ${this.adapters.length} messenger adapter(s)`);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      this.adapters.map((a) =>
        a.stop().catch((err) => this.logger.warn(`Adapter '${a.channel}' stop error: ${err}`)),
      ),
    );
  }
}

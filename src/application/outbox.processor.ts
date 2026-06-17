import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { OutboxJob, OutboxPort, OUTBOX_PORT } from '../domain/ports';
import { ChatwootWebhookEvent } from '../infra/chatwoot/chatwoot.types';
import { OutboundService } from './outbound.service';

const POLL_INTERVAL_MS = 500;
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const BATCH_SIZE = 10;

/**
 * Background worker that drains the outbox queue and delivers each job through
 * {@link OutboundService}. Failed jobs are retried with exponential backoff until
 * they succeed or exhaust {@link MAX_ATTEMPTS}, giving best-effort delivery.
 */
@Injectable()
export class OutboxProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxProcessor.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(OUTBOX_PORT) private readonly outbox: OutboxPort,
    private readonly outbound: OutboundService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.logger.log('Outbox processor started');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Process all jobs that are currently due. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.running) return; // avoid overlapping ticks
    this.running = true;
    try {
      const jobs = await this.outbox.pullDue(Date.now(), BATCH_SIZE);
      await Promise.all(jobs.map((job) => this.handleJob(job)));
    } catch (err) {
      this.logger.error(`Outbox tick failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  private async handleJob(job: OutboxJob): Promise<void> {
    try {
      await this.outbound.process(job.payload as ChatwootWebhookEvent);
      await this.outbox.markDone(job.id);
    } catch (err) {
      const attempts = job.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        this.logger.error(
          `Dropping outbox job ${job.id} after ${attempts} attempts: ${String(err)}`,
        );
        await this.outbox.markFailed(job.id);
        return;
      }
      const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** job.attempts);
      this.logger.warn(
        `Outbox job ${job.id} failed (attempt ${attempts}); retrying in ${delay}ms: ${String(err)}`,
      );
      await this.outbox.reschedule(job.id, Date.now() + delay);
    }
  }
}

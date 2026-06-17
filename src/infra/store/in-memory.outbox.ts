import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Channel } from '../../domain/message';
import { OutboxJob, OutboxPort } from '../../domain/ports';

/**
 * In-memory implementation of {@link OutboxPort}.
 *
 * Provides best-effort, at-least-once-ish delivery within a single process
 * lifetime: jobs are retried with backoff until they succeed or exhaust retries.
 * On restart, in-flight jobs are lost (acceptable for v1). The same interface
 * fits a durable outbox (SQLite/BullMQ) for stronger guarantees later.
 */
@Injectable()
export class InMemoryOutbox implements OutboxPort {
  private readonly jobs = new Map<string, OutboxJob>();
  // Ids currently leased to a worker, to avoid double processing.
  private readonly leased = new Set<string>();

  async enqueue<T>(channel: Channel, payload: T): Promise<void> {
    const id = randomUUID();
    this.jobs.set(id, {
      id,
      channel,
      payload,
      attempts: 0,
      nextAttemptAt: Date.now(),
    });
  }

  async pullDue(now: number, limit: number): Promise<OutboxJob[]> {
    const due: OutboxJob[] = [];
    for (const job of this.jobs.values()) {
      if (due.length >= limit) break;
      if (this.leased.has(job.id)) continue;
      if (job.nextAttemptAt <= now) {
        this.leased.add(job.id);
        due.push(job);
      }
    }
    return due;
  }

  async markDone(id: string): Promise<void> {
    this.jobs.delete(id);
    this.leased.delete(id);
  }

  async reschedule(id: string, nextAttemptAt: number): Promise<void> {
    const job = this.jobs.get(id);
    if (job) {
      job.attempts += 1;
      job.nextAttemptAt = nextAttemptAt;
    }
    this.leased.delete(id);
  }

  async markFailed(id: string): Promise<void> {
    this.jobs.delete(id);
    this.leased.delete(id);
  }

  size(): number {
    return this.jobs.size;
  }
}

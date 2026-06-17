import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryOutbox } from '../infra/store/in-memory.outbox';
import { OutboxProcessor } from './outbox.processor';
import { OutboundService } from './outbound.service';

describe('OutboxProcessor', () => {
  let outbox: InMemoryOutbox;

  beforeEach(() => {
    outbox = new InMemoryOutbox();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes a job after successful delivery', async () => {
    const outbound = {
      process: vi.fn().mockResolvedValue(undefined),
    } as unknown as OutboundService;
    const processor = new OutboxProcessor(outbox, outbound);

    await outbox.enqueue('chatwoot', { id: 1 });
    await processor.tick();

    expect(outbound.process).toHaveBeenCalledTimes(1);
    expect(outbox.size()).toBe(0);
  });

  it('keeps and reschedules a job when delivery fails', async () => {
    const outbound = {
      process: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as OutboundService;
    const processor = new OutboxProcessor(outbox, outbound);

    await outbox.enqueue('chatwoot', { id: 1 });
    await processor.tick();

    // Still queued, but pushed into the future (not immediately due).
    expect(outbox.size()).toBe(1);
    expect(await outbox.pullDue(Date.now(), 10)).toHaveLength(0);
  });

  it('drops a job after exhausting retries', async () => {
    const outbound = {
      process: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as OutboundService;
    const processor = new OutboxProcessor(outbox, outbound);

    // Fake the clock so we can fast-forward past each backoff window.
    vi.useFakeTimers();
    let now = Date.now();
    vi.setSystemTime(now);

    await outbox.enqueue('chatwoot', { id: 1 });

    for (let i = 0; i < 12 && outbox.size() > 0; i++) {
      await processor.tick();
      now += 120_000; // beyond the max backoff so the job becomes due again
      vi.setSystemTime(now);
    }

    expect(outbox.size()).toBe(0);
    // MAX_ATTEMPTS deliveries were attempted before giving up.
    expect((outbound.process as any).mock.calls.length).toBe(8);
  });
});

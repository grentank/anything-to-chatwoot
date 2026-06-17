import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryOutbox } from './in-memory.outbox';

describe('InMemoryOutbox', () => {
  let outbox: InMemoryOutbox;

  beforeEach(() => {
    outbox = new InMemoryOutbox();
  });

  it('enqueues and pulls due jobs', async () => {
    await outbox.enqueue('chatwoot', { id: 1 });
    expect(outbox.size()).toBe(1);

    const due = await outbox.pullDue(Date.now(), 10);
    expect(due).toHaveLength(1);
    expect(due[0].payload).toEqual({ id: 1 });
    expect(due[0].attempts).toBe(0);
  });

  it('does not hand out leased jobs again until rescheduled', async () => {
    await outbox.enqueue('chatwoot', { id: 1 });
    const first = await outbox.pullDue(Date.now(), 10);
    expect(first).toHaveLength(1);

    const second = await outbox.pullDue(Date.now(), 10);
    expect(second).toHaveLength(0);
  });

  it('reschedules with incremented attempts and a future time', async () => {
    await outbox.enqueue('chatwoot', { id: 1 });
    const [job] = await outbox.pullDue(Date.now(), 10);

    const future = Date.now() + 10_000;
    await outbox.reschedule(job.id, future);

    // Not due yet.
    expect(await outbox.pullDue(Date.now(), 10)).toHaveLength(0);

    // Due once we pass the scheduled time.
    const due = await outbox.pullDue(future + 1, 10);
    expect(due).toHaveLength(1);
    expect(due[0].attempts).toBe(1);
  });

  it('removes jobs on markDone', async () => {
    await outbox.enqueue('chatwoot', { id: 1 });
    const [job] = await outbox.pullDue(Date.now(), 10);
    await outbox.markDone(job.id);
    expect(outbox.size()).toBe(0);
  });

  it('removes jobs on markFailed', async () => {
    await outbox.enqueue('chatwoot', { id: 1 });
    const [job] = await outbox.pullDue(Date.now(), 10);
    await outbox.markFailed(job.id);
    expect(outbox.size()).toBe(0);
  });
});

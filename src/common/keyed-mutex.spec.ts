import { describe, expect, it } from 'vitest';
import { KeyedMutex } from './keyed-mutex';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('KeyedMutex', () => {
  it('serializes tasks sharing the same key', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const a = mutex.runExclusive('k', async () => {
      await delay(20);
      order.push('a');
    });
    const b = mutex.runExclusive('k', async () => {
      order.push('b');
    });

    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
  });

  it('runs tasks with different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const slow = mutex.runExclusive('k1', async () => {
      await delay(30);
      order.push('slow');
    });
    const fast = mutex.runExclusive('k2', async () => {
      order.push('fast');
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(['fast', 'slow']);
  });

  it('keeps the queue alive after a task throws', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const failing = mutex
      .runExclusive('k', async () => {
        throw new Error('boom');
      })
      .catch(() => order.push('caught'));
    const next = mutex.runExclusive('k', async () => {
      order.push('next');
    });

    await Promise.all([failing, next]);
    // Both must have run; a rejection in one task must not stall the queue.
    expect(new Set(order)).toEqual(new Set(['caught', 'next']));
  });

  it('returns the task result', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.runExclusive('k', async () => 42)).resolves.toBe(42);
  });
});

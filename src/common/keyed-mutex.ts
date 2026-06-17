/**
 * A FIFO mutex keyed by an arbitrary string. Operations sharing the same key run
 * strictly one after another; operations with different keys run concurrently.
 *
 * Used to serialize work per conversation so message ordering is preserved.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    // Chain this task after the previous one for the same key.
    const run = previous.then(task, task);

    // Keep the chain alive but never let a rejection break the queue.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);

    // Clean up the map once this is the last task in the chain.
    void tail.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });

    return run;
  }
}

import { Injectable } from '@nestjs/common';
import { DedupPort } from '../../domain/ports';

/**
 * Bounded, TTL-based dedup set. Used to drop duplicate webhook redeliveries and
 * repeated Telegram updates. Entries expire after {@link ttlMs}; the oldest are
 * evicted once {@link maxEntries} is reached.
 */
@Injectable()
export class InMemoryDedup implements DedupPort {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs = 5 * 60 * 1000;
  private readonly maxEntries = 50_000;

  firstSeen(key: string): boolean {
    const now = Date.now();
    this.evictExpired(now);

    const existing = this.seen.get(key);
    if (existing !== undefined && existing > now) {
      return false;
    }

    this.seen.set(key, now + this.ttlMs);

    if (this.seen.size > this.maxEntries) {
      // Map preserves insertion order; drop the oldest entry.
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    return true;
  }

  private evictExpired(now: number): void {
    for (const [key, expiry] of this.seen) {
      if (expiry <= now) {
        this.seen.delete(key);
      } else {
        // Entries are roughly ordered by insertion; stop at first live one.
        break;
      }
    }
  }
}

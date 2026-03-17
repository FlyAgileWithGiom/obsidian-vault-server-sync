import { QueuedChange } from "./types";

export class ChangeQueue {
  private items: Map<string, QueuedChange>;
  private maxSize: number;
  private onChanged: (() => Promise<void>) | null;

  constructor(maxSize: number = 500) {
    this.items = new Map();
    this.maxSize = maxSize;
    this.onChanged = null;
  }

  setOnChanged(cb: () => Promise<void>): void {
    this.onChanged = cb;
  }

  async enqueue(change: QueuedChange): Promise<void> {
    this.items.set(change.path, change);

    if (this.items.size > this.maxSize) {
      const sorted = [...this.items.entries()].sort(
        (a, b) => a[1].timestamp - b[1].timestamp
      );
      const toRemove = sorted.slice(0, this.items.size - this.maxSize);
      for (const [path] of toRemove) {
        this.items.delete(path);
      }
    }

    if (this.onChanged) await this.onChanged();
  }

  async dequeue(): Promise<QueuedChange | undefined> {
    if (this.items.size === 0) return undefined;

    let oldestKey: string | undefined;
    let oldestTimestamp = Infinity;

    for (const [path, change] of this.items) {
      if (change.timestamp < oldestTimestamp) {
        oldestTimestamp = change.timestamp;
        oldestKey = path;
      }
    }

    if (oldestKey === undefined) return undefined;

    const item = this.items.get(oldestKey)!;
    this.items.delete(oldestKey);

    if (this.onChanged) await this.onChanged();
    return item;
  }

  peek(): QueuedChange[] {
    return [...this.items.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  get size(): number {
    return this.items.size;
  }

  async clear(): Promise<void> {
    this.items.clear();
    if (this.onChanged) await this.onChanged();
  }

  serialize(): string {
    return JSON.stringify([...this.items.entries()]);
  }

  static deserialize(data: string): ChangeQueue {
    const queue = new ChangeQueue();
    const entries: [string, QueuedChange][] = JSON.parse(data);
    for (const [path, change] of entries) {
      queue.items.set(path, change);
    }
    return queue;
  }
}

import { App, TFile, Notice } from "obsidian";
import { CouchClient } from "./couch-client";
import { ChangeQueue } from "./change-queue";
import { VaultSyncSettings, CouchDoc, QueuedChange } from "./types";
import { encodeDocId, decodeDocId, isDocId, isTextFile, isExcluded, getMimeType } from "./utils";

export class SyncEngine {
  private app: App;
  private settings: VaultSyncSettings;
  private client: CouchClient;
  private queue: ChangeQueue;
  private lastSeq: string;
  private pollTimer: ReturnType<typeof setInterval> | null;
  private suppressedPaths: Set<string>;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  private statusCb: ((status: string) => void) | null;
  private pushing: boolean;

  constructor(app: App, settings: VaultSyncSettings, queue: ChangeQueue) {
    this.app = app;
    this.settings = settings;
    this.queue = queue;
    this.lastSeq = "0";
    this.pollTimer = null;
    this.suppressedPaths = new Set();
    this.debounceTimers = new Map();
    this.statusCb = null;
    this.pushing = false;
    this.client = null as unknown as CouchClient;
  }

  setStatusCallback(cb: (status: string) => void): void {
    this.statusCb = cb;
  }

  setLastSeq(seq: string): void {
    this.lastSeq = seq;
  }

  getLastSeq(): string {
    return this.lastSeq;
  }

  getQueue(): ChangeQueue {
    return this.queue;
  }

  // === LIFECYCLE ===

  async start(): Promise<void> {
    if (!this.settings.couchdbUrl) {
      this.setStatus("not configured");
      return;
    }

    this.client = new CouchClient(
      this.settings.couchdbUrl,
      this.settings.database,
      this.settings.username,
      this.settings.password,
    );

    await this.processQueue();

    this.pollTimer = setInterval(() => {
      this.pullChanges().catch((err) => {
        console.error("Vault sync: poll error", err);
      });
    }, this.settings.pollIntervalSec * 1000);

    this.setStatus("connected");
  }

  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.setStatus("stopped");
  }

  // === LOCAL → REMOTE (event-driven push) ===

  async onLocalCreate(file: TFile): Promise<void> {
    if (!(file instanceof TFile) || isExcluded(file.path)) return;
    await this.pushFile(file);
  }

  async onLocalModify(file: TFile): Promise<void> {
    if (!(file instanceof TFile) || isExcluded(file.path)) return;
    this.debounce(file.path, () => this.pushFile(file));
  }

  async onLocalDelete(path: string): Promise<void> {
    if (isExcluded(path)) return;
    try {
      const id = encodeDocId(path);
      const existing = await this.client.getDoc(id);
      if (existing) {
        const deleted: CouchDoc = {
          ...existing,
          deleted: true,
          content: undefined,
        };
        await this.client.putDoc(deleted);
      }
    } catch (err) {
      console.error("Vault sync: delete push failed, enqueueing", path, err);
      this.queue.enqueue({ path, type: "delete", timestamp: Date.now(), retries: 0 });
    }
  }

  async onLocalRename(newFile: TFile, oldPath: string): Promise<void> {
    if (isExcluded(newFile.path) && isExcluded(oldPath)) return;

    if (!isExcluded(oldPath)) {
      await this.onLocalDelete(oldPath);
    }

    if (!isExcluded(newFile.path)) {
      await this.pushFile(newFile);
    }
  }

  private async pushFile(file: TFile): Promise<void> {
    try {
      const id = encodeDocId(file.path);
      const isBinary = !isTextFile(file.extension);

      let doc: CouchDoc = {
        _id: id,
        type: "file",
        mtime: file.stat.mtime,
        ctime: file.stat.ctime,
        size: file.stat.size,
      };

      let textContent: string | undefined;
      let binaryContent: ArrayBuffer | undefined;

      if (!isBinary) {
        textContent = await this.app.vault.read(file);
        doc.content = textContent;
        doc.size = new TextEncoder().encode(textContent).length;
      } else {
        binaryContent = await this.app.vault.readBinary(file);
      }

      // Preserve _rev from existing doc
      try {
        const existing = await this.client.getDoc(id);
        if (existing?._rev) {
          doc._rev = existing._rev;
        }
      } catch {
        // No existing doc is fine
      }

      try {
        await this.client.putDoc(doc);
      } catch (err: unknown) {
        if (this.isConflict(err)) {
          // Re-fetch _rev and retry once
          const existing = await this.client.getDoc(id);
          if (existing?._rev) {
            doc._rev = existing._rev;
          }
          await this.client.putDoc(doc);
        } else {
          throw err;
        }
      }

      if (isBinary && binaryContent !== undefined) {
        const mimeType = getMimeType(file.extension);
        // Re-fetch doc to get latest _rev after putDoc
        const latest = await this.client.getDoc(id);
        if (latest?._rev) {
          await this.client.putAttachment(id, "data.bin", latest._rev, binaryContent, mimeType);
        }
      }

      this.suppress(file.path);
    } catch (err) {
      console.error("Vault sync: pushFile failed, enqueueing", file.path, err);
      this.queue.enqueue({
        path: file.path,
        type: "upsert",
        timestamp: Date.now(),
        retries: 0,
      });
    }
  }

  // === REMOTE → LOCAL (polling) ===

  private async pullChanges(): Promise<void> {
    try {
      const result = await this.client.getChanges(this.lastSeq);

      for (const change of result.results) {
        try {
          if (!isDocId(change.id)) continue;

          const path = decodeDocId(change.id);

          if (isExcluded(path) || this.isSuppressed(path)) continue;

          if (change.deleted) {
            if (await this.app.vault.adapter.exists(path)) {
              await this.app.vault.adapter.remove(path);
            }
            continue;
          }

          const doc = change.doc;
          if (!doc) continue;

          await this.ensureParentDirs(path);

          if (doc._attachments?.["data.bin"]) {
            const data = await this.client.getAttachment(change.id, "data.bin");
            if (data) {
              await this.app.vault.adapter.writeBinary(path, data);
            }
          } else if (doc.content !== undefined) {
            await this.app.vault.adapter.write(path, doc.content);
          }

          this.suppress(path);
        } catch (err) {
          console.error("Vault sync: error applying remote change", change.id, err);
        }
      }

      if (result.last_seq !== undefined) {
        this.lastSeq = result.last_seq;
      }

      this.setStatus("connected");
    } catch (err) {
      console.error("Vault sync: pullChanges failed", err);
      this.setStatus("error");
    }
  }

  // === QUEUE PROCESSING ===

  async processQueue(): Promise<void> {
    const items = this.queue.peek();
    await this.queue.clear();

    for (const item of items) {
      try {
        if (item.type === "delete") {
          await this.onLocalDelete(item.path);
        } else {
          const file = this.app.vault.getFileByPath(item.path);
          if (file instanceof TFile) {
            await this.pushFile(file);
          }
        }
      } catch (err) {
        console.error("Vault sync: queue item failed", item.path, err);
        if (item.retries < 5) {
          this.queue.enqueue({ ...item, retries: item.retries + 1 });
        } else {
          console.error("Vault sync: dropping queue item after 5 retries", item.path);
        }
      }
    }
  }

  // === BOOTSTRAP ===

  async bootstrapPush(): Promise<void> {
    new Notice("Vault sync: starting bootstrap push...");

    try {
      await this.pullChanges();
    } catch (err) {
      console.error("Vault sync: bootstrap pull failed", err);
    }

    const allFiles = this.app.vault.getFiles().filter(
      (f) => !isExcluded(f.path)
    );

    const batchSize = 50;
    let processed = 0;

    for (let i = 0; i < allFiles.length; i += batchSize) {
      const batch = allFiles.slice(i, i + batchSize);
      await Promise.all(batch.map((f) => this.pushFile(f)));
      processed += batch.length;
      new Notice(`Vault sync: bootstrap ${processed}/${allFiles.length}`);
    }

    new Notice("Vault sync: bootstrap complete.");
  }

  // === HELPERS ===

  private suppress(path: string): void {
    this.suppressedPaths.add(path);
    setTimeout(() => {
      this.suppressedPaths.delete(path);
    }, 500);
  }

  private isSuppressed(path: string): boolean {
    return this.suppressedPaths.has(path);
  }

  private debounce(path: string, fn: () => Promise<void>): void {
    const existing = this.debounceTimers.get(path);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(path);
      fn().catch((err) => {
        console.error("Vault sync: debounced push failed", path, err);
      });
    }, this.settings.debounceMs);
    this.debounceTimers.set(path, timer);
  }

  private async ensureParentDirs(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop(); // remove filename
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        try {
          await this.app.vault.adapter.mkdir(current);
        } catch {
          // May already exist due to race
        }
      }
    }
  }

  private setStatus(status: string): void {
    if (this.statusCb) {
      this.statusCb(status);
    }
  }

  private isConflict(err: unknown): boolean {
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      return e["status"] === 409 || e["statusCode"] === 409;
    }
    return false;
  }
}

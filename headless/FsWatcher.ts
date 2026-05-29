/**
 * FsWatcher — VaultWatcher implementation for the headless daemon (Node.js).
 *
 * Wraps fs.watch(root, {recursive:true}) with:
 *   - 100ms debounce per path (matching v1 createWatcher() behavior)
 *   - stat()-based change/delete detection
 *   - Exclusion list (exact match or path prefix)
 *   - Spurious self-referential event suppression (macOS FSEvents quirk)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { VaultWatcher, FileEvent } from "../src/WatcherAdapter";

const DEBOUNCE_MS = 100;

export class FsWatcher implements VaultWatcher {
  private fsWatcher: fs.FSWatcher | null = null;
  private debounce: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private handler: ((event: FileEvent) => void) | null = null;
  private readonly vaultRootBasename: string;

  constructor(
    private readonly absVaultRoot: string,
    private readonly excludePatterns: string[],
  ) {
    this.vaultRootBasename = path.basename(absVaultRoot);
  }

  start(handler: (event: FileEvent) => void): void {
    this.handler = handler;

    const watcher = fs.watch(this.absVaultRoot, { recursive: true, persistent: true });
    this.fsWatcher = watcher;

    watcher.on("change", (eventType: string, rawFilename: string | Buffer | null) => {
      if (!rawFilename) return;
      const rel = typeof rawFilename === "string"
        ? rawFilename
        : rawFilename.toString("utf-8");

      // Suppress spurious root-directory self-referential events (macOS FSEvents)
      if (rel === this.vaultRootBasename) return;

      // Skip excluded paths
      if (this.isExcluded(rel)) return;

      // Debounce rapid events on same path
      const existing = this.debounce.get(rel);
      if (existing) clearTimeout(existing);
      this.debounce.set(rel, setTimeout(() => {
        this.debounce.delete(rel);
        this.dispatchEvent(rel);
      }, DEBOUNCE_MS));
    });

    watcher.on("error", (error: Error) => {
      console.error("[vault-sync] FsWatcher error:", error);
    });
  }

  stop(): void {
    this.handler = null;
    // Cancel all pending debounce timers
    for (const timer of this.debounce.values()) {
      clearTimeout(timer);
    }
    this.debounce.clear();
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }

  private isExcluded(rel: string): boolean {
    return this.excludePatterns.some(
      (p) => rel === p || rel.startsWith(p + path.sep)
    );
  }

  private dispatchEvent(rel: string): void {
    if (!this.handler) return;
    const filePath = path.join(this.absVaultRoot, rel);

    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // Path no longer exists -> delete event
    }

    if (!stat) {
      this.handler({ type: "delete", path: rel });
      return;
    }

    // Skip directory events — we only sync files
    if (stat.isDirectory()) return;

    this.handler({ type: "change", path: rel });
  }
}

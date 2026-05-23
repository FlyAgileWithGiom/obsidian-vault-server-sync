import * as fs from "node:fs";
import * as path from "node:path";
import type { StateStore } from "../src/types";

/**
 * JSON file-backed StateStore for the headless daemon.
 *
 * Persists key-value pairs to a single JSON file. The file path is supplied by
 * the caller — production resolves it via resolveStatePath() so state lives
 * outside the vault (issue #54). Parent directory is created on first write.
 */
export class JsonStateStore implements StateStore {
  private data: Record<string, string> = {};
  private readonly filePath: string;
  private parentEnsured = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      this.data = JSON.parse(raw);
    } catch {
      this.data = {};
    }
  }

  private ensureParent(): void {
    if (this.parentEnsured) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.parentEnsured = true;
    } catch {
      // If mkdir fails, writeFileSync will surface the error — don't swallow twice.
    }
  }

  private save(): void {
    try {
      this.ensureParent();
      fs.writeFileSync(this.filePath, JSON.stringify(this.data), "utf-8");
    } catch (e) {
      console.error("[vault-sync] Failed to persist state:", e);
    }
  }

  get(key: string): string | null {
    return this.data[key] ?? null;
  }

  set(key: string, value: string): void {
    this.data[key] = value;
    this.save();
  }
}

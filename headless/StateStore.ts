import * as fs from "node:fs";
import type { StateStore } from "../src/types";

/**
 * JSON file-backed StateStore for the headless daemon.
 * Persists key-value pairs to .vault-sync-state.json in the vault root.
 */
export class JsonStateStore implements StateStore {
  private data: Record<string, string> = {};
  private readonly filePath: string;

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

  private save(): void {
    try {
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

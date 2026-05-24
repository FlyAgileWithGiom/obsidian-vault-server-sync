/**
 * Shared test adapters extracted from sync-engine.test.ts.
 * Used by both the main test suite and the binary-resilience scenario suite.
 */

import { vi } from "vitest";
import { TFile } from "./obsidian";
import type {
  VaultAdapter,
  VaultFile,
  VaultFolder,
  VaultEntry,
  StateStore,
  HttpTransport,
} from "../types";

/** Minimal in-memory vault for scenario tests — no Obsidian dependency */
export class ScenarioVault implements VaultAdapter {
  private files: Map<string, { mtime: number; size: number; content: string | ArrayBuffer }> = new Map();
  private folders: Set<string> = new Set();

  addTextFile(path: string, content: string, mtime = 1000): void {
    this.files.set(path, { mtime, size: content.length, content });
  }

  addBinaryFile(path: string, data: ArrayBuffer, mtime = 1000): void {
    this.files.set(path, { mtime, size: data.byteLength, content: data });
  }

  getFiles(): VaultFile[] {
    return [...this.files.entries()].map(([path, meta]) => ({
      kind: "file" as const,
      path,
      mtime: meta.mtime,
      size: meta.size,
    }));
  }

  getEntryByPath(path: string): VaultEntry | null {
    const meta = this.files.get(path);
    if (meta) return { kind: "file", path, mtime: meta.mtime, size: meta.size };
    if (this.folders.has(path)) return { kind: "folder", path };
    return null;
  }

  async readText(file: VaultFile): Promise<string> {
    const meta = this.files.get(file.path);
    if (!meta) return "";
    return typeof meta.content === "string" ? meta.content : "";
  }

  async readBinary(file: VaultFile): Promise<ArrayBuffer> {
    const meta = this.files.get(file.path);
    if (!meta) return new ArrayBuffer(0);
    return meta.content instanceof ArrayBuffer ? meta.content : new ArrayBuffer(0);
  }

  async modifyText(file: VaultFile, content: string): Promise<void> {
    const meta = this.files.get(file.path);
    if (meta) { meta.content = content; meta.mtime = Date.now(); }
  }

  async modifyBinary(file: VaultFile, data: ArrayBuffer): Promise<void> {
    const meta = this.files.get(file.path);
    if (meta) { meta.content = data; meta.mtime = Date.now(); }
  }

  async createText(path: string, content: string): Promise<VaultFile> {
    const mtime = Date.now();
    this.files.set(path, { mtime, size: content.length, content });
    return { kind: "file", path, mtime, size: content.length };
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<VaultFile> {
    const mtime = Date.now();
    this.files.set(path, { mtime, size: data.byteLength, content: data });
    return { kind: "file", path, mtime, size: data.byteLength };
  }

  async createDirectory(path: string): Promise<void> {
    this.folders.add(path);
  }

  async deleteFile(file: VaultFile): Promise<void> {
    this.files.delete(file.path);
  }

  async deleteDirectory(dir: VaultFolder): Promise<void> {
    this.folders.delete(dir.path);
  }

  async isDirectoryEmpty(path: string): Promise<boolean> {
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(path + "/")) return false;
    }
    return true;
  }

  normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/+/g, "/");
  }
}

/** Map-backed StateStore for testing */
export class TestStateStore implements StateStore {
  private store = new Map<string, string>();
  get(key: string): string | null { return this.store.get(key) ?? null; }
  set(key: string, value: string): void { this.store.set(key, value); }
}

/** No-op transport — CouchClient is fully mocked via vi.mock, this is never called */
export const noopTransport: HttpTransport = {
  request: vi.fn().mockResolvedValue({
    status: 200,
    text: async () => "{}",
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
  }),
};

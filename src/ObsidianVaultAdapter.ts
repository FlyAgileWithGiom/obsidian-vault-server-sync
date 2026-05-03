import { Vault, TFile, TFolder, normalizePath } from "obsidian";
import type { VaultAdapter, VaultFile, VaultFolder, VaultEntry } from "./types";

/**
 * Wraps the real Obsidian Vault API to implement VaultAdapter.
 * All Obsidian-specific types (TFile, TFolder, instanceof checks) live here.
 */
export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private vault: Vault) {}

  getFiles(): VaultFile[] {
    return this.vault.getFiles().map((f) => ({
      kind: "file" as const,
      path: f.path,
      mtime: f.stat.mtime,
      size: f.stat.size,
    }));
  }

  getEntryByPath(path: string): VaultEntry | null {
    const entry = this.vault.getAbstractFileByPath(path);
    if (!entry) return null;
    if (entry instanceof TFile) {
      return { kind: "file", path: entry.path, mtime: entry.stat.mtime, size: entry.stat.size };
    }
    if (entry instanceof TFolder) {
      return { kind: "folder", path: entry.path };
    }
    return null;
  }

  async readText(file: VaultFile): Promise<string> {
    const tfile = this.vault.getAbstractFileByPath(file.path);
    if (!(tfile instanceof TFile)) throw new Error(`Not a file: ${file.path}`);
    return this.vault.cachedRead(tfile);
  }

  async readBinary(file: VaultFile): Promise<ArrayBuffer> {
    const tfile = this.vault.getAbstractFileByPath(file.path);
    if (!(tfile instanceof TFile)) throw new Error(`Not a file: ${file.path}`);
    return this.vault.readBinary(tfile);
  }

  async modifyText(file: VaultFile, content: string): Promise<void> {
    const tfile = this.vault.getAbstractFileByPath(file.path);
    if (!(tfile instanceof TFile)) throw new Error(`Not a file: ${file.path}`);
    await this.vault.modify(tfile, content);
  }

  async modifyBinary(file: VaultFile, data: ArrayBuffer): Promise<void> {
    const tfile = this.vault.getAbstractFileByPath(file.path);
    if (!(tfile instanceof TFile)) throw new Error(`Not a file: ${file.path}`);
    await this.vault.modifyBinary(tfile, data);
  }

  async createText(path: string, content: string): Promise<VaultFile> {
    const tfile = await this.vault.create(path, content);
    return { kind: "file", path: tfile.path, mtime: tfile.stat.mtime, size: tfile.stat.size };
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<VaultFile> {
    const tfile = await this.vault.createBinary(path, data);
    return { kind: "file", path: tfile.path, mtime: tfile.stat.mtime, size: tfile.stat.size };
  }

  async createDirectory(path: string): Promise<void> {
    await this.vault.createFolder(path);
  }

  async deleteFile(file: VaultFile): Promise<void> {
    const tfile = this.vault.getAbstractFileByPath(file.path);
    if (!(tfile instanceof TFile)) return;
    await this.vault.delete(tfile);
  }

  async deleteDirectory(dir: VaultFolder): Promise<void> {
    const tfolder = this.vault.getAbstractFileByPath(dir.path);
    if (!(tfolder instanceof TFolder)) return;
    await this.vault.delete(tfolder);
  }

  /**
   * Use vault.adapter.list() for a fresh directory listing — avoids the stale
   * TFolder.children cache which does not update after async vault.delete() calls.
   */
  async isDirectoryEmpty(path: string): Promise<boolean> {
    try {
      const result = await (this.vault.adapter as { list(path: string): Promise<{ files: string[]; folders: string[] }> }).list(path);
      return result.files.length === 0 && result.folders.length === 0;
    } catch {
      return false;
    }
  }

  normalizePath(path: string): string {
    return normalizePath(path);
  }
}

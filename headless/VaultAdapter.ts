import * as fs from "node:fs";
import * as path from "node:path";
import type { VaultAdapter, VaultFile, VaultFolder, VaultEntry } from "../src/types";

/**
 * Filesystem-backed VaultAdapter for the headless daemon.
 * All paths are relative to vaultRoot (absolute path to vault directory).
 */
export class FilesystemVaultAdapter implements VaultAdapter {
  constructor(private vaultRoot: string) {}

  private abs(relativePath: string): string {
    return path.join(this.vaultRoot, relativePath);
  }

  private rel(absolutePath: string): string {
    return path.relative(this.vaultRoot, absolutePath);
  }

  getFiles(): VaultFile[] {
    const results: VaultFile[] = [];
    this.walk(this.vaultRoot, results);
    return results;
  }

  private walk(dir: string, out: VaultFile[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walk(full, out);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          out.push({
            kind: "file",
            path: this.rel(full),
            mtime: Math.floor(stat.mtimeMs),
            size: stat.size,
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  getEntryByPath(relativePath: string): VaultEntry | null {
    const full = this.abs(relativePath);
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        return { kind: "folder", path: relativePath };
      }
      if (stat.isFile()) {
        return { kind: "file", path: relativePath, mtime: Math.floor(stat.mtimeMs), size: stat.size };
      }
    } catch {
      // Not found
    }
    return null;
  }

  async readText(file: VaultFile): Promise<string> {
    return fs.promises.readFile(this.abs(file.path), "utf-8");
  }

  async readBinary(file: VaultFile): Promise<ArrayBuffer> {
    const buf = await fs.promises.readFile(this.abs(file.path));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

  async modifyText(file: VaultFile, content: string): Promise<void> {
    await fs.promises.writeFile(this.abs(file.path), content, "utf-8");
  }

  async modifyBinary(file: VaultFile, data: ArrayBuffer): Promise<void> {
    await fs.promises.writeFile(this.abs(file.path), Buffer.from(data));
  }

  async createText(relativePath: string, content: string): Promise<VaultFile> {
    const full = this.abs(relativePath);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, content, "utf-8");
    const stat = fs.statSync(full);
    return { kind: "file", path: relativePath, mtime: Math.floor(stat.mtimeMs), size: stat.size };
  }

  async createBinary(relativePath: string, data: ArrayBuffer): Promise<VaultFile> {
    const full = this.abs(relativePath);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, Buffer.from(data));
    const stat = fs.statSync(full);
    return { kind: "file", path: relativePath, mtime: Math.floor(stat.mtimeMs), size: stat.size };
  }

  async createDirectory(relativePath: string): Promise<void> {
    await fs.promises.mkdir(this.abs(relativePath), { recursive: true });
  }

  async deleteFile(file: VaultFile): Promise<void> {
    await fs.promises.unlink(this.abs(file.path));
  }

  async deleteDirectory(dir: VaultFolder): Promise<void> {
    // Recursive: matches ObsidianVaultAdapter (vault.delete on a folder removes its
    // contents too). The sole caller is wipeLocalFiles, which deletes whole folders.
    // Plain rmdir throws ENOTEMPTY on non-empty dirs; rm({recursive}) does not.
    await fs.promises.rm(this.abs(dir.path), { recursive: true, force: true });
  }

  async isDirectoryEmpty(relativePath: string): Promise<boolean> {
    try {
      const entries = await fs.promises.readdir(this.abs(relativePath));
      return entries.length === 0;
    } catch {
      return false;
    }
  }

  normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+/g, "/");
  }
}

/** Minimal mock of the Obsidian API for testing */

/** Mock requestUrl - tests override via vi.mocked(requestUrl) */
export async function requestUrl(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: boolean;
}): Promise<{ status: number; json: unknown; text: string }> {
  // Default mock - tests should override this
  return { status: 200, json: {}, text: "{}" };
}

export class TFile {
  path: string;
  stat: { mtime: number; ctime: number; size: number };
  name: string;
  extension: string;
  basename: string;
  parent: null = null;

  constructor(path: string, mtime = Date.now()) {
    this.path = path;
    this.name = path.split("/").pop() || path;
    this.extension = this.name.split(".").pop() || "";
    this.basename = this.name.replace(`.${this.extension}`, "");
    this.stat = { mtime, ctime: mtime, size: 0 };
  }
}

export class TAbstractFile {
  path = "";
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/** In-memory adapter for testing vault.adapter.read/write */
export class MockVaultAdapter {
  private store: Map<string, string> = new Map();

  async read(path: string): Promise<string> {
    const val = this.store.get(path);
    if (val === undefined) throw new Error(`ENOENT: no such file: ${path}`);
    return val;
  }

  async write(path: string, data: string): Promise<void> {
    this.store.set(path, data);
  }

  _getStored(path: string): string | undefined {
    return this.store.get(path);
  }

  _setStored(path: string, data: string): void {
    this.store.set(path, data);
  }

  _has(path: string): boolean {
    return this.store.has(path);
  }
}

export class Vault {
  private files: Map<string, { file: TFile; content: string }> = new Map();
  private binaryFiles: Map<string, { file: TFile; content: ArrayBuffer }> = new Map();
  private folders: Map<string, TFolder> = new Map();
  adapter = new MockVaultAdapter();

  getFiles(): TFile[] {
    return [
      ...Array.from(this.files.values()).map((f) => f.file),
      ...Array.from(this.binaryFiles.values()).map((f) => f.file),
    ];
  }

  async cachedRead(file: TFile): Promise<string> {
    const entry = this.files.get(file.path);
    return entry ? entry.content : "";
  }

  async read(file: TFile): Promise<string> {
    return this.cachedRead(file);
  }

  async modify(file: TFile, content: string): Promise<void> {
    const entry = this.files.get(file.path);
    if (entry) {
      entry.content = content;
    }
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const entry = this.binaryFiles.get(file.path);
    return entry ? entry.content : new ArrayBuffer(0);
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    const file = new TFile(path);
    this.binaryFiles.set(path, { file, content: data });
    return file;
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    const entry = this.binaryFiles.get(file.path);
    if (entry) {
      entry.content = data;
    }
  }

  // Test helpers for binary files
  _addBinaryFile(path: string, data: ArrayBuffer, mtime = Date.now()): TFile {
    const file = new TFile(path, mtime);
    this.binaryFiles.set(path, { file, content: data });
    return file;
  }

  _getBinaryContent(path: string): ArrayBuffer | undefined {
    return this.binaryFiles.get(path)?.content;
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    const fileEntry = this.files.get(path) ?? this.binaryFiles.get(path);
    if (fileEntry) return fileEntry.file;
    const folder = this.folders.get(path);
    if (folder) return folder;
    return null;
  }

  async create(path: string, content: string): Promise<TFile> {
    const file = new TFile(path);
    this.files.set(path, { file, content });
    return file;
  }

  async createFolder(path: string): Promise<void> {
    const folder = new TFolder();
    folder.path = path;
    this.folders.set(path, folder);
  }

  async delete(file: TFile | TFolder): Promise<void> {
    if (file instanceof TFolder) {
      this.folders.delete(file.path);
    } else {
      this.files.delete(file.path);
      this.binaryFiles.delete(file.path);
    }
  }

  // Test helpers (not in real Obsidian API)
  _addFile(path: string, content: string, mtime = Date.now()): TFile {
    const file = new TFile(path, mtime);
    this.files.set(path, { file, content });
    return file;
  }

  _getContent(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  /** Create a folder with explicit children list for testing cleanup logic */
  _addFolder(path: string, children: TAbstractFile[] = []): TFolder {
    const folder = new TFolder();
    folder.path = path;
    folder.children = children;
    this.folders.set(path, folder);
    return folder;
  }

  _hasFolder(path: string): boolean {
    return this.folders.has(path);
  }

  on(_event: string, _callback: (...args: unknown[]) => void): { unload: () => void } {
    return { unload: () => {} };
  }
}

/**
 * In-memory mock of Obsidian's synchronous SecretStorage API (>= 1.11.4).
 * Mirrors the real surface: setSecret/getSecret/listSecrets, all synchronous.
 */
export class SecretStorage {
  private store: Map<string, string> = new Map();

  setSecret(id: string, secret: string): void {
    this.store.set(id, secret);
  }

  getSecret(id: string): string | null {
    return this.store.has(id) ? (this.store.get(id) as string) : null;
  }

  listSecrets(): string[] {
    return Array.from(this.store.keys());
  }
}

export class Plugin {
  app = { vault: new Vault(), secretStorage: new SecretStorage() };
  manifest = {};
  async loadData(): Promise<unknown> { return {}; }
  async saveData(_data: unknown): Promise<void> {}
  addRibbonIcon(): HTMLElement { return document.createElement("div"); }
  addStatusBarItem(): HTMLElement { return document.createElement("div"); }
  addCommand(): void {}
  addSettingTab(): void {}
  registerEvent(): void {}
  registerObsidianProtocolHandler(
    _action: string,
    _handler: (params: Record<string, string>) => unknown,
  ): void {}
}

export class PluginSettingTab {
  containerEl = document.createElement("div");
  constructor(_app: unknown, _plugin: unknown) {}
  display(): void {}
}

export class Setting {
  constructor(_el: HTMLElement) {}
  setName(): this { return this; }
  setDesc(): this { return this; }
  addText(): this { return this; }
  addTextArea(): this { return this; }
  addButton(): this { return this; }
  addDropdown(): this { return this; }
}

export class Notice {
  constructor(_msg: string, _timeout?: number) {}
}

export class Modal {
  contentEl: HTMLElement;
  constructor(_app: unknown) {
    this.contentEl = document.createElement("div");
  }
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export class App {
  vault = new Vault();
  secretStorage = new SecretStorage();
}

/**
 * Platform mock — defaults to desktop (isMobile: false).
 * Tests that need mobile behaviour should set Platform.isMobile = true
 * before instantiating the object under test, and reset after.
 */
export const Platform = {
  isMobile: false,
};

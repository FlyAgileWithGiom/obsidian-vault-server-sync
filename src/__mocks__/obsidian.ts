/** Minimal mock of the Obsidian API for testing */

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

export class TFolder extends TAbstractFile {}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export class Vault {
  private files: Map<string, { file: TFile; content: string }> = new Map();

  getFiles(): TFile[] {
    return Array.from(this.files.values()).map((f) => f.file);
  }

  getAbstractFileByPath(path: string): TFile | null {
    const entry = this.files.get(path);
    return entry ? entry.file : null;
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

  async create(path: string, content: string): Promise<TFile> {
    const file = new TFile(path);
    this.files.set(path, { file, content });
    return file;
  }

  async createFolder(_path: string): Promise<void> {
    // no-op for testing
  }

  async delete(file: TFile): Promise<void> {
    this.files.delete(file.path);
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

  on(_event: string, _callback: (...args: unknown[]) => void): { unload: () => void } {
    return { unload: () => {} };
  }
}

export class Plugin {
  app = { vault: new Vault() };
  manifest = {};
  async loadData(): Promise<unknown> { return {}; }
  async saveData(_data: unknown): Promise<void> {}
  addRibbonIcon(): HTMLElement { return document.createElement("div"); }
  addCommand(): void {}
  addSettingTab(): void {}
  registerEvent(): void {}
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
}

export class Notice {
  constructor(_msg: string, _timeout?: number) {}
}

export class App {
  vault = new Vault();
}

/**
 * ObsidianVaultWatcher — VaultWatcher implementation for Obsidian plugins.
 *
 * Wraps vault.on("modify"|"create"|"delete"|"rename") events into the
 * platform-neutral FileEvent interface.
 *
 * Rename is translated as: delete(oldPath) + change(newPath).
 * This preserves the semantics of the previous PouchDbFsBridge.onVaultRename().
 */

import type { Plugin, TAbstractFile } from "obsidian";
import type { VaultWatcher, FileEvent } from "./WatcherAdapter";

export class ObsidianVaultWatcher implements VaultWatcher {
  private handler: ((event: FileEvent) => void) | null = null;

  constructor(private readonly plugin: Plugin) {}

  start(handler: (event: FileEvent) => void): void {
    this.handler = handler;
    const vault = this.plugin.app.vault;

    this.plugin.registerEvent(
      vault.on("modify", (file: TAbstractFile) => {
        this.handler?.({ type: "change", path: file.path });
      })
    );

    this.plugin.registerEvent(
      vault.on("create", (file: TAbstractFile) => {
        this.handler?.({ type: "change", path: file.path });
      })
    );

    this.plugin.registerEvent(
      vault.on("delete", (file: TAbstractFile) => {
        this.handler?.({ type: "delete", path: file.path });
      })
    );

    this.plugin.registerEvent(
      vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        // Rename = delete old path + change new path
        this.handler?.({ type: "delete", path: oldPath });
        this.handler?.({ type: "change", path: file.path });
      })
    );
  }

  /**
   * Stop is a no-op: Obsidian lifecycle manages event cleanup via registerEvent().
   * The plugin.unload() call tears down all registered events automatically.
   */
  stop(): void {
    this.handler = null;
  }
}

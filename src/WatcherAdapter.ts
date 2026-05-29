/**
 * VaultWatcher port — platform-neutral interface for FS change events.
 *
 * Implementations:
 *   ObsidianVaultWatcher — wraps Obsidian vault.on("modify"|"create"|"delete"|"rename")
 *   FsWatcher            — wraps fs.watch(root, {recursive:true}) for headless daemon
 */

export type FileEventType = "change" | "delete";

export interface FileEvent {
  type: FileEventType;
  path: string;
}

export interface VaultWatcher {
  /**
   * Start watching. Handler is called for each FS event after debounce.
   * Each call to start() replaces any previous handler.
   */
  start(handler: (event: FileEvent) => void): void;

  /** Stop watching and release underlying OS resources. */
  stop(): void;
}

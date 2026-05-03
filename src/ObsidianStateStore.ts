import type { StateStore } from "./types";

/**
 * localStorage-backed StateStore for the Obsidian plugin.
 * Survives plugin reloads (localStorage persists across Obsidian restarts).
 */
export class ObsidianStateStore implements StateStore {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // localStorage full or unavailable, non-critical
    }
  }
}

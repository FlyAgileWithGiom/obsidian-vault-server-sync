/**
 * Tests for isPathExcluded — the shared path-exclusion predicate.
 *
 * Covers both slash-terminated and plain patterns to ensure trailing-slash
 * normalisation works correctly. The word-boundary guard (pat + "/") means a
 * pattern like ".trash/" must not accidentally exclude ".trasher/" or
 * "Notes/.trashcan.md".
 */

import { describe, it, expect } from "vitest";
import { isPathExcluded } from "./exclude";

describe("isPathExcluded — trailing-slash patterns", () => {
  it(".trash/ excludes a direct child", () => {
    expect(isPathExcluded(".trash/foo.md", [".trash/"])).toBe(true);
  });

  it(".trash/ excludes a nested path", () => {
    expect(isPathExcluded(".trash/backup/x.md", [".trash/"])).toBe(true);
  });

  it(".trash/ excludes the directory itself (exact match without slash)", () => {
    // relPath is the bare dir name as the OS hands it to fs.watch
    expect(isPathExcluded(".trash", [".trash/"])).toBe(true);
  });

  it(".trash/ does NOT exclude a sibling folder .trasher/", () => {
    expect(isPathExcluded(".trasher/x.md", [".trash/"])).toBe(false);
  });

  it(".trash/ does NOT exclude a deep note whose path contains 'trash' mid-segment", () => {
    expect(isPathExcluded("Notes/.trashcan.md", [".trash/"])).toBe(false);
  });

  it(".obsidian/ excludes a deeply nested plugin file", () => {
    expect(isPathExcluded(".obsidian/plugins/calendar/main.js", [".obsidian/"])).toBe(true);
  });

  it(".git/ excludes .git/HEAD", () => {
    expect(isPathExcluded(".git/HEAD", [".git/"])).toBe(true);
  });
});

describe("isPathExcluded — non-slash patterns", () => {
  it(".DS_Store (no slash) excludes exactly .DS_Store", () => {
    expect(isPathExcluded(".DS_Store", [".DS_Store"])).toBe(true);
  });

  it(".DS_Store does NOT exclude .DS_Store_notes.md", () => {
    expect(isPathExcluded(".DS_Store_notes.md", [".DS_Store"])).toBe(false);
  });

  it(".vault-sync.json excludes the exact file", () => {
    expect(isPathExcluded(".vault-sync.json", [".vault-sync.json"])).toBe(true);
  });

  it("a normal note is not excluded by any pattern", () => {
    const patterns = [".trash/", ".obsidian/", ".git/", ".DS_Store", ".vault-sync.json"];
    expect(isPathExcluded("Real Note.md", patterns)).toBe(false);
    expect(isPathExcluded("folder/My Note.md", patterns)).toBe(false);
  });
});

describe("isPathExcluded — mixed pattern list (real-world config)", () => {
  const realPatterns = [".trash/", ".obsidian/", ".git/", ".DS_Store"];

  it("excludes .trash/daily-note.md", () => {
    expect(isPathExcluded(".trash/daily-note.md", realPatterns)).toBe(true);
  });

  it("excludes .obsidian/workspace.json", () => {
    expect(isPathExcluded(".obsidian/workspace.json", realPatterns)).toBe(true);
  });

  it("excludes .git/COMMIT_EDITMSG", () => {
    expect(isPathExcluded(".git/COMMIT_EDITMSG", realPatterns)).toBe(true);
  });

  it("excludes .DS_Store at vault root", () => {
    expect(isPathExcluded(".DS_Store", realPatterns)).toBe(true);
  });

  it("does NOT exclude a regular note", () => {
    expect(isPathExcluded("Projects/Work/meeting-notes.md", realPatterns)).toBe(false);
  });
});

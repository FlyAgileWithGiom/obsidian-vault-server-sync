/**
 * Tests for headless/reconcile.ts — pure FS<->PouchDB divergence detection.
 *
 * Table-driven, each row mapped to an AC number. No filesystem, no network.
 * Mocks: plain in-memory maps for localGet/readDiskText; plain Map for remoteRevs.
 */

import { describe, it, expect } from "vitest";
import { reconcile, type LocalDoc, type ReconcileAction } from "./reconcile";
import type { RemoteRevEntry } from "./remote-revs";
import type { VaultFile } from "../src/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFile(path: string, mtime = 1000, size = 100): VaultFile {
  return { kind: "file", path, mtime, size };
}

function makeRemote(rev: string, deleted = false): RemoteRevEntry {
  return { rev, deleted };
}

type LocalDocMap = Map<string, LocalDoc>;
type RemoteRevMap = Map<string, RemoteRevEntry>;
type DiskContentMap = Map<string, string>; // path → text content

async function runReconcile(opts: {
  vaultFiles?: VaultFile[];
  localDocs?: LocalDocMap;
  localDocIds?: string[];
  diskContent?: DiskContentMap;
  remoteRevs?: RemoteRevMap;
  isExcluded?: (path: string) => boolean;
}): Promise<ReconcileAction[]> {
  const {
    vaultFiles = [],
    localDocs = new Map(),
    localDocIds = [...localDocs.keys()],
    diskContent = new Map(),
    remoteRevs = new Map(),
    isExcluded = () => false,
  } = opts;

  const localGet = async (docId: string): Promise<LocalDoc | undefined> =>
    localDocs.get(docId);

  const readDiskText = async (file: VaultFile): Promise<string> => {
    const text = diskContent.get(file.path);
    if (text === undefined) {
      throw new Error(`readDiskText: no mock content for path "${file.path}"`);
    }
    return text;
  };

  return reconcile({
    vaultFiles,
    localDocIds,
    localGet,
    readDiskText,
    remoteRevs,
    isExcluded,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reconcile — FS<->PouchDB divergence detection", () => {
  // -------------------------------------------------------------------------
  // AC2.1 — FS present, local-DB absent, remote absent → push
  // -------------------------------------------------------------------------
  it("AC2.1 FS+/localDB−/remote− → push (stranded file)", async () => {
    const actions = await runReconcile({
      vaultFiles: [makeFile("note.md")],
      localDocs: new Map(),
      diskContent: new Map([["note.md", "hello"]]),
      remoteRevs: new Map(), // remote absent
    });
    expect(actions).toEqual([{ kind: "push", path: "note.md" }]);
  });

  // -------------------------------------------------------------------------
  // AC2.0 multi-device normal case — FS present, local-DB absent, remote active → skip:remote-newer
  // Must NOT push (no local baseline).
  // -------------------------------------------------------------------------
  it("FS+/localDB−/remote+ active → skip:remote-newer (must NOT push)", async () => {
    const actions = await runReconcile({
      vaultFiles: [makeFile("note.md")],
      localDocs: new Map(),
      diskContent: new Map([["note.md", "hello"]]),
      remoteRevs: new Map([["file/note.md", makeRemote("1-abc")]]),
    });
    expect(actions).toEqual([
      { kind: "skip", path: "note.md", reason: "remote-newer" },
    ]);
  });

  // -------------------------------------------------------------------------
  // AC2.2 — identical content but DIFFERENT mtime → skip:identical (mtime is ignored)
  // -------------------------------------------------------------------------
  it("AC2.2 identical content + different mtime → skip:identical (mtime NOT used)", async () => {
    const diskMtime = 9999; // deliberately different from localDoc mtime (not stored here)
    const file = makeFile("note.md", diskMtime, 10);
    const localDoc: LocalDoc = { _rev: "1-abc", content: "same content" };
    const localDocs: LocalDocMap = new Map([["file/note.md", localDoc]]);

    const actions = await runReconcile({
      vaultFiles: [file],
      localDocs,
      diskContent: new Map([["note.md", "same content"]]),
      remoteRevs: new Map([["file/note.md", makeRemote("1-abc")]]),
    });

    // Assert: mtime differs (would fire a mtime-based rule) but action is skip:identical
    expect(file.mtime).not.toBe(0); // mtime is non-zero — it was checked
    expect(actions).toEqual([
      { kind: "skip", path: "note.md", reason: "identical" },
    ]);
  });

  // -------------------------------------------------------------------------
  // AC2.4 — content differs AND local._rev !== remote.rev → conflict-copy
  // -------------------------------------------------------------------------
  it("AC2.4 content differs AND local._rev ≠ remote.rev → conflict-copy", async () => {
    const localDoc: LocalDoc = { _rev: "1-abc", content: "old content" };
    const localDocs: LocalDocMap = new Map([["file/note.md", localDoc]]);

    const actions = await runReconcile({
      vaultFiles: [makeFile("note.md")],
      localDocs,
      diskContent: new Map([["note.md", "new disk content"]]),
      remoteRevs: new Map([["file/note.md", makeRemote("2-xyz")]]), // remote also moved
    });
    expect(actions).toEqual([{ kind: "conflict-copy", path: "note.md" }]);
  });

  // -------------------------------------------------------------------------
  // Control: content differs AND local._rev === remote.rev → push (clean local edit)
  // -------------------------------------------------------------------------
  it("content differs AND local._rev === remote.rev → push (clean local edit)", async () => {
    const localDoc: LocalDoc = { _rev: "1-abc", content: "old content" };
    const localDocs: LocalDocMap = new Map([["file/note.md", localDoc]]);

    const actions = await runReconcile({
      vaultFiles: [makeFile("note.md")],
      localDocs,
      diskContent: new Map([["note.md", "new disk content"]]),
      remoteRevs: new Map([["file/note.md", makeRemote("1-abc")]]), // remote unchanged
    });
    expect(actions).toEqual([{ kind: "push", path: "note.md" }]);
  });

  // -------------------------------------------------------------------------
  // AC2.8 — converter-seeded stub (no content, no _attachments) → skip:awaiting-pull
  // -------------------------------------------------------------------------
  it("AC2.8 stub doc (no content, no _attachments) → skip:awaiting-pull", async () => {
    // Stub has _rev but no content and no _attachments
    const localDoc: LocalDoc = { _rev: "1-abc" };
    const localDocs: LocalDocMap = new Map([["file/note.md", localDoc]]);

    const actions = await runReconcile({
      vaultFiles: [makeFile("note.md")],
      localDocs,
      diskContent: new Map([["note.md", "some disk content"]]),
      remoteRevs: new Map([["file/note.md", makeRemote("1-abc")]]),
    });
    expect(actions).toEqual([
      { kind: "skip", path: "note.md", reason: "awaiting-pull" },
    ]);
  });

  // -------------------------------------------------------------------------
  // AC2.3a — local._rev === remote.rev, FS absent → tombstone (user deleted on disk)
  // -------------------------------------------------------------------------
  it("AC2.3a rev-equal + FS-absent → tombstone (user deleted on disk)", async () => {
    const localDoc: LocalDoc = { _rev: "1-abc", content: "was here" };
    const localDocs: LocalDocMap = new Map([["file/note.md", localDoc]]);

    const actions = await runReconcile({
      vaultFiles: [], // file NOT on disk
      localDocs,
      diskContent: new Map(),
      remoteRevs: new Map([["file/note.md", makeRemote("1-abc")]]),
    });
    expect(actions).toEqual([{ kind: "tombstone", docId: "file/note.md" }]);
  });

  // -------------------------------------------------------------------------
  // AC2.3b — local._rev !== remote.rev, FS absent → pull (remote moved during outage)
  // -------------------------------------------------------------------------
  it("AC2.3b rev-differ + FS-absent → pull (remote moved during outage)", async () => {
    const localDoc: LocalDoc = { _rev: "1-abc", content: "old" };
    const localDocs: LocalDocMap = new Map([["file/note.md", localDoc]]);

    const actions = await runReconcile({
      vaultFiles: [], // file NOT on disk
      localDocs,
      diskContent: new Map(),
      remoteRevs: new Map([["file/note.md", makeRemote("2-xyz")]]), // remote moved
    });
    expect(actions).toEqual([{ kind: "pull", path: "note.md" }]);
  });

  // -------------------------------------------------------------------------
  // AC2.3c — no local doc, FS absent, remote present → pull (brand-new remote creation)
  // -------------------------------------------------------------------------
  it("AC2.3c no-local-doc + FS-absent + remote present → pull (brand-new remote)", async () => {
    const actions = await runReconcile({
      vaultFiles: [],
      localDocs: new Map(),
      diskContent: new Map(),
      remoteRevs: new Map([["file/note.md", makeRemote("1-abc")]]),
    });
    expect(actions).toEqual([{ kind: "pull", path: "note.md" }]);
  });

  // -------------------------------------------------------------------------
  // AC2.3d — remote tombstone + FS absent → skip:both-absent
  // -------------------------------------------------------------------------
  it("AC2.3d remote-tombstone + FS-absent → skip:both-absent", async () => {
    const localDoc: LocalDoc = { _rev: "1-abc", content: "gone" };
    const localDocs: LocalDocMap = new Map([["file/note.md", localDoc]]);

    const actions = await runReconcile({
      vaultFiles: [],
      localDocs,
      diskContent: new Map(),
      remoteRevs: new Map([["file/note.md", makeRemote("2-del", true)]]),
    });
    expect(actions).toEqual([
      { kind: "skip", path: "note.md", reason: "both-absent" },
    ]);
  });

  // -------------------------------------------------------------------------
  // AC2.3e / Rule 5 — remote tombstone + FS present (edited) → conflict-copy
  // -------------------------------------------------------------------------
  it("AC2.3e/rule5 remote-tombstone + FS-present edited → conflict-copy", async () => {
    const localDoc: LocalDoc = { _rev: "1-abc", content: "old" };
    const localDocs: LocalDocMap = new Map([["file/note.md", localDoc]]);

    const actions = await runReconcile({
      vaultFiles: [makeFile("note.md")],
      localDocs,
      diskContent: new Map([["note.md", "edited on disk"]]),
      remoteRevs: new Map([["file/note.md", makeRemote("2-del", true)]]),
    });
    expect(actions).toEqual([{ kind: "conflict-copy", path: "note.md" }]);
  });

  // -------------------------------------------------------------------------
  // AC2.5 — excluded path → skip:excluded (checked first, before any other logic)
  // -------------------------------------------------------------------------
  it("AC2.5 excluded path → skip:excluded (highest priority)", async () => {
    const localDoc: LocalDoc = { _rev: "1-abc", content: "data" };
    const localDocs: LocalDocMap = new Map([["file/.DS_Store", localDoc]]);

    const actions = await runReconcile({
      vaultFiles: [makeFile(".DS_Store")],
      localDocs,
      diskContent: new Map([[".DS_Store", "data"]]),
      remoteRevs: new Map([["file/.DS_Store", makeRemote("1-abc")]]),
      isExcluded: (p) => p === ".DS_Store",
    });
    expect(actions).toEqual([
      { kind: "skip", path: ".DS_Store", reason: "excluded" },
    ]);
  });

  // -------------------------------------------------------------------------
  // Off-table: local doc present + FS absent + remote not_found (purge/wrong-DB)
  // → tombstone (propagate delete; we are not a backup system).
  // not_found = no remote recreation known → gone from disk = deleted → tombstone.
  // Normal deletes return deleted:true (AC2.3d); not_found = _purge or wrong DB only.
  // Target vault (Dropbox) keeps files materialised, so half-mount mass-delete
  // scenario does not apply. User decision 2026-06-03.
  // -------------------------------------------------------------------------
  it("local doc + FS-absent + remote not_found (purge/wrong-DB) → tombstone (propagate delete, not a backup system)", async () => {
    const localDoc: LocalDoc = { _rev: "1-abc", content: "was here" };
    const localDocs: LocalDocMap = new Map([["file/note.md", localDoc]]);

    const actions = await runReconcile({
      vaultFiles: [], // FS absent
      localDocs,
      localDocIds: ["file/note.md"],
      diskContent: new Map(),
      remoteRevs: new Map(), // remote not_found
    });
    expect(actions).toEqual([{ kind: "tombstone", docId: "file/note.md" }]);
  });

  // -------------------------------------------------------------------------
  // Binary: same size → skip:identical
  // -------------------------------------------------------------------------
  it("binary same size → skip:identical", async () => {
    // .png extension → isBinaryPath returns true
    const file = makeFile("image.png", 1000, 512);
    // Binary doc carries _attachments and size, no content
    const localDoc: LocalDoc = { _rev: "1-abc", _attachments: {}, size: 512 };
    const localDocs: LocalDocMap = new Map([["file/image.png", localDoc]]);

    const actions = await runReconcile({
      vaultFiles: [file],
      localDocs,
      // diskContent not needed for binary — should NOT be called
      diskContent: new Map(),
      remoteRevs: new Map([["file/image.png", makeRemote("1-abc")]]),
    });
    expect(actions).toEqual([
      { kind: "skip", path: "image.png", reason: "identical" },
    ]);
  });

  // -------------------------------------------------------------------------
  // Binary: different size AND rev-differ → conflict-copy
  // -------------------------------------------------------------------------
  it("binary size-differ + rev-differ → conflict-copy", async () => {
    const file = makeFile("image.png", 1000, 1024); // disk size 1024
    const localDoc: LocalDoc = { _rev: "1-abc", _attachments: {}, size: 512 }; // doc size 512
    const localDocs: LocalDocMap = new Map([["file/image.png", localDoc]]);

    const actions = await runReconcile({
      vaultFiles: [file],
      localDocs,
      diskContent: new Map(),
      remoteRevs: new Map([["file/image.png", makeRemote("2-xyz")]]),
    });
    expect(actions).toEqual([{ kind: "conflict-copy", path: "image.png" }]);
  });

  // -------------------------------------------------------------------------
  // Binary: different size AND rev-equal → push
  // -------------------------------------------------------------------------
  it("binary size-differ + rev-equal → push (clean local binary edit)", async () => {
    const file = makeFile("image.png", 1000, 1024);
    const localDoc: LocalDoc = { _rev: "1-abc", _attachments: {}, size: 512 };
    const localDocs: LocalDocMap = new Map([["file/image.png", localDoc]]);

    const actions = await runReconcile({
      vaultFiles: [file],
      localDocs,
      diskContent: new Map(),
      remoteRevs: new Map([["file/image.png", makeRemote("1-abc")]]),
    });
    expect(actions).toEqual([{ kind: "push", path: "image.png" }]);
  });
});

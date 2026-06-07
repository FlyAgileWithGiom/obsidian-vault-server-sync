/**
 * Regression test for BUG #79 — daemon crash loop on binary attachment write.
 *
 * The headless daemon uses pouchdb-node (LevelDB). PouchDbFsBridge read a vault
 * binary file as an ArrayBuffer (FilesystemVaultAdapter.readBinary) and handed it
 * straight to db.putAttachment(). pouchdb-browser tolerates a raw ArrayBuffer, but
 * pouchdb-node routes it to crypto.Hash.update(), which throws
 * `TypeError [ERR_INVALID_ARG_TYPE]` (wants Buffer/TypedArray/DataView/string).
 *
 * The unit-test mocks (hand-rolled in-memory putAttachment) never run pouchdb-node's
 * real prepareAttachmentForStorage/binaryMd5, so the Node-only crash was invisible.
 * This test therefore exercises a REAL pouchdb-node instance backed by a temp
 * LevelDB dir — the same construction the daemon uses (headless/main.ts).
 *
 * Entry point: reconcilePush() — the first-run reconcile push that crashed in
 * production. It awaits writeBinaryToPouch(), so the throw propagates as a rejection
 * (onVaultEvent's change branch swallows it via .catch(() => {}), which would hide RED).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { FilesystemVaultAdapter } from "./VaultAdapter";
import { PouchDbFsBridge } from "../src/PouchDbFsBridge";
import { pathToDocId } from "../src/doc-id";
import { ATTACHMENT_NAME } from "../src/binary-ext";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Non-critical: OS may clean up eventually
    }
  }
  tempDirs.length = 0;
});

describe("PouchDbFsBridge — binary attachment on real pouchdb-node (BUG #79)", () => {
  // A small PNG header — arbitrary binary bytes are enough to trigger the hash path.
  const ORIGINAL_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function setup() {
    const vaultDir = makeTempDir("bug79-vault-");
    const pouchDir = makeTempDir("bug79-pouch-");
    const vault = new FilesystemVaultAdapter(vaultDir);
    // Real pouchdb-node, constructed exactly as the daemon does (headless/main.ts:610).
    const PouchDB = require("pouchdb-node") as typeof import("pouchdb-node");
    const db = new PouchDB(pouchDir) as unknown as import("../src/pouchdb-browser").default;
    const bridge = new PouchDbFsBridge(vault, db);
    return { vaultDir, vault, db, bridge };
  }

  it("writes a vault binary file into pouchdb-node without crashing, and the attachment round-trips", async () => {
    const { vaultDir, db, bridge } = setup();

    // Write a binary file to the vault on disk (FilesystemVaultAdapter.readBinary
    // will return it as an ArrayBuffer — the type that crashed pouchdb-node).
    fs.writeFileSync(path.join(vaultDir, "image.png"), Buffer.from(ORIGINAL_BYTES));

    // reconcilePush awaits writeBinaryToPouch -> putAttachment. Pre-fix this rejects
    // with ERR_INVALID_ARG_TYPE; post-fix it resolves.
    await expect(bridge.reconcilePush("image.png")).resolves.toBeUndefined();

    // Round-trip: read the attachment bytes back out of real pouchdb-node and
    // assert they equal the original. pouchdb-node returns a Buffer.
    const docId = pathToDocId("image.png");
    const att = (await db.getAttachment(docId, ATTACHMENT_NAME)) as unknown as Buffer;
    expect(Buffer.isBuffer(att)).toBe(true);
    expect(Buffer.compare(att, Buffer.from(ORIGINAL_BYTES))).toBe(0);
  });
});

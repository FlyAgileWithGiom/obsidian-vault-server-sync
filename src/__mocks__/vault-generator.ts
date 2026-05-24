/**
 * Deterministic vault file generator for scenario tests.
 * Uses seeded RNG to produce reproducible paths and metadata without heap explosion.
 */

import type { VaultFile } from "../types";

/** Seeded LCG RNG — deterministic across runs */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // Park-Miller LCG
    s = Math.imul(1664525, s) + 1013904223;
    return (s >>> 0) / 2 ** 32;
  };
}

/**
 * Generate a list of VaultFile descriptors.
 * Text files: paths like "notes/file-{n}.md", mtime seeded, size 512.
 * Binary files: paths like "assets/bin-{n}.png", mtime seeded, size 4096.
 *
 * No actual file content is materialized — content generation is lazy
 * (the vault mock reads content on demand via seedDoc).
 */
export function makeVaultFiles(textCount: number, binaryCount: number): VaultFile[] {
  const rng = makePrng(0xdeadbeef);
  const files: VaultFile[] = [];

  for (let i = 0; i < textCount; i++) {
    const mtime = 1_000_000 + Math.floor(rng() * 1_000_000);
    files.push({
      kind: "file",
      path: `notes/file-${i}.md`,
      mtime,
      size: 512,
    });
  }

  for (let i = 0; i < binaryCount; i++) {
    const mtime = 2_000_000 + Math.floor(rng() * 1_000_000);
    files.push({
      kind: "file",
      path: `assets/bin-${i}.png`,
      mtime,
      size: 4096,
    });
  }

  return files;
}

/** Deterministic text content for a given doc index (O(1) heap) */
export function seedTextContent(n: number): string {
  // 512-byte deterministic string
  return `text-${n}-${"x".repeat(Math.max(0, 506 - String(n).length))}`;
}

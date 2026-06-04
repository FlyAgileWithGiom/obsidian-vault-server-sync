/**
 * Shared path-exclusion predicate for sync engine and headless daemon.
 *
 * Normalises trailing slashes in patterns before matching:
 *   ".trash/"  → treat as ".trash"
 *   ".DS_Store" → unchanged
 *
 * A path is excluded when:
 *   - relPath === pat          (exact match, e.g. the dir itself or a plain filename)
 *   - relPath.startsWith(pat + "/")  (prefix match — only a real path-segment boundary)
 *
 * The `pat + "/"` guard is the word-boundary: it prevents ".trash" from
 * accidentally matching ".trasher/x.md" or "Notes/.trashcan.md".
 */
export function isPathExcluded(relPath: string, patterns: string[]): boolean {
  return patterns.some((raw) => {
    const pat = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    return relPath === pat || relPath.startsWith(pat + "/");
  });
}

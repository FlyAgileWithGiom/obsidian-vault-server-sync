/**
 * Re-export shim — implementation lives in src/exclude.ts.
 * Kept here so headless/ importers (FsWatcher, main.ts) need no path changes.
 */
export { isPathExcluded } from "../src/exclude";

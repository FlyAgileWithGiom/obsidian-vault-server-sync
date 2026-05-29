import esbuild from "esbuild";
import { copyFileSync, chmodSync, existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const prod = process.argv[2] === "production";
const PLUGIN_DIR = join(homedir(), "ObsidianNotes/.obsidian/plugins/fly-vault-sync");
const PLUGIN_OUT = "dist/plugin";

function deploy() {
  if (existsSync(PLUGIN_DIR)) {
    // Copy all JS chunks from dist/plugin/ plus manifest and styles from root
    for (const f of readdirSync(PLUGIN_OUT)) {
      copyFileSync(join(PLUGIN_OUT, f), join(PLUGIN_DIR, f));
    }
    for (const f of ["manifest.json", "styles.css"]) {
      copyFileSync(f, join(PLUGIN_DIR, f));
    }
    console.log("Deployed to vault plugin dir");
  }
}

// --- Obsidian plugin build ---
// ESM + splitting: pouchdb-browser is placed in a separate chunk via dynamic import.
// The dynamic import expression in main.ts ensures esbuild splits pouchdb-browser
// into a lazy chunk (~130 KB) instead of inlining it into main.js (~42 KB).
const pluginContext = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  splitting: true,          // enable code splitting (requires ESM)
  format: "esm",            // splitting requires ESM output
  outdir: PLUGIN_OUT,       // splitting requires outdir, not outfile
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  target: "es2020",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  logLevel: "info",
  plugins: [{
    name: "deploy",
    setup(build) {
      build.onEnd(() => deploy());
    },
  }],
});

// --- Headless daemon build ---
// DAEMON_V2=1 path imports pouchdb-node which uses leveldown (native .node binary).
// leveldown and fsevents cannot be bundled — they must be required from node_modules
// at runtime. Mark them external so esbuild emits require("leveldown") instead of
// trying to inline the native bindings.
// fsevents is an optional transitive dep (macOS FSEvents via libuv) — externalize
// defensively to avoid bundle failures on non-macOS targets.
const headlessContext = await esbuild.context({
  entryPoints: ["headless/main.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/headless.js",
  // leveldown/fsevents: native bindings, cannot be bundled — resolved from node_modules at runtime
  // pouchdb-node: imports leveldown internally; must be resolved from node_modules at runtime
  // obsidian: Obsidian plugin API, unavailable in Node.js — imported type-only or guarded in PouchDbSyncEngine
  external: ["leveldown", "fsevents", "obsidian", "pouchdb-node"],
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  logLevel: "info",
  banner: {
    js: "#!/usr/bin/env node",
  },
  plugins: [{
    name: "chmod-headless",
    setup(build) {
      build.onEnd(() => {
        try {
          chmodSync("dist/headless.js", 0o755);
        } catch {
          // dist may not exist yet in watch mode
        }
      });
    },
  }],
});

// --- Migration CLI build ---
// Standalone script for the state.json -> PouchDB pre-migration gate check.
// Shares the same external set as the headless daemon — pouchdb-node is loaded
// at runtime from node_modules, not bundled (native leveldown bindings).
const migrateContext = await esbuild.context({
  entryPoints: ["headless/migrate-state-to-pouchdb.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/migrate-state-to-pouchdb.js",
  // Same externals as headless: native bindings + Obsidian API not available in Node
  external: ["leveldown", "fsevents", "obsidian", "pouchdb-node"],
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  logLevel: "info",
  banner: {
    js: "#!/usr/bin/env node",
  },
  plugins: [{
    name: "chmod-migrate",
    setup(build) {
      build.onEnd(() => {
        try {
          chmodSync("dist/migrate-state-to-pouchdb.js", 0o755);
        } catch { /* dist may not exist yet in watch mode */ }
      });
    },
  }],
});

if (prod) {
  await pluginContext.rebuild();
  await headlessContext.rebuild();
  await migrateContext.rebuild();
  process.exit(0);
} else {
  await pluginContext.watch();
  await headlessContext.watch();
  await migrateContext.watch();
}

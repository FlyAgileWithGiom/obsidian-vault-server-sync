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
// Headless daemon remains CJS Node — never imports PouchDbSyncStrategy.
const headlessContext = await esbuild.context({
  entryPoints: ["headless/main.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/headless.js",
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

if (prod) {
  await pluginContext.rebuild();
  await headlessContext.rebuild();
  process.exit(0);
} else {
  await pluginContext.watch();
  await headlessContext.watch();
}

import esbuild from "esbuild";
import { copyFileSync, chmodSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const prod = process.argv[2] === "production";
const PLUGIN_DIR = join(homedir(), "ObsidianNotes/.obsidian/plugins/fly-vault-sync");

function deploy() {
  if (existsSync(PLUGIN_DIR)) {
    for (const f of ["main.js", "manifest.json", "styles.css"]) {
      copyFileSync(f, join(PLUGIN_DIR, f));
    }
    console.log("Deployed to vault plugin dir");
  }
}

// --- Obsidian plugin build ---
const pluginContext = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2020",
  outfile: "main.js",
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
const headlessContext = await esbuild.context({
  entryPoints: ["headless/main.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/headless.js",
  external: ["chokidar"],
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

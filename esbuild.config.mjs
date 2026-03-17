import esbuild from "esbuild";

const prod = process.argv[2] === "production";

esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
  ],
  format: "cjs",
  target: "es2021",
  outfile: "main.js",
  minify: prod,
  treeShaking: true,
  sourcemap: prod ? false : "inline",
}).catch(() => process.exit(1));

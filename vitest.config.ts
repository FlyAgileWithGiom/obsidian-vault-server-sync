import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "headless/**/*.test.ts"],
    environmentMatchGlobs: [
      // Bridge and strategy tests need browser globals (localStorage, document, indexedDB)
      ["src/PouchDb*.test.ts", "jsdom"],
      ["src/strategy-factory.test.ts", "jsdom"],
    ],
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "src/__mocks__/obsidian.ts"),
    },
  },
});

import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    include: [
      "src/**/__tests__/**/*.test.{ts,tsx}",
      // The Worker lives outside src/ (it deploys separately), but it is the one
      // piece of the system that holds the Notion client secret. It gets tested.
      "worker/**/__tests__/**/*.test.ts",
    ],
    environmentMatchGlobs: [["src/renderer/**/*.test.tsx", "jsdom"]],
  },
  resolve: {
    alias: {
      "@renderer": resolve("src/renderer/src"),
    },
  },
});

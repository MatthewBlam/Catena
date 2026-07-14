import { resolve } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      rollupOptions: {
        external: ["better-sqlite3"],
      },
    },
    define: {
      "process.env.GOOGLE_CLIENT_ID": JSON.stringify(process.env.GOOGLE_CLIENT_ID ?? ""),
      "process.env.GOOGLE_CLIENT_SECRET": JSON.stringify(process.env.GOOGLE_CLIENT_SECRET ?? ""),
      "process.env.NOTION_CLIENT_ID": JSON.stringify(process.env.NOTION_CLIENT_ID ?? ""),
      "process.env.NOTION_CLIENT_SECRET": JSON.stringify(process.env.NOTION_CLIENT_SECRET ?? ""),
      "process.env.POSTHOG_API_KEY": JSON.stringify(process.env.POSTHOG_API_KEY ?? ""),
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        output: {
          manualChunks: {
            "vendor-react": ["react", "react-dom"],
            "vendor-icons": ["lucide-react"],
          },
        },
      },
    },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});

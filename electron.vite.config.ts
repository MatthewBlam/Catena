import { resolve } from "path";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

/**
 * The shipped CSP sets `connect-src 'none'` — accurate, because the renderer
 * makes no network calls (everything is IPC). But Vite's dev server needs a
 * websocket back to the renderer for HMR, which 'none' would block. Relax
 * connect-src for the dev server only (`apply: "serve"`); the built HTML that
 * actually ships is untouched and keeps 'none'.
 */
function devRelaxCsp(): Plugin {
  return {
    name: "commons-dev-relax-csp",
    apply: "serve",
    transformIndexHtml(html) {
      return html.replace("connect-src 'none'", "connect-src 'self' ws: wss:");
    },
  };
}

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      rollupOptions: {
        external: ["better-sqlite3"],
      },
    },
    // Everything inlined here is readable in the shipped bundle. That is fine for
    // a client id, a write-only PostHog key, and a Google *Desktop* client secret
    // (which Google explicitly designates non-confidential — PKCE is what secures
    // it). It was never fine for NOTION_CLIENT_SECRET, which is a genuinely
    // confidential credential; it now lives in the Worker and is absent from here.
    define: {
      "process.env.GOOGLE_CLIENT_ID": JSON.stringify(
        process.env.GOOGLE_CLIENT_ID ?? "",
      ),
      "process.env.GOOGLE_CLIENT_SECRET": JSON.stringify(
        process.env.GOOGLE_CLIENT_SECRET ?? "",
      ),
      "process.env.NOTION_CLIENT_ID": JSON.stringify(
        process.env.NOTION_CLIENT_ID ?? "",
      ),
      "process.env.NOTION_TOKEN_PROXY_URL": JSON.stringify(
        process.env.NOTION_TOKEN_PROXY_URL ?? "",
      ),
      "process.env.POSTHOG_API_KEY": JSON.stringify(
        process.env.POSTHOG_API_KEY ?? "",
      ),
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
    plugins: [react(), tailwindcss(), devRelaxCsp()],
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import webExtension from "@samrum/vite-plugin-web-extension";
import pkg from "./package.json";

export default defineConfig({
  plugins: [
    react(),
    webExtension({
      manifest: {
        name: pkg.name,
        description: pkg.description,
        version: pkg.version,
        manifest_version: 3,
        action: {
          default_popup: "src/popup/index.html",
          default_icon: {
            "16": "icon.png",
            "48": "icon.png",
            "128": "icon.png",
          },
        },
        background: {
          service_worker: "src/background/index.ts",
          type: "module" as const,
        },
        content_scripts: [
          {
            matches: ["<all_urls>"],
            js: ["src/content/index.ts"],
          },
        ],
        permissions: ["storage", "tabs"],
      } as any,
    }),
  ],
  build: {
    outDir: "dist/edge",
    emptyOutDir: true,
  },
});

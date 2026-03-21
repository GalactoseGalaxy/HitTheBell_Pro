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
        manifest_version: 2,
        browser_action: {
          default_popup: "src/popup/index.html",
          default_icon: "icon.png",
        },
        background: {
          scripts: ["src/background/index.ts"],
          persistent: false,
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
    outDir: "dist/firefox",
    emptyOutDir: true,
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import webExtension from "@samrum/vite-plugin-web-extension";

export default defineConfig({
  plugins: [
    react(),
    webExtension({
      manifest: {
        manifest_version: 2,
        name: "HitTheBell Pro",
        version: "1.0.0",
        description: "A browser extension built with React and TypeScript.",
        icons: {
          "16": "icon.png",
          "48": "icon.png",
          "128": "icon.png",
        },
        browser_action: {
          default_popup: "src/popup/index.html",
          default_icon: {
            "16": "icon.png",
            "48": "icon.png",
            "128": "icon.png",
          },
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
        permissions: [
          "storage",
          "tabs",
          "contextMenus",
          "https://www.youtube.com/*",
          "https://www.googleapis.com/*",
        ],
      } as any,
    }),
  ],
  build: {
    outDir: "dist/firefox",
    emptyOutDir: true,
  },
});

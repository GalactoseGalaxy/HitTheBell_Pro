import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import webExtension from "@samrum/vite-plugin-web-extension";

export default defineConfig({
  plugins: [
    react(),
    webExtension({
      manifest: {
        name: "HitTheBell Pro",
        description: "A browser extension built with React and TypeScript.",
        version: "1.0.0",
        manifest_version: 3,
        icons: {
          "16": "icon.png",
          "48": "icon.png",
          "128": "icon.png",
        },
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
        permissions: [
          "storage",
          "tabs",
          "contextMenus",
          "scripting",
          "notifications",
        ],
        host_permissions: [
          "https://www.youtube.com/*",
          "https://www.googleapis.com/*",
        ],
      } as any,
    }),
  ],
  build: {
    outDir: "dist/chrome",
    emptyOutDir: true,
  },
});

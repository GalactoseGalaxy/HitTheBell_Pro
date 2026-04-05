import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import webExtension from "@samrum/vite-plugin-web-extension";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
            matches: ["*://youtube.com/*", "*://*.youtube.com/*"],
            js: ["src/content/index.ts"],
          },
        ],
        web_accessible_resources: [
          "assets/*",
          "assets/*/*",
          "assets/*/*/*",
        ],
        content_security_policy: "script-src 'self'; object-src 'self'",
        permissions: [
          "storage",
          "tabs",
          "windows",
          "contextMenus",
          "alarms",
          "notifications",
          "https://youtube.com/*",
          "https://*.youtube.com/*",
          "https://www.youtube.com/*",
          "https://www.googleapis.com/*",
        ],
      } as Record<string, unknown>,
    }),
  ],
  build: {
    outDir: "dist/firefox",
    emptyOutDir: true,
  },
});

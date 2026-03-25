import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import webExtension from "@samrum/vite-plugin-web-extension";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    webExtension({
      useDynamicUrlWebAccessibleResources: false,
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
            matches: ["*://youtube.com/*", "*://*.youtube.com/*"],
            js: ["src/content/index.ts"],
          },
        ],
        web_accessible_resources: [
          {
            resources: ["assets/*", "assets/*/*", "assets/*/*/*"],
            matches: ["*://youtube.com/*", "*://*.youtube.com/*"],
          },
        ],
        permissions: [
          "storage",
          "tabs",
          "contextMenus",
          "alarms",
          "notifications",
        ],
        host_permissions: [
          "https://youtube.com/*",
          "https://*.youtube.com/*",
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

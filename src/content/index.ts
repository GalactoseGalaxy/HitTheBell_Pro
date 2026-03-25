import browser from "webextension-polyfill";
import type { ExtensionMessage } from "../types";

browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as ExtensionMessage;
  if (msg.type !== "SHOW_TOAST") return;
  showToast(msg.message, msg.level);
});

function showToast(message: string, type: "success" | "error" | "info"): void {
  const colors = {
    success: "#4CAF50",
    error: "#f44336",
    info: "#2196F3",
  };

  const toast = document.createElement("div");
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: ${colors[type]};
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 14px;
    font-family: sans-serif;
    z-index: 999999;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    opacity: 1;
    transition: opacity 0.3s;
  `;

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

import browser from "webextension-polyfill";
import type { ExtensionMessage } from "../types";

browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as ExtensionMessage;
  if (msg.type !== "SHOW_TOAST") return;
  showToast(msg.message, msg.level);
});

const FOLLOW_MENU_ITEM_ID = "hit-the-bell-follow-menu-item";
const MENU_TEXT = "Hit the Bell";
const ICON_URL = (typeof browser !== "undefined"
  ? browser.runtime.getURL("icon.svg")
  : (globalThis as { chrome?: { runtime: { getURL: (path: string) => string } } })
      .chrome?.runtime.getURL("icon.svg") ?? "");


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

async function followCurrentChannel(): Promise<void> {
  try {
    const result = (await browser.runtime.sendMessage({
      type: "FOLLOW_CHANNEL_FROM_CONTEXT",
      pageUrl: window.location.href,
    } satisfies ExtensionMessage)) as { channel?: { name?: string } } | null;

    if (result?.channel?.name) {
      showToast(`Now following ${result.channel.name}`, "success");
      return;
    }

    showToast("Channel followed.", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Follow failed.";
    showToast(message, "error");
  }
}

function listLooksLikeBellMenu(list: Element): boolean {
  const labels = Array.from(list.querySelectorAll("yt-formatted-string"))
    .map((node) => node.textContent?.trim() ?? "")
    .filter(Boolean);

  return (
    labels.includes("All") &&
    labels.includes("Personalized") &&
    labels.includes("None")
  );
}

function findMenuListInRoot(root: ParentNode): HTMLElement | null {
  const candidates = Array.from(
    root.querySelectorAll("tp-yt-paper-listbox#items, tp-yt-paper-listbox"),
  );

  for (const list of candidates) {
    if (listLooksLikeBellMenu(list)) {
      return list as HTMLElement;
    }
  }

  return null;
}

function findMenuList(): HTMLElement | null {
  const fromDocument = findMenuListInRoot(document);
  if (fromDocument) return fromDocument;

  const renderers = Array.from(
    document.querySelectorAll("ytd-menu-popup-renderer"),
  );
  for (const renderer of renderers) {
    const root = renderer.shadowRoot;
    if (!root) continue;
    const fromShadow = findMenuListInRoot(root);
    if (fromShadow) return fromShadow;
  }

  return null;
}

function updateMenuLabel(item: Element, text: string): void {
  const existingLabel = item.querySelector(
    "yt-formatted-string",
  ) as HTMLElement | null;
  if (existingLabel) {
    existingLabel.setAttribute("hidden", "");
  }

  const existingSpan = item.querySelector(
    "span[data-hit-the-bell-label]",
  ) as HTMLSpanElement | null;
  if (existingSpan) {
    existingSpan.textContent = text;
    return;
  }

  const span = document.createElement("span");
  span.dataset.hitTheBellLabel = "true";
  span.textContent = text;
  span.style.fontSize = "14px";
  span.style.fontWeight = "500";
  span.style.color = "var(--yt-spec-text-primary, #0f0f0f)";
  span.style.lineHeight = "20px";

  const itemRoot = item.querySelector("tp-yt-paper-item") ?? item;
  itemRoot.appendChild(span);
}

function updateMenuIcon(item: Element): void {
  const iconSlot = item.querySelector("yt-icon");
  const iconContainer = iconSlot || item.querySelector("tp-yt-paper-item");
  if (!iconContainer) return;

  if (iconSlot) {
    iconSlot.remove();
  }

  const existingIcon = iconContainer.querySelector(
    "[data-hit-the-bell-icon]",
  ) as HTMLElement | null;
  if (existingIcon) return;

  const iconSpan = document.createElement("span");
  iconSpan.dataset.hitTheBellIcon = "true";
  iconSpan.style.display = "inline-block";
  iconSpan.style.width = "24px";
  iconSpan.style.height = "24px";
  iconSpan.style.marginRight = "12px";
  iconSpan.style.flexShrink = "0";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 300 300");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.style.display = "block";

  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute(
    "transform",
    "translate(0,300) scale(0.1,-0.1)",
  );
  group.setAttribute("fill", "#ff0000");
  group.setAttribute("stroke", "none");

  const path1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path1.setAttribute(
    "d",
    "M1405 2904 c-79 -41 -108 -92 -115 -203 l-5 -84 -82 -27 c-87 -29 -194 -84 -258 -133 -151 -115 -280 -294 -329 -457 -41 -135 -46 -200 -46 -645 l0 -430 -140 -140 -140 -140 0 -72 0 -73 1210 0 1210 0 0 74 0 74 -144 138 -145 137 -3 476 -4 476 -27 88 c-34 109 -58 163 -115 252 -113 177 -299 318 -501 381 l-61 19 0 58 c0 31 0 59 0 62 -1 3 -8 24 -16 47 -18 51 -66 104 -113 124 -44 19 -138 18 -176 -2z",
  );
  const path2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path2.setAttribute(
    "d",
    "M569 2887 c-161 -122 -327 -330 -421 -525 -74 -156 -129 -357 -141 -519 l-4 -53 137 0 137 0 16 103 c33 199 94 350 208 517 62 91 160 196 240 257 l49 37 -97 98 c-54 54 -100 98 -103 98 -3 0 -12 -6 -21 -13z",
  );
  const path3 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path3.setAttribute(
    "d",
    "M2307 2802 l-97 -98 67 -58 c241 -205 392 -487 428 -798 l6 -58 140 0 140 0 -6 58 c-32 291 -125 537 -288 758 -53 73 -238 263 -273 282 -18 10 -31 0 -117 -86z",
  );
  const path4 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path4.setAttribute(
    "d",
    "M1498 352 l-278 -2 0 -33 c0 -45 44 -130 88 -168 62 -55 114 -72 201 -67 92 6 143 29 198 92 38 43 79 139 71 168 -2 10 -61 12 -280 10z",
  );

  group.appendChild(path1);
  group.appendChild(path2);
  group.appendChild(path3);
  group.appendChild(path4);
  svg.appendChild(group);
  iconSpan.appendChild(svg);

  const itemRoot = item.querySelector("tp-yt-paper-item") ?? item;
  (itemRoot as HTMLElement).style.alignItems = "center";
  itemRoot.insertBefore(iconSpan, itemRoot.firstChild);
}

function injectFollowMenuItem(): void {
  const list = findMenuList();
  if (!list) return;
  if (list.querySelector(`#${FOLLOW_MENU_ITEM_ID}`)) return;

  const firstItem = list.querySelector("ytd-menu-service-item-renderer");
  if (!firstItem) return;

  const clone = firstItem.cloneNode(true) as HTMLElement;
  clone.id = FOLLOW_MENU_ITEM_ID;
  clone.removeAttribute("hidden");
  clone.setAttribute("role", "menuitem");
  clone.setAttribute("aria-label", MENU_TEXT);

  updateMenuLabel(clone, MENU_TEXT);
  updateMenuIcon(clone);

  clone.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void followCurrentChannel();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });

  list.insertBefore(clone, list.firstChild);
}

const observer = new MutationObserver(() => {
  injectFollowMenuItem();
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

injectFollowMenuItem();

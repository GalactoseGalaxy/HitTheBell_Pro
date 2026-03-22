import browser from "webextension-polyfill";
import type { ExtensionMessage } from "../types";

const API_KEY = import.meta.env.VITE_YOUTUBE_API_KEY;

browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as ExtensionMessage;
  if (msg.type !== "GET_CHANNEL_ID") return;

  async function handle() {
    try {
      const channel = await findChannel(msg);
      if (!channel) {
        showToast("Could not find channel", "error");
        return;
      }

      await saveChannel(channel);
    } catch (error) {
      showToast("Something went wrong", "error");
      console.error(error);
    }
  }

  handle();
});

// Try to find channel from URLs
async function findChannel(
  msg: ExtensionMessage,
): Promise<{ id: string; name: string } | null> {
  const urls = [msg.linkUrl, msg.srcUrl, msg.pageUrl].filter(
    Boolean,
  ) as string[];

  for (const url of urls) {
    const channel = await fetchChannelFromUrl(url);
    if (channel) return channel;
  }

  return null;
}

// Parse URL and call API
async function fetchChannelFromUrl(
  url: string,
): Promise<{ id: string; name: string } | null> {
  const handleMatch = url.match(/\/@([\w-]+)/);
  const usernameMatch = url.match(/\/c\/([\w-]+)/);
  const channelMatch = url.match(/\/channel\/(UC[\w-]+)/);
  const videoMatch = url.match(/\/watch\?v=([\w-]+)/);

  let apiUrl: string | null = null;

  if (handleMatch) {
    apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forHandle=${handleMatch[1]}&key=${API_KEY}`;
  } else if (usernameMatch) {
    apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forUsername=${usernameMatch[1]}&key=${API_KEY}`;
  } else if (channelMatch) {
    apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet&id=${channelMatch[1]}&key=${API_KEY}`;
  } else if (videoMatch) {
    apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoMatch[1]}&key=${API_KEY}`;
  }

  if (!apiUrl) return null;

  const response = await fetch(apiUrl);
  const data = await response.json();

  if (!data.items?.[0]) return null;

  if (videoMatch) {
    const snippet = data.items[0].snippet;
    return { id: snippet.channelId, name: snippet.channelTitle };
  }

  return {
    id: data.items[0].id,
    name: data.items[0].snippet.title,
  };
}

// Save to storage
async function saveChannel(channel: {
  id: string;
  name: string;
}): Promise<void> {
  const result = await browser.storage.local.get("channels");
  const channels: { id: string; name: string }[] = Array.isArray(
    result["channels"],
  )
    ? result["channels"]
    : [];

  if (channels.some((c) => c.id === channel.id)) {
    showToast(`Already following ${channel.name}`, "info");
    return;
  }

  channels.push(channel);
  await browser.storage.local.set({ channels });
  showToast(`Now following ${channel.name}`, "success");
}

// Toast notification
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

import browser from "webextension-polyfill";
import {
  followChannelFromContext,
  markChannelLatestSeen,
  markChannelLatestUnseen,
  refreshAllChannels,
} from "../lib/channel-service";
import type { ExtensionMessage, ShowToastMessage } from "../types";

const REFRESH_ALARM_NAME = "refresh-followed-channels";
const REFRESH_PERIOD_MINUTES = 30;

async function ensureRefreshAlarm(): Promise<void> {
  await browser.alarms.clear(REFRESH_ALARM_NAME);
  await browser.alarms.create(REFRESH_ALARM_NAME, {
    periodInMinutes: REFRESH_PERIOD_MINUTES,
  });
}

async function sendToastToTab(
  tabId: number,
  message: string,
  level: ShowToastMessage["level"],
): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, {
      type: "SHOW_TOAST",
      message,
      level,
    } satisfies ShowToastMessage);
  } catch {
    // Ignore tabs without the YouTube content script.
  }
}

browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: "save-channel-id",
    title: "Follow Channel",
    contexts: ["link", "image", "video", "page"],
    documentUrlPatterns: ["*://youtube.com/*", "*://*.youtube.com/*"],
  });

  void ensureRefreshAlarm();
  void refreshAllChannels();
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "save-channel-id") return;
  if (!tab?.id) return;

  try {
    const result = await followChannelFromContext({
      srcUrl: info.srcUrl,
      linkUrl: info.linkUrl,
      pageUrl: info.pageUrl,
    });

    await sendToastToTab(
      tab.id,
      result.status === "followed"
        ? `Now following ${result.channel.name}`
        : `Already following ${result.channel.name}`,
      result.status === "followed" ? "success" : "info",
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Something went wrong";
    await sendToastToTab(tab.id, message, "error");
  }
});

browser.runtime.onStartup.addListener(() => {
  void ensureRefreshAlarm();
  void refreshAllChannels();
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== REFRESH_ALARM_NAME) return;
  void refreshAllChannels();
});

browser.runtime.onMessage.addListener((message: unknown) => {
  const input = message as ExtensionMessage;

  if (input.type === "FOLLOW_CHANNEL_FROM_CONTEXT") {
    return followChannelFromContext(input);
  }

  if (input.type === "REFRESH_ALL_CHANNELS") {
    return refreshAllChannels();
  }

  if (input.type === "MARK_CHANNEL_LATEST_SEEN") {
    return markChannelLatestSeen(input.channelId);
  }

  if (input.type === "MARK_CHANNEL_LATEST_UNSEEN") {
    return markChannelLatestUnseen(input.channelId);
  }

  return undefined;
});

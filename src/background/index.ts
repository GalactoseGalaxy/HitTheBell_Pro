import browser from "webextension-polyfill";
import {
  followChannelFromContext,
  markChannelLatestSeen,
  markChannelLatestUnseen,
  refreshAllChannels,
} from "../lib/channel-service";
import { fetchAndMergeRemoteChannels, getChannels } from "../lib/storage";
import type {
  ExtensionMessage,
  RefreshAllChannelsMessage,
  ShowToastMessage,
} from "../types";

const REFRESH_ALARM_NAME = "refresh-followed-channels";
const REFRESH_PERIOD_MINUTES = 30;
type RefreshReason = RefreshAllChannelsMessage["reason"];

const NOTIFY_REASONS = new Set<NonNullable<RefreshReason>>([
  "alarm",
  "startup",
]);
const notificationTargets = new Map<string, { url: string; channelId: string }>();

function buildVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

async function injectContentScripts(): Promise<void> {
  if (!browser.scripting?.executeScript) return;

  const tabs = await browser.tabs.query({
    url: ["*://youtube.com/*", "*://*.youtube.com/*"],
  });

  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === "number")
      .map((tab) =>
        browser.scripting
          .executeScript({
            target: { tabId: tab.id as number },
            files: ["src/content/index.js"],
          })
          .catch(() => undefined),
      ),
  );
}

async function canShowNotifications(): Promise<boolean> {
  if (!browser.notifications?.create) return false;
  if (!browser.permissions?.contains) return true;
  try {
    return await browser.permissions.contains({ permissions: ["notifications"] });
  } catch {
    return true;
  }
}

async function updateBadgeFromChannels(
  channels: Awaited<ReturnType<typeof getChannels>>,
) {
  const count = channels.filter(
    (channel) =>
      channel.latestVideo && channel.lastSeenVideoId !== channel.latestVideo.id,
  ).length;

  const text = count > 0 ? (count > 99 ? "99+" : String(count)) : "";
  const badgeColor = "#ff4e45";

  try {
    if (browser.action?.setBadgeText) {
      await browser.action.setBadgeText({ text });
      await browser.action.setBadgeBackgroundColor({ color: badgeColor });
      return;
    }

    if (browser.browserAction?.setBadgeText) {
      await browser.browserAction.setBadgeText({ text });
      await browser.browserAction.setBadgeBackgroundColor({ color: badgeColor });
    }
  } catch {
    // Ignore badge errors for browsers that don't support it.
  }
}

async function refreshAndMaybeNotify(
  reason: RefreshReason | undefined,
  force?: boolean,
): Promise<ReturnType<typeof refreshAllChannels>> {
  const result = await refreshAllChannels({ force });
  const channels = await getChannels();
  await updateBadgeFromChannels(channels);
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));

  if (!reason || !NOTIFY_REASONS.has(reason)) {
    return result;
  }

  const allowNotifications = await canShowNotifications();
  if (!allowNotifications) {
    return result;
  }

  for (const outcome of result.outcomes) {
    if (outcome.type !== "new_upload" || !outcome.currentVideoId) continue;
    const channel = channelById.get(outcome.channelId);
    if (!channel?.latestVideo) continue;

    const notificationId = `new-upload-${channel.id}-${channel.latestVideo.id}`;
    notificationTargets.set(notificationId, {
      url: buildVideoUrl(channel.latestVideo.id),
      channelId: channel.id,
    });

    try {
      await browser.notifications.create(notificationId, {
        type: "basic",
        iconUrl: browser.runtime.getURL("icon.png"),
        title: "New upload",
        message: `${channel.name}: ${channel.latestVideo.title}`,
      });
    } catch {
      // Ignore notification errors if permissions are missing or blocked.
    }
  }

  return result;
}

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
  void fetchAndMergeRemoteChannels();
  void getChannels().then(updateBadgeFromChannels);
  browser.contextMenus.create({
    id: "save-channel-id",
    title: "Follow Channel",
    contexts: ["link", "image", "video", "page"],
    documentUrlPatterns: ["*://youtube.com/*", "*://*.youtube.com/*"],
  });

  void ensureRefreshAlarm();
  void refreshAndMaybeNotify("startup");
  void injectContentScripts();
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
  void fetchAndMergeRemoteChannels();
  void getChannels().then(updateBadgeFromChannels);
  void refreshAndMaybeNotify("startup");
  void injectContentScripts();
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== REFRESH_ALARM_NAME) return;
  void refreshAndMaybeNotify("alarm");
});

browser.runtime.onMessage.addListener((message: unknown) => {
  const input = message as ExtensionMessage;

  if (input.type === "FOLLOW_CHANNEL_FROM_CONTEXT") {
    return followChannelFromContext(input);
  }

  if (input.type === "REFRESH_ALL_CHANNELS") {
    return refreshAndMaybeNotify(input.reason ?? "manual", input.force);
  }

  if (input.type === "MARK_CHANNEL_LATEST_SEEN") {
    return markChannelLatestSeen(input.channelId).then((result) => {
      void getChannels().then(updateBadgeFromChannels);
      return result;
    });
  }

  if (input.type === "MARK_CHANNEL_LATEST_UNSEEN") {
    return markChannelLatestUnseen(input.channelId).then((result) => {
      void getChannels().then(updateBadgeFromChannels);
      return result;
    });
  }

  if (input.type === "REINJECT_CONTENT") {
    void injectContentScripts();
    return true;
  }

  return undefined;
});

browser.notifications.onClicked.addListener((notificationId) => {
  const target = notificationTargets.get(notificationId);
  if (!target) return;
  notificationTargets.delete(notificationId);
  void browser.tabs.create({ url: target.url });
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" && areaName !== "local") return;
  if (!changes.channels) return;
  void getChannels().then(updateBadgeFromChannels);
});

browser.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;
  const url = tab.url ?? "";
  if (!url.includes("youtube.com")) return;
  void injectContentScripts();
});



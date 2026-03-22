import browser from "webextension-polyfill";

browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: "save-channel-id",
    title: "Follow Channel",
    contexts: ["link", "image", "video", "page"],
    documentUrlPatterns: ["https://www.youtube.com/*"],
  });
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "save-channel-id") return;
  if (!tab?.id) return;

  browser.tabs.sendMessage(tab.id, {
    type: "GET_CHANNEL_ID",
    srcUrl: info.srcUrl,
    linkUrl: info.linkUrl,
    pageUrl: info.pageUrl,
  });
});

import { useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";
import {
  fetchAndMergeRemoteChannels,
  getChannels,
  getPaddleCustomerId,
  getPopupSettings,
  getTrialAccessState,
  isChannelLatestSeen,
  mutateChannels,
  setPaddleCustomerId,
  setPopupSettings,
} from "../lib/storage";
import { shouldRefreshOnPopupOpen } from "../lib/channel-service";
import { fetchVideoDurations } from "../lib/youtube";
import { restorePurchase, startCheckout } from "../lib/billing";
import type { ExtensionMessage } from "../types";
import type { Channel, PopupSettings, TrialAccessState } from "../types/storage";

export default function Popup() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [unfollowing, setUnfollowing] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [excludeShortsRefreshCount, setExcludeShortsRefreshCount] = useState(0);
  const [excludeShortsCooldownUntil, setExcludeShortsCooldownUntil] = useState<
    number | null
  >(null);
  const [cooldownTick, setCooldownTick] = useState(Date.now());
  const [popupSettings, setPopupSettingsState] = useState<PopupSettings>({
    excludeShorts: false,
    themePreference: "system",
    debugForceLocked: false,
  });
  const [trialAccess, setTrialAccess] = useState<TrialAccessState | null>(null);
  const [paddleCustomerId, setPaddleCustomerIdState] = useState("");
  const [billingNotice, setBillingNotice] = useState<string | null>(null);
  const hydrateState = useRef({ running: false, hydratedIds: new Set<string>() });
  const iconUrl = browser.runtime.getURL("icon.png");
  const isDark =
    popupSettings.themePreference === "system"
      ? systemPrefersDark
      : popupSettings.themePreference === "dark";

  useEffect(() => {
    void browser.runtime.sendMessage({ type: "REINJECT_CONTENT" } satisfies ExtensionMessage);
    async function load(): Promise<{
      channels: Channel[];
      settings: PopupSettings;
      trialAccess: TrialAccessState;
    }> {
      setIsLoading(true);
      try {
        void fetchAndMergeRemoteChannels().catch(() => undefined);
      const [nextChannels, nextSettings, nextTrialAccess, nextPaddleId] =
          await Promise.all([
            getChannels(),
            getPopupSettings(),
            getTrialAccessState(),
            getPaddleCustomerId(),
          ]);
        setChannels(nextChannels);
        setPopupSettingsState(nextSettings);
        setTrialAccess(nextTrialAccess);
        setPaddleCustomerIdState(nextPaddleId ?? "");
        return {
          channels: nextChannels,
          settings: nextSettings,
          trialAccess: nextTrialAccess,
        };
      } finally {
        setIsLoading(false);
      }
    }

    function handleStorageChange(
      changes: Record<string, browser.Storage.StorageChange>,
      areaName: string,
    ): void {
      if (areaName !== "sync") return;
      if (
        !changes.channels &&
        !changes.popupSettings &&
        !changes.trialStartDate &&
        !changes.hasPaidAccess
      ) {
        return;
      }
      void load();
    }

    async function refreshOnOpen(): Promise<void> {
      const {
        channels: nextChannels,
        trialAccess: nextTrialAccess,
        settings: nextSettings,
      } = await load();
      if (nextTrialAccess.status === "expired") {
        return;
      }
      if (nextSettings.debugForceLocked) {
        return;
      }
      void hydrateMissingDurations(nextChannels);
      if (!shouldRefreshOnPopupOpen(nextChannels)) {
        return;
      }

      setIsRefreshing(true);
      try {
        await browser.runtime.sendMessage({
          type: "REFRESH_ALL_CHANNELS",
          reason: "popup-open",
        } satisfies ExtensionMessage);
      } finally {
        setIsRefreshing(false);
        const { channels: refreshedChannels } = await load();
        void hydrateMissingDurations(refreshedChannels);
      }
    }

    void refreshOnOpen();
    browser.storage.onChanged.addListener(handleStorageChange);

    return () => {
      browser.storage.onChanged.removeListener(handleStorageChange);
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = (event?: MediaQueryListEvent): void => {
      setSystemPrefersDark(event ? event.matches : mediaQuery.matches);
    };

    syncTheme();
    mediaQuery.addEventListener("change", syncTheme);

    return () => {
      mediaQuery.removeEventListener("change", syncTheme);
    };
  }, []);

  useEffect(() => {
    if (!excludeShortsCooldownUntil) return;

    const interval = window.setInterval(() => {
      const now = Date.now();
      setCooldownTick(now);
      if (now >= excludeShortsCooldownUntil) {
        setExcludeShortsCooldownUntil(null);
        setExcludeShortsRefreshCount(0);
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [excludeShortsCooldownUntil]);

  async function hydrateMissingDurations(
    nextChannels: Channel[],
  ): Promise<void> {
    if (hydrateState.current.running) return;

    const missingIds = nextChannels
      .map((channel) =>
        channel.latestVideo && !channel.latestVideo.duration
          ? channel.latestVideo.id
          : null,
      )
      .filter((id): id is string => Boolean(id))
      .filter((id) => !hydrateState.current.hydratedIds.has(id));

    if (missingIds.length === 0) return;

    hydrateState.current.running = true;
    try {
      for (let i = 0; i < missingIds.length; i += 50) {
        const batch = missingIds.slice(i, i + 50);
        const durations = await fetchVideoDurations(batch);
        batch.forEach((id) => hydrateState.current.hydratedIds.add(id));
        const updated = await mutateChannels((channels) =>
          channels.map((channel) => {
            if (!channel.latestVideo) return channel;
            if (channel.latestVideo.duration) return channel;
            if (!durations.has(channel.latestVideo.id)) return channel;
            const duration = durations.get(channel.latestVideo.id);
            if (!duration) return channel;
            return {
              ...channel,
              latestVideo: {
                ...channel.latestVideo,
                duration,
              },
            };
          }),
        );
        setChannels(updated);
      }
    } finally {
      hydrateState.current.running = false;
    }
  }

  async function toggleWatched(channel: Channel): Promise<void> {
    if (isLocked) return;
    await browser.runtime.sendMessage({
      type: isChannelLatestSeen(channel)
        ? "MARK_CHANNEL_LATEST_UNSEEN"
        : "MARK_CHANNEL_LATEST_SEEN",
      channelId: channel.id,
    } satisfies ExtensionMessage);
    setChannels(await getChannels());
  }

  async function unfollow(id: string): Promise<void> {
    if (isLocked) return;
    const updated = channels.filter((channel) => channel.id !== id);
    await browser.storage.sync.set({ channels: updated });
    setChannels(updated);
    setUnfollowing(null);
  }

  function openVideo(videoId: string): void {
    void browser.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}` });
  }

  async function handleVideoOpen(channel: Channel): Promise<void> {
    if (isLocked) return;
    if (!channel.latestVideo) return;

    if (!isChannelLatestSeen(channel)) {
      await browser.runtime.sendMessage({
        type: "MARK_CHANNEL_LATEST_SEEN",
        channelId: channel.id,
      } satisfies ExtensionMessage);
      setChannels(await getChannels());
    }

    openVideo(channel.latestVideo.id);
  }

  async function toggleExcludeShorts(): Promise<void> {
    if (isLocked) return;
    if (
      excludeShortsCooldownUntil &&
      Date.now() < excludeShortsCooldownUntil
    ) {
      return;
    }

    const nextSettings = await setPopupSettings({
      excludeShorts: !popupSettings.excludeShorts,
      themePreference: popupSettings.themePreference,
      debugForceLocked: popupSettings.debugForceLocked,
    });
    setPopupSettingsState(nextSettings);

    const nextCount = excludeShortsRefreshCount + 1;
    if (nextCount >= 2) {
      setExcludeShortsCooldownUntil(Date.now() + 30_000);
      setExcludeShortsRefreshCount(0);
      setCooldownTick(Date.now());
    } else {
      setExcludeShortsRefreshCount(nextCount);
    }

    setIsRefreshing(true);
    try {
      await browser.runtime.sendMessage({
        type: "REFRESH_ALL_CHANNELS",
        reason: "manual",
      } satisfies ExtensionMessage);
    } finally {
      setIsRefreshing(false);
      setChannels(await getChannels());
    }
  }

  async function toggleThemePreference(): Promise<void> {
    const nextSettings = await setPopupSettings({
      excludeShorts: popupSettings.excludeShorts,
      themePreference: isDark ? "light" : "dark",
      debugForceLocked: popupSettings.debugForceLocked,
    });
    setPopupSettingsState(nextSettings);
  }

  async function toggleDebugLock(): Promise<void> {
    const nextSettings = await setPopupSettings({
      excludeShorts: popupSettings.excludeShorts,
      themePreference: popupSettings.themePreference,
      debugForceLocked: !popupSettings.debugForceLocked,
    });
    setPopupSettingsState(nextSettings);
  }

  async function handleSavePaddleId(): Promise<void> {
    const trimmed = paddleCustomerId.trim();
    await setPaddleCustomerId(trimmed.length > 0 ? trimmed : null);
    setPaddleCustomerIdState(trimmed);
  }

  async function handleSubscribe(): Promise<void> {
    const result = await startCheckout();
    setBillingNotice(result.message);
  }

  async function handleRestore(): Promise<void> {
    const result = await restorePurchase();
    setBillingNotice(result.message);
  }

  function formatDate(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
    return `${Math.floor(diffDays / 365)} years ago`;
  }

  function formatDuration(duration: string | null): string | null {
    if (!duration) return null;

    const match = duration.match(
      /^P(?:\d+Y)?(?:\d+M)?(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/,
    );

    if (!match) return null;

    const hours = Number(match[1] ?? 0);
    const minutes = Number(match[2] ?? 0);
    const seconds = Number(match[3] ?? 0);

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function getTrialBanner(): {
    label: string;
    tone: string;
    showSubscribe: boolean;
  } | null {
    if (!trialAccess) return null;

    if (trialAccess.status === "paid") {
      return {
        label: "Paid access active",
        tone: isDark
          ? "border-[#184f38] bg-[#10281f] text-[#9fdfbf]"
          : "border-[#b7d7c1] bg-[#e8f5ec] text-[#1f6a45]",
        showSubscribe: false,
      };
    }

    if (trialAccess.status === "expired") {
      return {
        label: "Free trial ended",
        tone: isDark
          ? "border-[#5f2626] bg-[#2a1515] text-[#ffb3b3]"
          : "border-[#efc1c1] bg-[#fff1f1] text-[#a33a3a]",
        showSubscribe: true,
      };
    }

    const dayLabel =
      trialAccess.daysRemaining === 1
        ? "1 day left"
        : `${trialAccess.daysRemaining} days left`;

    return {
      label: `Free trial: ${dayLabel}`,
      tone: isDark
        ? "border-[#3b3b3b] bg-[#181818] text-[#d7d7d7]"
        : "border-[#d8d0c4] bg-[#f2ece1] text-[#5f584b]",
      showSubscribe: true,
    };
  }

  const trialBanner = getTrialBanner();
  const isLocked =
    trialAccess?.status === "expired" || popupSettings.debugForceLocked;
  const channelLimit = 30;
  const slotsRemaining = Math.max(0, channelLimit - channels.length);
  const unwatchedChannels = channels.filter(
    (channel) => !isChannelLatestSeen(channel),
  );
  const watchedChannels = channels.filter((channel) =>
    isChannelLatestSeen(channel),
  );
  const excludeShortsCooldownSeconds = excludeShortsCooldownUntil
    ? Math.max(0, Math.ceil((excludeShortsCooldownUntil - cooldownTick) / 1000))
    : 0;
  const isExcludeShortsLocked =
    excludeShortsCooldownUntil !== null &&
    cooldownTick < excludeShortsCooldownUntil;
  const theme = {
    root: isDark ? "bg-[#0f0f0f]" : "bg-[#f6f3eb]",
    headerBorder: isDark ? "border-[#272727]" : "border-[#d7d0c3]",
    rowBorder: isDark ? "border-[#272727]" : "border-[#ddd4c6]",
    primaryText: isDark ? "text-white" : "text-[#1c1914]",
    secondaryText: isDark ? "text-[#aaa]" : "text-[#5f584b]",
    tertiaryText: isDark ? "text-[#717171]" : "text-[#8b806d]",
    sectionUnwatched:
      isDark
        ? "text-[#8a8a8a] border-[#272727] bg-[#151515]/95"
        : "text-[#746b5e] border-[#ddd4c6] bg-[#eee7da]/95",
    sectionWatched:
      isDark
        ? "text-[#6f6f6f] border-[#272727] bg-[#121212]/95"
        : "text-[#8e8576] border-[#ddd4c6] bg-[#f1ebdf]/95",
    hoverBg: isDark ? "hover:bg-[#3a3a3a]" : "hover:bg-[#ddd4c6]",
    watchedIcon: isDark ? "text-[#555]" : "text-[#aaa08e]",
    activeIcon: isDark ? "text-white" : "text-[#1c1914]",
    durationBg: isDark ? "bg-black/80" : "bg-[#201d18]/82",
    toggleOff: isDark ? "bg-[#3a3a3a]" : "bg-[#ccc2b3]",
    headerButton: isDark
      ? "text-[#aaa] hover:text-white"
      : "text-[#6c6457] hover:text-[#1c1914]",
    paywallBg: isDark ? "bg-[#141414]" : "bg-[#efe9de]",
    paywallBorder: isDark ? "border-[#2b2b2b]" : "border-[#ddd4c6]",
    paywallPrimary: isDark ? "text-white" : "text-[#1c1914]",
    paywallSecondary: isDark ? "text-[#b8b8b8]" : "text-[#6d6457]",
    paywallButton: isDark
      ? "bg-[#ff4e45] text-white hover:bg-[#ff5f57]"
      : "bg-[#ff4e45] text-white hover:bg-[#ff5f57]",
    paywallGhost: isDark
      ? "border-[#3a3a3a] text-[#d0d0d0] hover:bg-[#232323]"
      : "border-[#cfc6b8] text-[#5f584b] hover:bg-[#e4dccf]",
  };

  function renderChannelRow(channel: Channel) {
    const latestSeen = isChannelLatestSeen(channel);
    const durationLabel = formatDuration(channel.latestVideo?.duration ?? null);

    return (
      <li
        key={channel.id}
        className={`border-b transition-opacity duration-200 ${theme.rowBorder}`}
        style={{ opacity: latestSeen ? 0.45 : 1 }}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <div className="w-2 flex justify-center shrink-0">
            {!latestSeen && <div className="w-2 h-2 rounded-full bg-red-600" />}
          </div>

          <img
            src={channel.avatarUrl}
            alt={channel.name}
            className="w-9 h-9 rounded-full object-cover shrink-0"
          />

          <div
            onClick={() => {
              if (isLocked) return;
              void handleVideoOpen(channel);
            }}
            className={`flex-1 min-w-0 flex gap-2 items-center ${
              channel.latestVideo && !isLocked ? "cursor-pointer" : "cursor-default"
            } ${isLocked ? "pointer-events-none" : ""}`}
          >
            {channel.latestVideo ? (
              <>
                <div className="relative shrink-0">
                  <img
                    src={channel.latestVideo.thumbnail}
                    alt={channel.latestVideo.title}
                    className="w-24 h-[54px] rounded object-cover"
                  />
                  {durationLabel && (
                    <div className={`absolute bottom-1 right-1 rounded px-1 py-[1px] text-[10px] font-semibold leading-none text-white ${theme.durationBg}`}>
                      {durationLabel}
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className={`text-[12px] font-medium leading-snug mb-1 line-clamp-2 ${theme.primaryText}`}>
                    {channel.latestVideo.title}
                  </div>
                  <div className={`text-[11px] ${theme.secondaryText}`}>{channel.name}</div>
                  <div className={`text-[11px] mt-0.5 ${theme.tertiaryText}`}>
                    {formatDate(channel.latestVideo.uploadDate)}
                  </div>
                </div>
              </>
            ) : (
              <div className={`text-[12px] ${theme.secondaryText}`}>
                {channel.name} - no videos found
              </div>
            )}
          </div>

          <div className={`flex flex-col items-center gap-1.5 shrink-0 w-16 ${isLocked ? "pointer-events-none opacity-50" : ""}`}>
            <button
              onClick={() => void toggleWatched(channel)}
              title={latestSeen ? "Mark as unwatched" : "Mark as watched"}
              className={`flex h-7 w-7 items-center justify-center rounded-full border-none bg-transparent transition-colors duration-150 ${theme.hoverBg} ${latestSeen ? theme.watchedIcon : theme.activeIcon}`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {latestSeen ? (
                  <>
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </>
                ) : (
                  <>
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </>
                )}
              </svg>
            </button>

            <div className="flex items-center gap-1">
              {unfollowing === channel.id && (
                <button
                  onClick={() => setUnfollowing(null)}
                  title="Cancel"
                  className={`flex h-7 w-7 items-center justify-center rounded-full border-none bg-transparent transition-colors duration-150 ${theme.hoverBg} ${theme.secondaryText}`}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}

              <button
                onClick={() =>
                  unfollowing === channel.id
                    ? void unfollow(channel.id)
                    : setUnfollowing(channel.id)
                }
                title={
                  unfollowing === channel.id ? "Confirm unfollow" : "Unfollow"
                }
                className={`flex h-7 w-7 items-center justify-center rounded-full border-none bg-transparent transition-all duration-150 ${theme.hoverBg} ${unfollowing === channel.id ? "text-[#f44336]" : `${theme.secondaryText} hover:text-[#f44336]`}`}
                style={{
                  transform:
                    unfollowing === channel.id
                      ? "translateX(4px)"
                      : "translateX(0)",
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 20.5 4.9 13.58A4.95 4.95 0 0 1 12 6.69a4.95 4.95 0 0 1 7.1 6.89L12 20.5Z" />
                  <path d="M12 7.7 9.85 11l2.3 1.95-2.1 3.35" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </li>
    );
  }

  function renderSettingToggle(isOn: boolean) {
    return (
      <div
        className={`relative h-[22px] w-[42px] rounded-full transition-colors duration-200 ${
          isOn ? "bg-[#ff4e45]" : theme.toggleOff
        }`}
      >
        <div
          className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.22)] transition-[left,right] duration-200 ${
            isOn ? "right-[2px] left-auto" : "left-[2px] right-auto"
          }`}
        />
      </div>
    );
  }

  return (
    <div className={`w-[400px] h-[520px] flex flex-col font-sans overflow-hidden ${theme.root}`}>
      <div className={`flex items-center gap-2 px-4 py-3 border-b ${theme.headerBorder}`}>
        <img src={iconUrl} alt="HitTheBell" className="w-5 h-5" />
        <div className={`flex-1 min-w-0 font-semibold text-[15px] ${theme.primaryText}`}>
          HitTheBell
        </div>
        {isRefreshing && (
          <div className={`text-[11px] ${theme.tertiaryText}`}>Refreshing...</div>
        )}
        <button
          onClick={() => void toggleDebugLock()}
          title="Debug: force locked view"
          className={`ml-1 flex items-center gap-2 rounded-full border-none bg-transparent px-1 py-0.5 transition-opacity duration-150 ${
            popupSettings.debugForceLocked ? "opacity-90" : "opacity-70"
          }`}
        >
          <span className={`text-[11px] font-medium ${theme.secondaryText}`}>
            Debug Lock
          </span>
          {renderSettingToggle(popupSettings.debugForceLocked)}
        </button>
        {!isLocked && (
          <>
            <button
              onClick={() => void toggleThemePreference()}
              title={isDark ? "Switch to light mode" : "Switch to dark mode"}
              className={`flex h-7 w-7 items-center justify-center rounded-full border-none bg-transparent transition-colors duration-150 ${theme.hoverBg} ${theme.headerButton}`}
            >
              {isDark ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2" />
                  <path d="M12 20v2" />
                  <path d="m4.93 4.93 1.41 1.41" />
                  <path d="m17.66 17.66 1.41 1.41" />
                  <path d="M2 12h2" />
                  <path d="M20 12h2" />
                  <path d="m6.34 17.66-1.41 1.41" />
                  <path d="m19.07 4.93-1.41 1.41" />
                </svg>
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 3a6 6 0 1 0 9 9 9 9 0 1 1-9-9Z" />
                </svg>
              )}
            </button>
            <button
              onClick={() => void toggleExcludeShorts()}
              disabled={isExcludeShortsLocked}
              title={
                isExcludeShortsLocked
                  ? `Exclude Shorts locked for ${excludeShortsCooldownSeconds}s`
                  : "Exclude Shorts"
              }
              className={`ml-2 flex items-center gap-2 rounded-full border-none bg-transparent px-1 py-0.5 transition-opacity duration-150 ${
                isExcludeShortsLocked ? "opacity-60 cursor-not-allowed" : ""
              }`}
            >
              <span className={`text-[11px] font-medium ${theme.secondaryText}`}>
                Exclude Shorts
                {isExcludeShortsLocked ? ` (${excludeShortsCooldownSeconds}s)` : ""}
              </span>
              {renderSettingToggle(popupSettings.excludeShorts)}
            </button>
          </>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {trialBanner && (
          <div className={`mx-4 mt-3 rounded-xl border px-3 py-2 text-[12px] font-medium ${trialBanner.tone}`}>
            <div className="flex items-center gap-2">
              <span className="flex-1">{trialBanner.label}</span>
              {trialBanner.showSubscribe && (
                <button
                  onClick={() => void handleSubscribe()}
                  className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-current transition-colors duration-150 hover:bg-white/20"
                >
                  Subscribe
                </button>
              )}
            </div>
            {billingNotice && (
              <div className={`mt-1 text-[11px] ${theme.tertiaryText}`}>
                {billingNotice}
              </div>
            )}
          </div>
        )}

        {!isLocked && (
          <div className={`mx-4 mt-2 text-[11px] ${theme.secondaryText}`}>
            Slots remaining: {slotsRemaining} / {channelLimit}
          </div>
        )}

        <div className="mx-4 mt-3 rounded-xl border border-dashed border-[#d8d0c4] px-3 py-2 text-[12px]">
          <div className={`mb-2 text-[11px] font-semibold ${theme.secondaryText}`}>
            Paddle Customer ID (for sync)
          </div>
          <div className="flex items-center gap-2">
            <input
              value={paddleCustomerId}
              onChange={(event) => setPaddleCustomerIdState(event.target.value)}
              placeholder="cus_..."
              className={`h-8 flex-1 rounded-lg border px-2 text-[12px] outline-none ${
                isDark ? "border-[#2b2b2b] bg-[#151515] text-white" : "border-[#ddd4c6] bg-white text-[#1c1914]"
              }`}
            />
            <button
              onClick={() => void handleSavePaddleId()}
              className="h-8 rounded-lg bg-[#ff4e45] px-3 text-[11px] font-semibold text-white transition-colors duration-150 hover:bg-[#ff5f57]"
            >
              Save
            </button>
          </div>
        </div>

        {isLocked ? (
          <div className="px-4 py-6">
            <div className={`rounded-2xl border px-4 py-5 text-center ${theme.paywallBg} ${theme.paywallBorder}`}>
              <div className={`text-[14px] font-semibold ${theme.paywallPrimary}`}>
                Trial ended
              </div>
              <div className={`mt-1 text-[12px] ${theme.paywallSecondary}`}>
                Subscribe to keep tracking new uploads across your channels.
              </div>
              <div className="mt-4 flex items-center justify-center gap-2">
                <button
                  onClick={() => void handleSubscribe()}
                  className={`rounded-full px-4 py-2 text-[12px] font-semibold transition-colors duration-150 ${theme.paywallButton}`}
                >
                  Subscribe
                </button>
                <button
                  onClick={() => void handleRestore()}
                  className={`rounded-full border px-4 py-2 text-[12px] font-semibold transition-colors duration-150 ${theme.paywallGhost}`}
                >
                  Already paid?
                </button>
              </div>
              <div className={`mt-3 text-[11px] ${theme.paywallSecondary}`}>
                Tracked channels: {channels.length}
              </div>
              {billingNotice && (
                <div className={`mt-2 text-[11px] ${theme.paywallSecondary}`}>
                  {billingNotice}
                </div>
              )}
            </div>
          </div>
        ) : isLoading && channels.length === 0 ? (
          <div className={`px-4 py-6 text-[12px] ${theme.secondaryText}`}>
            Loading channels...
          </div>
        ) : channels.length === 0 ? (
          <div className={`p-5 text-[13px] text-center ${theme.secondaryText}`}>
            Not following any channels yet.
            <br />
            Right-click any channel or video on YouTube and click "Follow
            Channel".
          </div>
        ) : (
          <div className="mt-3">
            {unwatchedChannels.length > 0 && (
              <>
                <div className={`sticky top-0 z-10 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] border-b backdrop-blur-sm ${theme.sectionUnwatched}`}>
                  Unwatched Videos
                </div>
                <ul className="list-none p-0 m-0">
                  {unwatchedChannels.map(renderChannelRow)}
                </ul>
              </>
            )}

            {watchedChannels.length > 0 && (
              <>
                {unwatchedChannels.length > 0 && (
                  <div className={`sticky top-0 z-10 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] border-b backdrop-blur-sm ${theme.sectionWatched}`}>
                    Watched
                  </div>
                )}
                <ul className="list-none p-0 m-0">
                  {watchedChannels.map(renderChannelRow)}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(-8px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}



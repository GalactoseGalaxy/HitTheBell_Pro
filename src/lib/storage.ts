import browser from "webextension-polyfill";
import type {
  Channel,
  LegacyChannel,
  PopupSettings,
  TrialAccessState,
} from "../types";
import { fetchCustomerFromBackend, syncChannelsToBackend } from "./backend";

const CHANNELS_KEY = "channels";
const TRIAL_START_DATE_KEY = "trialStartDate";
const HAS_PAID_ACCESS_KEY = "hasPaidAccess";
const POPUP_SETTINGS_KEY = "popupSettings";
const PADDLE_CUSTOMER_ID_KEY = "paddleCustomerId";
const LAST_SYNC_EMAIL_KEY = "lastSyncEmail";
const SYNC_ENABLED_KEY = "syncEnabled";
const TRIAL_LENGTH_DAYS = 7;
const TRIAL_LENGTH_MS = TRIAL_LENGTH_DAYS * 24 * 60 * 60 * 1000;
const DEFAULT_POPUP_SETTINGS: PopupSettings = {
  excludeShorts: false,
  themePreference: "system",
  debugForceLocked: false,
};

let mutationQueue: Promise<unknown> = Promise.resolve();

function toIsoString(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeChannel(
  input: Channel | LegacyChannel,
  fallbackTime: string,
): Channel {
  const latestVideo = input.latestVideo ?? null;
  const legacyWatched =
    "watched" in input && typeof input.watched === "boolean"
      ? input.watched
      : false;
  const lastSeenVideoId =
    "lastSeenVideoId" in input && typeof input.lastSeenVideoId === "string"
      ? input.lastSeenVideoId
      : legacyWatched && latestVideo
        ? latestVideo.id
        : null;
  const updatedAt =
    "updatedAt" in input && typeof input.updatedAt === "string"
      ? toIsoString(input.updatedAt, fallbackTime)
      : fallbackTime;

  return {
    id: input.id,
    name: input.name,
    avatarUrl: input.avatarUrl,
    uploadsPlaylistId:
      "uploadsPlaylistId" in input && typeof input.uploadsPlaylistId === "string"
        ? input.uploadsPlaylistId
        : null,
    latestVideo,
    lastSeenVideoId,
    lastCheckedAt:
      "lastCheckedAt" in input && typeof input.lastCheckedAt === "string"
        ? toIsoString(input.lastCheckedAt, fallbackTime)
        : fallbackTime,
    lastChangedAt:
      "lastChangedAt" in input && typeof input.lastChangedAt === "string"
        ? toIsoString(input.lastChangedAt, fallbackTime)
        : fallbackTime,
    metadataLastCheckedAt:
      "metadataLastCheckedAt" in input &&
      typeof input.metadataLastCheckedAt === "string"
        ? toIsoString(input.metadataLastCheckedAt, fallbackTime)
        : null,
    lastError:
      "lastError" in input && typeof input.lastError === "string"
        ? input.lastError
        : null,
    updatedAt,
  };
}

function normalizeChannels(inputs: unknown, fallbackTime: string): Channel[] {
  if (!Array.isArray(inputs)) return [];

  const deduped = new Map<string, Channel>();
  for (const rawChannel of inputs) {
    if (
      !rawChannel ||
      typeof rawChannel !== "object" ||
      typeof (rawChannel as { id?: unknown }).id !== "string" ||
      typeof (rawChannel as { name?: unknown }).name !== "string" ||
      typeof (rawChannel as { avatarUrl?: unknown }).avatarUrl !== "string"
    ) {
      continue;
    }

    const normalized = normalizeChannel(
      rawChannel as Channel | LegacyChannel,
      fallbackTime,
    );
    const existing = deduped.get(normalized.id);
    if (!existing || existing.updatedAt < normalized.updatedAt) {
      deduped.set(normalized.id, normalized);
    }
  }

  return [...deduped.values()];
}

function normalizePopupSettings(input: unknown): PopupSettings {
  if (!input || typeof input !== "object") {
    return DEFAULT_POPUP_SETTINGS;
  }

  return {
    excludeShorts:
      typeof (input as { excludeShorts?: unknown }).excludeShorts === "boolean"
        ? Boolean((input as { excludeShorts?: unknown }).excludeShorts)
        : typeof (input as { includeShorts?: unknown }).includeShorts === "boolean"
          ? !Boolean((input as { includeShorts?: unknown }).includeShorts)
          : DEFAULT_POPUP_SETTINGS.excludeShorts,
    themePreference:
      (input as { themePreference?: unknown }).themePreference === "light" ||
      (input as { themePreference?: unknown }).themePreference === "dark" ||
      (input as { themePreference?: unknown }).themePreference === "system"
        ? ((input as { themePreference: "light" | "dark" | "system" }).themePreference)
        : DEFAULT_POPUP_SETTINGS.themePreference,
    debugForceLocked:
      typeof (input as { debugForceLocked?: unknown }).debugForceLocked === "boolean"
        ? Boolean((input as { debugForceLocked?: unknown }).debugForceLocked)
        : DEFAULT_POPUP_SETTINGS.debugForceLocked,
  };
}

function buildTrialAccessState(
  trialStartDate: string,
  hasPaidAccess: boolean,
): TrialAccessState {
  const trialStartAtMs = new Date(trialStartDate).getTime();
  const trialEndsAt = new Date(trialStartAtMs + TRIAL_LENGTH_MS).toISOString();
  const remainingMs = trialStartAtMs + TRIAL_LENGTH_MS - Date.now();
  const daysRemaining = hasPaidAccess
    ? 0
    : Math.max(0, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
  const isTrialActive = !hasPaidAccess && remainingMs > 0;

  return {
    trialStartDate,
    trialEndsAt,
    hasPaidAccess,
    isTrialActive,
    daysRemaining,
    status: hasPaidAccess ? "paid" : isTrialActive ? "trial" : "expired",
  };
}

async function migrateLegacyLocalStorage(): Promise<Channel[]> {
  const now = new Date().toISOString();
  const localData = await browser.storage.local.get([
    CHANNELS_KEY,
    TRIAL_START_DATE_KEY,
    HAS_PAID_ACCESS_KEY,
    POPUP_SETTINGS_KEY,
    PADDLE_CUSTOMER_ID_KEY,
  ]);
  const legacyChannels = normalizeChannels(localData[CHANNELS_KEY], now);
  const trialStartDate =
    typeof localData[TRIAL_START_DATE_KEY] === "string"
      ? toIsoString(localData[TRIAL_START_DATE_KEY], now)
      : null;
  const hasPaidAccess = normalizeBoolean(localData[HAS_PAID_ACCESS_KEY]);
  const popupSettings = normalizePopupSettings(localData[POPUP_SETTINGS_KEY]);
  const paddleCustomerId =
    typeof localData[PADDLE_CUSTOMER_ID_KEY] === "string"
      ? localData[PADDLE_CUSTOMER_ID_KEY]
      : null;

  if (
    legacyChannels.length > 0 ||
    trialStartDate ||
    hasPaidAccess ||
    paddleCustomerId ||
    localData[POPUP_SETTINGS_KEY] !== undefined
  ) {
    await browser.storage.sync.set({
      [CHANNELS_KEY]: legacyChannels,
      [TRIAL_START_DATE_KEY]: trialStartDate,
      [HAS_PAID_ACCESS_KEY]: hasPaidAccess,
      [PADDLE_CUSTOMER_ID_KEY]: paddleCustomerId,
      [POPUP_SETTINGS_KEY]: popupSettings,
    });
    await browser.storage.local.remove([
      CHANNELS_KEY,
      TRIAL_START_DATE_KEY,
      HAS_PAID_ACCESS_KEY,
      POPUP_SETTINGS_KEY,
      PADDLE_CUSTOMER_ID_KEY,
    ]);
  }

  return legacyChannels;
}

export async function getChannels(): Promise<Channel[]> {
  const now = new Date().toISOString();
  const syncData = await browser.storage.sync.get(CHANNELS_KEY);
  const channels = normalizeChannels(syncData[CHANNELS_KEY], now);

  if (channels.length > 0 || Array.isArray(syncData[CHANNELS_KEY])) {
    return channels;
  }

  return migrateLegacyLocalStorage();
}

export async function setChannels(channels: Channel[]): Promise<Channel[]> {
  const now = new Date().toISOString();
  const normalized = normalizeChannels(channels, now);
  try {
    await browser.storage.sync.set({ [CHANNELS_KEY]: normalized });
  } catch (err) {
    if (err instanceof Error && err.message.includes("QUOTA_BYTES")) {
      throw new Error("Storage quota exceeded. Try removing some channels.");
    }
    throw err;
  }

  const paddleCustomerId = await getPaddleCustomerId();
  const syncEnabled = await getSyncEnabled();
  if (paddleCustomerId && syncEnabled) {
    void syncChannelsToBackend(paddleCustomerId, normalized);
  }

  return normalized;
}

export async function getSyncEnabled(): Promise<boolean> {
  const data = await browser.storage.sync.get(SYNC_ENABLED_KEY);
  return typeof data[SYNC_ENABLED_KEY] === "boolean" ? data[SYNC_ENABLED_KEY] : false;
}

export async function setSyncEnabled(enabled: boolean): Promise<void> {
  await browser.storage.sync.set({ [SYNC_ENABLED_KEY]: enabled });
}
export async function getLastSyncEmail(): Promise<string | null> {
  const data = await browser.storage.sync.get(LAST_SYNC_EMAIL_KEY);
  if (typeof data[LAST_SYNC_EMAIL_KEY] === "string") {
    return data[LAST_SYNC_EMAIL_KEY];
  }
  return null;
}

export async function setLastSyncEmail(email: string | null): Promise<void> {
  await browser.storage.sync.set({ [LAST_SYNC_EMAIL_KEY]: email });
}
export async function getPaddleCustomerId(): Promise<string | null> {
  const data = await browser.storage.sync.get(PADDLE_CUSTOMER_ID_KEY);
  if (typeof data[PADDLE_CUSTOMER_ID_KEY] === "string") {
    return data[PADDLE_CUSTOMER_ID_KEY];
  }

  const localData = await browser.storage.local.get(PADDLE_CUSTOMER_ID_KEY);
  if (typeof localData[PADDLE_CUSTOMER_ID_KEY] === "string") {
    await browser.storage.sync.set({
      [PADDLE_CUSTOMER_ID_KEY]: localData[PADDLE_CUSTOMER_ID_KEY],
    });
    await browser.storage.local.remove(PADDLE_CUSTOMER_ID_KEY);
    return localData[PADDLE_CUSTOMER_ID_KEY];
  }

  return null;
}

export async function setPaddleCustomerId(paddleCustomerId: string | null): Promise<void> {
  await browser.storage.sync.set({ [PADDLE_CUSTOMER_ID_KEY]: paddleCustomerId });
}

export async function fetchAndMergeRemoteChannels(): Promise<Channel[] | null> {
  const paddleCustomerId = await getPaddleCustomerId();
  const syncEnabled = await getSyncEnabled();
  if (!paddleCustomerId || !syncEnabled) return null;

  const localChannels = await getChannels();
  const remote = await fetchCustomerFromBackend(paddleCustomerId);
  if (!remote?.channels) return null;

  const now = new Date().toISOString();
  const normalized = normalizeChannels(
    [...localChannels, ...remote.channels],
    now,
  );
  await browser.storage.sync.set({ [CHANNELS_KEY]: normalized });
  if (normalized.length > 0) {
    void syncChannelsToBackend(paddleCustomerId, normalized);
  }
  return normalized;
}

export async function getPopupSettings(): Promise<PopupSettings> {
  const data = await browser.storage.sync.get(POPUP_SETTINGS_KEY);

  if (data[POPUP_SETTINGS_KEY] !== undefined) {
    return normalizePopupSettings(data[POPUP_SETTINGS_KEY]);
  }

  const localData = await browser.storage.local.get(POPUP_SETTINGS_KEY);
  if (localData[POPUP_SETTINGS_KEY] !== undefined) {
    const migrated = normalizePopupSettings(localData[POPUP_SETTINGS_KEY]);
    await browser.storage.sync.set({ [POPUP_SETTINGS_KEY]: migrated });
    await browser.storage.local.remove(POPUP_SETTINGS_KEY);
    return migrated;
  }

  return DEFAULT_POPUP_SETTINGS;
}

export async function setPopupSettings(
  settings: PopupSettings,
): Promise<PopupSettings> {
  const normalized = normalizePopupSettings(settings);
  await browser.storage.sync.set({ [POPUP_SETTINGS_KEY]: normalized });
  return normalized;
}

export async function getTrialAccessState(): Promise<TrialAccessState> {
  const now = new Date().toISOString();
  const syncData = await browser.storage.sync.get([
    TRIAL_START_DATE_KEY,
    HAS_PAID_ACCESS_KEY,
  ]);

  let trialStartDate =
    typeof syncData[TRIAL_START_DATE_KEY] === "string"
      ? toIsoString(syncData[TRIAL_START_DATE_KEY], now)
      : null;
  let hasPaidAccess = normalizeBoolean(syncData[HAS_PAID_ACCESS_KEY]);

  if (!trialStartDate && syncData[TRIAL_START_DATE_KEY] === undefined) {
    const localData = await browser.storage.local.get([
      TRIAL_START_DATE_KEY,
      HAS_PAID_ACCESS_KEY,
    ]);
    trialStartDate =
      typeof localData[TRIAL_START_DATE_KEY] === "string"
        ? toIsoString(localData[TRIAL_START_DATE_KEY], now)
        : null;
    hasPaidAccess = normalizeBoolean(
      localData[HAS_PAID_ACCESS_KEY],
      hasPaidAccess,
    );

    if (trialStartDate || localData[HAS_PAID_ACCESS_KEY] !== undefined) {
      await browser.storage.sync.set({
        [TRIAL_START_DATE_KEY]: trialStartDate,
        [HAS_PAID_ACCESS_KEY]: hasPaidAccess,
      });
      await browser.storage.local.remove([
        TRIAL_START_DATE_KEY,
        HAS_PAID_ACCESS_KEY,
      ]);
    }
  }

  if (!trialStartDate) {
    trialStartDate = now;
    await browser.storage.sync.set({
      [TRIAL_START_DATE_KEY]: trialStartDate,
      [HAS_PAID_ACCESS_KEY]: hasPaidAccess,
    });
  }

  return buildTrialAccessState(trialStartDate, hasPaidAccess);
}

export async function setHasPaidAccess(hasPaidAccess: boolean): Promise<TrialAccessState> {
  const trialAccessState = await getTrialAccessState();
  await browser.storage.sync.set({ [HAS_PAID_ACCESS_KEY]: hasPaidAccess });
  return buildTrialAccessState(trialAccessState.trialStartDate, hasPaidAccess);
}

export async function mutateChannels(
  mutator: (channels: Channel[]) => Promise<Channel[]> | Channel[],
): Promise<Channel[]> {
  const run = async () => {
    const channels = await getChannels();
    const nextChannels = await mutator(channels);
    return setChannels(nextChannels);
  };

  const next = mutationQueue.then(run, run) as Promise<Channel[]>;
  mutationQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function isChannelLatestSeen(channel: Channel): boolean {
  return !channel.latestVideo || channel.lastSeenVideoId === channel.latestVideo.id;
}



























import browser from "webextension-polyfill";

const CACHE_KEY = "videoDurationCache";
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type CacheEntry = {
  duration: string;
  updatedAt: string;
};

type CacheRecord = Record<string, CacheEntry>;

function isFresh(entry: CacheEntry): boolean {
  const timestamp = new Date(entry.updatedAt).getTime();
  if (Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp <= MAX_CACHE_AGE_MS;
}

export async function getCachedVideoDurations(
  videoIds: string[],
): Promise<Map<string, string>> {
  if (videoIds.length === 0) return new Map();

  const data = await browser.storage.local.get(CACHE_KEY);
  const cache = (data[CACHE_KEY] ?? {}) as CacheRecord;
  const result = new Map<string, string>();

  for (const id of videoIds) {
    const entry = cache[id];
    if (!entry || !entry.duration || !isFresh(entry)) continue;
    result.set(id, entry.duration);
  }

  return result;
}

export async function setCachedVideoDurations(
  durations: Map<string, string | null>,
): Promise<void> {
  if (durations.size === 0) return;

  const data = await browser.storage.local.get(CACHE_KEY);
  const cache = (data[CACHE_KEY] ?? {}) as CacheRecord;
  const now = new Date().toISOString();

  for (const [id, duration] of durations.entries()) {
    if (!duration) continue;
    cache[id] = { duration, updatedAt: now };
  }

  await browser.storage.local.set({ [CACHE_KEY]: cache });
}

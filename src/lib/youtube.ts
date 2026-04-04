import type { Channel, LatestVideo } from "../types";
import { getCachedVideoDurations, setCachedVideoDurations } from "./video-duration-cache";
const API_KEY = import.meta.env.VITE_YOUTUBE_API_KEY;
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);
const SHORTS_MAX_SECONDS = 180;
const EXCLUDE_SHORTS_FIRST_BATCH_SIZE = 1;
const EXCLUDE_SHORTS_BATCH_SIZE = 3;
const EXCLUDE_SHORTS_MAX_CANDIDATES = 9;

interface YouTubeListResponse<T> {
  items?: T[];
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{
      reason?: string;
      message?: string;
    }>;
  };
  nextPageToken?: string;
}

interface YouTubeChannelItem {
  id: string;
  contentDetails?: {
    relatedPlaylists?: {
      uploads?: string;
    };
  };
  snippet?: {
    title?: string;
    thumbnails?: {
      default?: { url?: string };
    };
  };
}

interface YouTubePlaylistItem {
  contentDetails?: {
    videoId?: string;
    videoPublishedAt?: string;
  };
  snippet?: {
    title?: string;
    thumbnails?: {
      medium?: { url?: string };
    };
  };
}

interface YouTubeVideoItem {
  id?: string | { videoId?: string };
  contentDetails?: {
    duration?: string;
  };
  snippet?: {
    title?: string;
    publishedAt?: string;
    channelId?: string;
    thumbnails?: {
      medium?: { url?: string };
    };
  };
}

export interface ChannelSnapshot {
  id: string;
  name: string;
  avatarUrl: string;
  uploadsPlaylistId: string;
  latestVideo: LatestVideo | null;
}

interface LatestVideoFetchOptions {
  knownLatestVideoId?: string | null;
  existingLatestVideo?: LatestVideo | null;
  deferVideoDetails?: boolean;
}

interface ChannelSnapshotFetchOptions extends LatestVideoFetchOptions {
  cachedMetadata?: {
    name: string;
    avatarUrl: string;
    uploadsPlaylistId: string;
  };
  skipMetadataRefresh?: boolean;
}

function assertApiKey(): string {
  if (!API_KEY) {
    throw new Error("Missing VITE_YOUTUBE_API_KEY");
  }
  return API_KEY;
}

function buildUrl(path: string, params: Record<string, string>): string {
  const url = new URL(`${YOUTUBE_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("key", assertApiKey());
  return url.toString();
}

function formatYouTubeApiError(
  status: number,
  reason: string | null,
  fallbackMessage?: string,
): string {
  if (status === 403) {
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      return "YouTube API quota reached. Please try again later.";
    }

    if (reason === "keyInvalid" || reason === "ipRefererBlocked") {
      return "YouTube API key is blocked or misconfigured for this extension.";
    }

    if (reason === "forbidden") {
      return "YouTube denied this request. Check the API key restrictions.";
    }

    return fallbackMessage
      ? `YouTube blocked the request: ${fallbackMessage}`
      : "YouTube blocked the request.";
  }

  if (status === 400) {
    return fallbackMessage
      ? `YouTube request was invalid: ${fallbackMessage}`
      : "YouTube request was invalid.";
  }

  if (status === 401) {
    return "YouTube API key is invalid or unauthorized.";
  }

  return fallbackMessage ?? `Request failed with status ${status}`;
}

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const data = (await response.json()) as YouTubeListResponse<unknown>;

  if (!response.ok) {
    const reason = data.error?.errors?.[0]?.reason ?? null;
    const message = formatYouTubeApiError(
      response.status,
      reason,
      data.error?.message,
    );
    throw new Error(message);
  }

  if (data.error?.message) {
    throw new Error(data.error.message);
  }

  return data as T;
}

function extractVideoIdFromUrl(url: URL): string | null {
  if (url.pathname === "/watch") {
    return url.searchParams.get("v");
  }

  const shortsMatch = url.pathname.match(/^\/shorts\/([\w-]+)/);
  if (shortsMatch) return shortsMatch[1];

  return null;
}

async function fetchPageHtml(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch YouTube page (${response.status})`);
  }

  return response.text();
}

function extractChannelIdFromHtml(html: string): string | null {
  const patterns = [
    /"externalId":"(UC[\w-]+)"/,
    /"channelId":"(UC[\w-]+)"/,
    /https:\/\/www\.youtube\.com\/channel\/(UC[\w-]+)/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function normalizeYouTubeUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    if (!YOUTUBE_HOSTS.has(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function parseDurationToSeconds(duration: string | null | undefined): number | null {
  if (!duration) return null;

  const match = duration.match(
    /^P(?:\d+Y)?(?:\d+M)?(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/,
  );

  if (!match) return null;

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);

  return hours * 3600 + minutes * 60 + seconds;
}

function toLatestVideo(
  videoId: string,
  video: YouTubeVideoItem | undefined,
  playlistItem?: YouTubePlaylistItem,
): LatestVideo | null {
  const title = video?.snippet?.title ?? playlistItem?.snippet?.title ?? null;
  const thumbnail =
    video?.snippet?.thumbnails?.medium?.url ??
    playlistItem?.snippet?.thumbnails?.medium?.url ??
    null;
  const uploadDate =
    video?.snippet?.publishedAt ??
    playlistItem?.contentDetails?.videoPublishedAt ??
    null;
  const duration = video?.contentDetails?.duration ?? null;

  if (!title || !thumbnail || !uploadDate) {
    return null;
  }

  return {
    id: videoId,
    title,
    thumbnail,
    uploadDate,
    duration,
  };
}

function toPlaylistLatestVideo(item: YouTubePlaylistItem): LatestVideo | null {
  const videoId = item.contentDetails?.videoId ?? null;
  const title = item.snippet?.title ?? null;
  const thumbnail = item.snippet?.thumbnails?.medium?.url ?? null;
  const uploadDate = item.contentDetails?.videoPublishedAt ?? null;

  if (!videoId || !title || !thumbnail || !uploadDate) {
    return null;
  }

  return {
    id: videoId,
    title,
    thumbnail,
    uploadDate,
    duration: null,
  };
}

async function fetchVideosByIds(
  videoIds: string[],
): Promise<Map<string, YouTubeVideoItem>> {
  if (videoIds.length === 0) {
    return new Map();
  }

  const uniqueIds = Array.from(new Set(videoIds));
  const detailsById = new Map<string, YouTubeVideoItem>();

  for (let i = 0; i < uniqueIds.length; i += 50) {
    const batch = uniqueIds.slice(i, i + 50);
    const videoData = await requestJson<YouTubeListResponse<YouTubeVideoItem>>(
      buildUrl("videos", {
        part: "snippet,contentDetails",
        id: batch.join(","),
      }),
    );

    for (const item of videoData.items ?? []) {
      if (typeof item.id === "string") {
        detailsById.set(item.id, item);
      }
    }
  }

  return detailsById;
}

export async function fetchVideoDurations(
  videoIds: string[],
): Promise<Map<string, string | null>> {
  const uniqueIds = Array.from(new Set(videoIds));
  const cached = await getCachedVideoDurations(uniqueIds);
  const missing = uniqueIds.filter((id) => !cached.has(id));
  const durations = new Map<string, string | null>();

  cached.forEach((value, key) => durations.set(key, value));

  if (missing.length > 0) {
    const newlyCached = new Map<string, string | null>();
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      const detailsById = await fetchVideosByIds(batch);
      for (const id of batch) {
        const duration = detailsById.get(id)?.contentDetails?.duration ?? null;
        durations.set(id, duration);
        newlyCached.set(id, duration);
      }
    }
    await setCachedVideoDurations(newlyCached);
  }

  return durations;
}

async function fetchChannelIdByVideoId(videoId: string): Promise<string | null> {
  const data = await requestJson<YouTubeListResponse<YouTubeVideoItem>>(
    buildUrl("videos", {
      part: "snippet",
      id: videoId,
    }),
  );

  return data.items?.[0]?.snippet?.channelId ?? null;
}

async function fetchChannelByHandle(handle: string): Promise<string | null> {
  const data = await requestJson<YouTubeListResponse<YouTubeChannelItem>>(
    buildUrl("channels", {
      part: "id",
      forHandle: handle,
    }),
  );

  return data.items?.[0]?.id ?? null;
}

async function fetchChannelByUsername(username: string): Promise<string | null> {
  const data = await requestJson<YouTubeListResponse<YouTubeChannelItem>>(
    buildUrl("channels", {
      part: "id",
      forUsername: username,
    }),
  );

  return data.items?.[0]?.id ?? null;
}

export async function resolveChannelIdFromUrl(rawUrl: string): Promise<string | null> {
  const url = normalizeYouTubeUrl(rawUrl);
  if (!url) return null;

  const directChannelMatch = url.pathname.match(/^\/channel\/(UC[\w-]+)/);
  if (directChannelMatch) {
    return directChannelMatch[1];
  }

  const handleMatch = url.pathname.match(/^\/@([\w.-]+)/);
  if (handleMatch) {
    const fromHandle = await fetchChannelByHandle(handleMatch[1]);
    if (fromHandle) return fromHandle;
  }

  const userMatch = url.pathname.match(/^\/user\/([\w-]+)/);
  if (userMatch) {
    const fromUsername = await fetchChannelByUsername(userMatch[1]);
    if (fromUsername) return fromUsername;
  }

  const videoId = extractVideoIdFromUrl(url);
  if (videoId) {
    const fromVideo = await fetchChannelIdByVideoId(videoId);
    if (fromVideo) return fromVideo;
  }

  if (
    url.pathname.startsWith("/c/") ||
    url.pathname.startsWith("/user/") ||
    url.pathname.startsWith("/@") ||
    videoId
  ) {
    const html = await fetchPageHtml(url.toString());
    return extractChannelIdFromHtml(html);
  }

  return null;
}

async function fetchChannelMetadata(channelId: string): Promise<{
  id: string;
  name: string;
  avatarUrl: string;
  uploadsPlaylistId: string;
}> {
  const data = await requestJson<YouTubeListResponse<YouTubeChannelItem>>(
    buildUrl("channels", {
      part: "id,snippet,contentDetails",
      id: channelId,
    }),
  );

  const item = data.items?.[0];
  const name = item?.snippet?.title ?? null;
  const avatarUrl = item?.snippet?.thumbnails?.default?.url ?? null;
  const uploadsPlaylistId = item?.contentDetails?.relatedPlaylists?.uploads ?? null;

  if (!item?.id || !name || !avatarUrl || !uploadsPlaylistId) {
    throw new Error("Could not load channel metadata");
  }

  return {
    id: item.id,
    name,
    avatarUrl,
    uploadsPlaylistId,
  };
}

async function fetchLatestVideo(
  uploadsPlaylistId: string,
  includeShorts: boolean,
  options: LatestVideoFetchOptions = {},
): Promise<LatestVideo | null> {
  if (includeShorts) {
    const playlistData = await requestJson<YouTubeListResponse<YouTubePlaylistItem>>(
      buildUrl("playlistItems", {
        part: "snippet,contentDetails",
        playlistId: uploadsPlaylistId,
        maxResults: "1",
      }),
    );

    const latestPlaylistItem = playlistData.items?.[0] ?? null;
    const latestVideo = latestPlaylistItem
      ? toPlaylistLatestVideo(latestPlaylistItem)
      : null;

    if (!latestVideo) {
      return null;
    }

    if (
      options.knownLatestVideoId &&
      latestVideo.id === options.knownLatestVideoId &&
      options.existingLatestVideo
    ) {
      return options.existingLatestVideo;
    }

    if (options.knownLatestVideoId && latestVideo.id === options.knownLatestVideoId) {
      return null;
    }

    if (options.deferVideoDetails) {
      return latestVideo;
    }

    const detailsById = await fetchVideosByIds([latestVideo.id]);
    return toLatestVideo(
      latestVideo.id,
      detailsById.get(latestVideo.id),
      latestPlaylistItem ?? undefined,
    );
  }

  let pageToken: string | undefined;
  let scannedCount = 0;
  let fallbackLatest: LatestVideo | null = null;
  let batchSize = EXCLUDE_SHORTS_FIRST_BATCH_SIZE;

  while (scannedCount < EXCLUDE_SHORTS_MAX_CANDIDATES) {
    const playlistData = await requestJson<YouTubeListResponse<YouTubePlaylistItem>>(
      buildUrl("playlistItems", {
        part: "snippet,contentDetails",
        playlistId: uploadsPlaylistId,
        maxResults: String(batchSize),
        ...(pageToken ? { pageToken } : {}),
      }),
    );

    const playlistItems = playlistData.items ?? [];
    if (playlistItems.length === 0) {
      break;
    }

    const videoIds = playlistItems
      .map((item) => item.contentDetails?.videoId ?? null)
      .filter((id): id is string => Boolean(id));

    const durationsById = await fetchVideoDurations(videoIds);

    for (const playlistItem of playlistItems) {
      const videoId = playlistItem.contentDetails?.videoId;
      if (!videoId) continue;

      const candidate = toLatestVideo(
        videoId,
        {
          contentDetails: { duration: durationsById.get(videoId) ?? null },
          snippet: playlistItem.snippet,
        },
        playlistItem,
      );
      if (!candidate) continue;

      if (!fallbackLatest) {
        fallbackLatest = candidate;
      }

      if (
        options.knownLatestVideoId &&
        candidate.id === options.knownLatestVideoId &&
        options.existingLatestVideo
      ) {
        const storedDurationSeconds = parseDurationToSeconds(
          options.existingLatestVideo.duration,
        );
        if (
          storedDurationSeconds === null ||
          storedDurationSeconds > SHORTS_MAX_SECONDS
        ) {
          return options.existingLatestVideo;
        }
      }

      const seconds = parseDurationToSeconds(candidate.duration);
      if (seconds === null || seconds > SHORTS_MAX_SECONDS) {
        return candidate;
      }
    }

    scannedCount += playlistItems.length;
    pageToken = playlistData.nextPageToken;
    if (!pageToken) {
      break;
    }

    batchSize = EXCLUDE_SHORTS_BATCH_SIZE;
  }

  return fallbackLatest;
}

export async function fetchChannelSnapshotById(
  channelId: string,
  includeShorts: boolean,
  options: ChannelSnapshotFetchOptions = {},
): Promise<ChannelSnapshot> {
  const metadata =
    options.skipMetadataRefresh && options.cachedMetadata
      ? {
          id: channelId,
          name: options.cachedMetadata.name,
          avatarUrl: options.cachedMetadata.avatarUrl,
          uploadsPlaylistId: options.cachedMetadata.uploadsPlaylistId,
        }
      : await fetchChannelMetadata(channelId);

  const latestVideo = await fetchLatestVideo(
    metadata.uploadsPlaylistId,
    includeShorts,
    options,
  );

  return {
    id: metadata.id,
    name: metadata.name,
    avatarUrl: metadata.avatarUrl,
    uploadsPlaylistId: metadata.uploadsPlaylistId,
    latestVideo,
  };
}

export function createChannelRecord(
  snapshot: ChannelSnapshot,
  now: string,
): Channel {
  return {
    id: snapshot.id,
    name: snapshot.name,
    avatarUrl: snapshot.avatarUrl,
    uploadsPlaylistId: snapshot.uploadsPlaylistId,
    latestVideo: snapshot.latestVideo,
    lastSeenVideoId: null,
    lastCheckedAt: now,
    lastChangedAt: now,
    metadataLastCheckedAt: now,
    lastError: null,
    updatedAt: now,
  };
}





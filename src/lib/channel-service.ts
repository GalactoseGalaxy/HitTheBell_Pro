import {
  getChannels,
  getPopupSettings,
  getTrialAccessState,
  isChannelLatestSeen,
  mutateChannels,
} from "./storage";
import {
  createChannelRecord,
  fetchChannelSnapshotById,
  resolveChannelIdFromUrl,
} from "./youtube";
import type { Channel } from "../types";

const POPUP_OPEN_REFRESH_WINDOW_MS = 10 * 60 * 1000;
const METADATA_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CHANNEL_REFRESH_WINDOW_MS = 10 * 60 * 1000;

export type RefreshOutcome =
  | {
      type: "no_change";
      channelId: string;
    }
  | {
      type: "skipped";
      channelId: string;
      reason: "recent";
    }
  | {
      type: "new_upload";
      channelId: string;
      previousVideoId: string | null;
      currentVideoId: string | null;
    }
  | {
      type: "error";
      channelId: string;
      message: string;
    };

export interface RefreshAllChannelsResult {
  outcomes: RefreshOutcome[];
  refreshedAt: string;
}

let refreshJob: Promise<RefreshAllChannelsResult> | null = null;

async function hasAccess(): Promise<boolean> {
  const trialAccess = await getTrialAccessState();
  return trialAccess.status !== "expired";
}

function isOlderThan(timestamp: string | null, maxAgeMs: number): boolean {
  if (!timestamp) return true;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return true;
  return Date.now() - parsed.getTime() > maxAgeMs;
}

function shouldRefreshMetadata(channel: Channel): boolean {
  return (
    !channel.uploadsPlaylistId ||
    !channel.metadataLastCheckedAt ||
    isOlderThan(channel.metadataLastCheckedAt, METADATA_REFRESH_WINDOW_MS)
  );
}

function shouldRefreshChannel(channel: Channel): boolean {
  return isOlderThan(channel.lastCheckedAt, CHANNEL_REFRESH_WINDOW_MS);
}

export function shouldRefreshOnPopupOpen(channels: Channel[]): boolean {
  if (channels.length === 0) return false;
  return channels.some((channel) =>
    isOlderThan(channel.lastCheckedAt, POPUP_OPEN_REFRESH_WINDOW_MS),
  );
}

function mergeChannelSnapshot(
  current: Channel,
  snapshot: Awaited<ReturnType<typeof fetchChannelSnapshotById>>,
  now: string,
  refreshedMetadata: boolean,
): { channel: Channel; outcome: RefreshOutcome } {
  const previousVideoId = current.latestVideo?.id ?? null;
  const currentVideoId = snapshot.latestVideo?.id ?? null;
  const hasNewUpload = previousVideoId !== currentVideoId;
  const metadataChanged =
    current.name !== snapshot.name ||
    current.avatarUrl !== snapshot.avatarUrl ||
    current.uploadsPlaylistId !== snapshot.uploadsPlaylistId;

  const nextChannel: Channel = {
    ...current,
    name: snapshot.name,
    avatarUrl: snapshot.avatarUrl,
    uploadsPlaylistId: snapshot.uploadsPlaylistId,
    latestVideo:
      currentVideoId === previousVideoId && current.latestVideo
        ? current.latestVideo
        : snapshot.latestVideo,
    lastCheckedAt: now,
    lastChangedAt:
      hasNewUpload || metadataChanged
        ? now
        : current.lastChangedAt ?? current.updatedAt,
    metadataLastCheckedAt: refreshedMetadata
      ? now
      : current.metadataLastCheckedAt,
    lastError: null,
    updatedAt:
      hasNewUpload || metadataChanged || current.lastError
        ? now
        : current.updatedAt,
  };

  return {
    channel: nextChannel,
    outcome: hasNewUpload
      ? {
          type: "new_upload",
          channelId: current.id,
          previousVideoId,
          currentVideoId,
        }
      : {
          type: "no_change",
          channelId: current.id,
        },
  };
}

async function getVideoSelectionOptions(): Promise<{ includeShorts: boolean }> {
  const popupSettings = await getPopupSettings();
  return {
    includeShorts: !popupSettings.excludeShorts,
  };
}

export async function followChannelFromContext(input: {
  srcUrl?: string;
  linkUrl?: string;
  pageUrl?: string;
}): Promise<{ status: "followed" | "already_following"; channel: Channel }> {
  if (!(await hasAccess())) {
    throw new Error("Trial ended. Subscribe to continue.");
  }

  const existingChannels = await getChannels();
  if (existingChannels.length >= 30) {
    throw new Error("Channel limit reached (30). Unfollow a channel to add more.");
  }

  const urls = [input.linkUrl, input.srcUrl, input.pageUrl].filter(
    (value): value is string => Boolean(value),
  );

  let channelId: string | null = null;
  for (const url of urls) {
    channelId = await resolveChannelIdFromUrl(url);
    if (channelId) break;
  }

  if (!channelId) {
    throw new Error("Could not find channel");
  }

  const { includeShorts } = await getVideoSelectionOptions();
  const snapshot = await fetchChannelSnapshotById(channelId, includeShorts);
  const now = new Date().toISOString();
  let result: { status: "followed" | "already_following"; channel: Channel } | null =
    null;

  await mutateChannels((channels) => {
    const existing = channels.find((channel) => channel.id === snapshot.id);
    if (existing) {
      const merged = mergeChannelSnapshot(existing, snapshot, now, true).channel;
      result = {
        status: "already_following",
        channel: merged,
      };
      return channels.map((channel) =>
        channel.id === merged.id ? merged : channel,
      );
    }

    const created = createChannelRecord(snapshot, now);
    result = {
      status: "followed",
      channel: created,
    };
    return [...channels, created];
  });

  if (!result) {
    throw new Error("Could not save channel");
  }

  return result;
}

async function refreshSingleChannel(
  channel: Channel,
  includeShorts: boolean,
): Promise<RefreshOutcome> {
  const now = new Date().toISOString();
  const refreshMetadata = shouldRefreshMetadata(channel);

  try {
    const snapshot = await fetchChannelSnapshotById(channel.id, includeShorts, {
      knownLatestVideoId: channel.latestVideo?.id ?? null,
      existingLatestVideo: channel.latestVideo,
      skipMetadataRefresh: !refreshMetadata,
      deferVideoDetails: includeShorts,
      cachedMetadata:
        channel.uploadsPlaylistId && channel.name && channel.avatarUrl
          ? {
              name: channel.name,
              avatarUrl: channel.avatarUrl,
              uploadsPlaylistId: channel.uploadsPlaylistId,
            }
          : undefined,
    });
    let outcome: RefreshOutcome = {
      type: "no_change",
      channelId: channel.id,
    };

    await mutateChannels((channels) =>
      channels.map((current) => {
        if (current.id !== channel.id) return current;
        const merged = mergeChannelSnapshot(
          current,
          snapshot,
          now,
          refreshMetadata,
        );
        outcome = merged.outcome;
        return merged.channel;
      }),
    );

    return outcome;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown refresh error";

    await mutateChannels((channels) =>
      channels.map((current) =>
        current.id === channel.id
          ? {
              ...current,
              lastCheckedAt: now,
              lastError: message,
            }
          : current,
      ),
    );

    return {
      type: "error",
      channelId: channel.id,
      message,
    };
  }
}

export async function refreshAllChannels(options?: { force?: boolean }): Promise<RefreshAllChannelsResult> {
  if (refreshJob) {
    return refreshJob;
  }

  refreshJob = (async () => {
    const forceRefresh = options?.force === true;
    if (!(await hasAccess())) {
      return {
        outcomes: [],
        refreshedAt: new Date().toISOString(),
      };
    }

    const [channels, { includeShorts }] = await Promise.all([
      getChannels(),
      getVideoSelectionOptions(),
    ]);
    const outcomes: RefreshOutcome[] = [];

    for (const channel of channels) {
      if (!forceRefresh && !shouldRefreshChannel(channel)) {
        outcomes.push({
          type: "skipped",
          channelId: channel.id,
          reason: "recent",
        });
        continue;
      }

      outcomes.push(await refreshSingleChannel(channel, includeShorts));
    }

    return {
      outcomes,
      refreshedAt: new Date().toISOString(),
    };
  })();

  try {
    return await refreshJob;
  } finally {
    refreshJob = null;
  }
}

export async function markChannelLatestSeen(channelId: string): Promise<Channel | null> {
  if (!(await hasAccess())) {
    throw new Error("Trial ended. Subscribe to continue.");
  }

  const now = new Date().toISOString();
  let updatedChannel: Channel | null = null;

  await mutateChannels((channels) =>
    channels.map((channel) => {
      if (channel.id !== channelId || !channel.latestVideo) {
        return channel;
      }

      updatedChannel = {
        ...channel,
        lastSeenVideoId: channel.latestVideo.id,
        updatedAt: now,
      };
      return updatedChannel;
    }),
  );

  return updatedChannel;
}

export async function markChannelLatestUnseen(
  channelId: string,
): Promise<Channel | null> {
  if (!(await hasAccess())) {
    throw new Error("Trial ended. Subscribe to continue.");
  }

  const now = new Date().toISOString();
  let updatedChannel: Channel | null = null;

  await mutateChannels((channels) =>
    channels.map((channel) => {
      if (channel.id !== channelId || !isChannelLatestSeen(channel)) {
        return channel;
      }

      updatedChannel = {
        ...channel,
        lastSeenVideoId: null,
        updatedAt: now,
      };
      return updatedChannel;
    }),
  );

  return updatedChannel;
}



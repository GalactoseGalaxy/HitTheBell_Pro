export interface FollowChannelFromContextMessage {
  type: "FOLLOW_CHANNEL_FROM_CONTEXT";
  srcUrl?: string;
  linkUrl?: string;
  pageUrl?: string;
}

export interface RefreshAllChannelsMessage {
  type: "REFRESH_ALL_CHANNELS";
  reason?: "startup" | "alarm" | "popup-open" | "manual";
}

export interface MarkChannelLatestSeenMessage {
  type: "MARK_CHANNEL_LATEST_SEEN";
  channelId: string;
}

export interface MarkChannelLatestUnseenMessage {
  type: "MARK_CHANNEL_LATEST_UNSEEN";
  channelId: string;
}

export interface ShowToastMessage {
  type: "SHOW_TOAST";
  message: string;
  level: "success" | "error" | "info";
}

export type ExtensionMessage =
  | FollowChannelFromContextMessage
  | RefreshAllChannelsMessage
  | MarkChannelLatestSeenMessage
  | MarkChannelLatestUnseenMessage
  | ShowToastMessage;

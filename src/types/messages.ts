export interface FollowChannelFromContextMessage {
  type: "FOLLOW_CHANNEL_FROM_CONTEXT";
  srcUrl?: string;
  linkUrl?: string;
  pageUrl?: string;
}

export interface UnfollowChannelMessage {
  type: "UNFOLLOW_CHANNEL";
  channelId: string;
}

export interface RefreshAllChannelsMessage {
  type: "REFRESH_ALL_CHANNELS";
  reason?: "startup" | "alarm" | "popup-open" | "manual";
  force?: boolean;
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

export interface ReinjectContentMessage {
  type: "REINJECT_CONTENT";
}

export type ExtensionMessage =
  | FollowChannelFromContextMessage
  | UnfollowChannelMessage
  | RefreshAllChannelsMessage
  | MarkChannelLatestSeenMessage
  | MarkChannelLatestUnseenMessage
  | ShowToastMessage
  | ReinjectContentMessage;



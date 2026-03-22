export interface GetChannelIdMessage {
  type: "GET_CHANNEL_ID";
  srcUrl?: string;
  linkUrl?: string;
  pageUrl?: string;
}

export type ExtensionMessage = GetChannelIdMessage;

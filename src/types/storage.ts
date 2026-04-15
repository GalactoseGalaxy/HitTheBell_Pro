export interface LatestVideo {
  id: string;
  title: string;
  thumbnail: string;
  uploadDate: string;
  duration: string | null;
}

export interface Channel {
  id: string;
  name: string;
  avatarUrl: string;
  uploadsPlaylistId: string | null;
  latestVideo: LatestVideo | null;
  lastSeenVideoId: string | null;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  metadataLastCheckedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface TrialAccessState {
  trialStartDate: string;
  trialEndsAt: string;
  hasPaidAccess: boolean;
  isTrialActive: boolean;
  daysRemaining: number;
  status: "trial" | "paid" | "expired";
}

export interface StorageData {
  channels: Channel[];
  trialStartDate: string | null;
  hasPaidAccess?: boolean;
  paddleCustomerId?: string | null;
  popupSettings?: PopupSettings;
}

export interface LegacyChannel {
  id: string;
  name: string;
  avatarUrl: string;
  latestVideo: LatestVideo | null;
  watched?: boolean;
}

export interface PopupSettings {
  excludeShorts: boolean;
  themePreference: "system" | "light" | "dark";
  debugForceLocked: boolean;
  notificationsEnabled: boolean;
}

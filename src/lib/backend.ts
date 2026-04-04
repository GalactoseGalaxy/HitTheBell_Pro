import type { Channel } from "../types/storage";
import { BACKEND_URL } from "./config";

export async function syncChannelsToBackend(
  paddleCustomerId: string,
  channels: Channel[],
): Promise<void> {
  if (!paddleCustomerId) return;

  try {
    const response = await fetch(`${BACKEND_URL}/customers/${paddleCustomerId}/channels`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels }),
    });
    if (!response.ok) {
      console.error(`[HitTheBell] Failed to sync channels: ${response.status}`);
    }
  } catch (err) {
    console.error("[HitTheBell] Error syncing channels to backend:", err);
  }
}

export async function fetchCustomerFromBackend(
  paddleCustomerId: string,
): Promise<{ channels?: Channel[] } | null> {
  if (!paddleCustomerId) return null;

  try {
    const response = await fetch(`${BACKEND_URL}/customers/${paddleCustomerId}`);
    if (!response.ok) {
      console.error(`[HitTheBell] Failed to fetch customer: ${response.status}`);
      return null;
    }
    return (await response.json()) as { channels?: Channel[] } | null;
  } catch (err) {
    console.error("[HitTheBell] Error fetching customer from backend:", err);
    return null;
  }
}

import type { Channel } from "../types/storage";

const BACKEND_URL =
  (import.meta as { env?: Record<string, string> }).env?.VITE_BACKEND_URL ||
  "http://localhost:8787";

export async function syncChannelsToBackend(
  paddleCustomerId: string,
  channels: Channel[],
): Promise<void> {
  if (!paddleCustomerId) return;

  await fetch(`${BACKEND_URL}/customers/${paddleCustomerId}/channels`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channels }),
  });
}

export async function fetchCustomerFromBackend(
  paddleCustomerId: string,
): Promise<{ channels?: Channel[] } | null> {
  if (!paddleCustomerId) return null;

  const response = await fetch(`${BACKEND_URL}/customers/${paddleCustomerId}`);
  if (!response.ok) return null;
  return (await response.json()) as { channels?: Channel[] } | null;
}

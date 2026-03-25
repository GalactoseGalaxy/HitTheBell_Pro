const BACKEND_URL =
  (import.meta as { env?: Record<string, string> }).env?.VITE_BACKEND_URL ||
  "http://localhost:8787";

export interface BillingActionResult {
  message: string;
  paddleCustomerId?: string;
  ok?: boolean;
}

export async function startCheckout(): Promise<BillingActionResult> {
  return {
    message: "Checkout will be wired up when Paddle is connected.",
  };
}

export async function requestRestoreCode(
  email: string,
): Promise<BillingActionResult> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) {
    return { message: "Please enter the email used for purchase." };
  }

  const response = await fetch(`${BACKEND_URL}/restore/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: trimmed }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const errorMessage = payload?.error ?? "Could not send a restore code.";
    return { message: errorMessage, ok: false };
  }

  return {
    message: "Code sent. Check your email.",
    ok: true,
  };
}

export async function verifyRestoreCode(
  email: string,
  code: string,
): Promise<BillingActionResult> {
  const trimmed = email.trim().toLowerCase();
  const trimmedCode = code.trim();
  if (!trimmed) {
    return { message: "Please enter the email used for purchase." };
  }
  if (!trimmedCode) {
    return { message: "Please enter the code we emailed you." };
  }

  const response = await fetch(`${BACKEND_URL}/restore/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: trimmed, code: trimmedCode }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const errorMessage = payload?.error ?? "Could not verify the restore code.";
    return { message: errorMessage, ok: false };
  }

  const payload = await response.json().catch(() => ({}));
  return {
    message: "Purchase restored. Syncing your channels...",
    paddleCustomerId: payload?.paddleCustomerId ?? null,
    ok: true,
  };
}

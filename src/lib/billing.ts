import { BACKEND_URL } from "./config";
import browser from "webextension-polyfill";

export interface BillingActionResult {
  message: string;
  paddleCustomerId?: string;
  checkoutUrl?: string;
  ok?: boolean;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function startCheckout(
  email?: string,
): Promise<BillingActionResult> {
  const base = browser.runtime.getURL("src/popup/index.html");
  const url = new URL(base);
  url.searchParams.set("checkout", "1");
  if (email) {
    url.searchParams.set("email", email);
  }

  return {
    message: "Opening checkout…",
    checkoutUrl: url.toString(),
    ok: true,
  };
}

export async function requestRestoreCode(
  email: string,
): Promise<BillingActionResult> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) {
    return { message: "Please enter the email used for purchase." };
  }
  if (!EMAIL_REGEX.test(trimmed)) {
    return { message: "Please enter a valid email address." };
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

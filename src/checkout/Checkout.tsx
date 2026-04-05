import { useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";
import {
  setHasPaidAccess,
  setPaddleCustomerId,
  setSyncEnabled,
  setLastSyncEmail,
} from "../lib/storage";
import { BACKEND_URL } from "../lib/config";

const PADDLE_PRICE_ID_MONTHLY = import.meta.env.VITE_PADDLE_PRICE_ID_MONTHLY || "";
const PADDLE_PRICE_ID_YEARLY = import.meta.env.VITE_PADDLE_PRICE_ID_YEARLY || "";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000; // stop polling after 15 minutes

function getEmailParam(): string {
  try {
    return new URL(window.location.href).searchParams.get("email") ?? "";
  } catch {
    return "";
  }
}

type Plan = "monthly" | "yearly";
type CheckoutStatus = "pick" | "loading" | "awaiting" | "success" | "error";

export default function Checkout() {
  const [status, setStatus] = useState<CheckoutStatus>("pick");
  const [selectedPlan, setSelectedPlan] = useState<Plan>("yearly");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef<number>(0);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  const isDark = systemPrefersDark;
  const bg = isDark ? "bg-[#0f0f0f]" : "bg-[#f6f3eb]";
  const textPrimary = isDark ? "text-white" : "text-[#1c1914]";
  const textSecondary = isDark ? "text-[#aaa]" : "text-[#5f584b]";
  const cardBase = isDark
    ? "border-[#2b2b2b] bg-[#141414]"
    : "border-[#ddd4c6] bg-white";
  const cardSelected = isDark
    ? "border-[#ff4e45] bg-[#1a0f0e]"
    : "border-[#ff4e45] bg-[#fff5f4]";
  const iconUrl = browser.runtime.getURL("icon.png");

  function stopPolling() {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }

  function handleClose() {
    stopPolling();
    window.close();
  }

  async function checkTransactionStatus(
    transactionId: string,
    email: string,
  ): Promise<void> {
    try {
      const res = await fetch(`${BACKEND_URL}/checkout/status/${transactionId}`);
      if (!res.ok) return; // transient error — keep polling

      const data = (await res.json()) as {
        status?: string;
        customerId?: string | null;
      };

      // Paddle statuses that mean "payment done"
      if (data.status === "completed" || data.status === "paid") {
        stopPolling();

        const customerId = data.customerId ?? null;
        if (customerId) {
          await setPaddleCustomerId(customerId);
          await setSyncEnabled(true);
          if (email) await setLastSyncEmail(email);
        }
        await setHasPaidAccess(true);

        // Re-confirm with the backend customer record in case webhook already fired
        if (customerId) {
          try {
            const confirmRes = await fetch(`${BACKEND_URL}/customers/${customerId}`);
            if (confirmRes.ok) {
              const payload = (await confirmRes.json()) as {
                status?: string;
                paidThrough?: string;
              } | null;
              const isPaid =
                payload?.status === "active" ||
                payload?.status === "paid" ||
                (payload?.status === "canceled" &&
                  !!payload.paidThrough &&
                  new Date(payload.paidThrough).getTime() > Date.now());
              await setHasPaidAccess(isPaid);
            }
          } catch {
            // Backend refresh failed — optimistic value stands
          }
        }

        setStatus("success");
      } else if (data.status === "canceled") {
        stopPolling();
        setStatus("pick"); // Let them try again
      } else if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
        stopPolling();
        setErrorMessage(
          "We couldn't confirm your payment automatically. If you completed checkout, use Restore Purchase in the extension popup.",
        );
        setStatus("error");
      }
    } catch {
      // Network error — keep polling
    }
  }

  async function handleSubscribe() {
    const priceId =
      selectedPlan === "yearly" ? PADDLE_PRICE_ID_YEARLY : PADDLE_PRICE_ID_MONTHLY;

    if (!priceId) {
      setStatus("error");
      setErrorMessage(
        `Missing VITE_PADDLE_PRICE_ID_${selectedPlan.toUpperCase()}. Check your .env file.`,
      );
      return;
    }

    setStatus("loading");

    try {
      const email = getEmailParam();

      const res = await fetch(`${BACKEND_URL}/checkout/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId, email: email || undefined }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? `Server error (${res.status})`);
      }

      const { checkoutUrl, transactionId } = (await res.json()) as {
        checkoutUrl: string;
        transactionId: string;
      };

      // Open Paddle's hosted checkout page in a new tab — no Paddle.js needed
      await browser.tabs.create({ url: checkoutUrl });

      setStatus("awaiting");

      // Poll until payment is confirmed or times out
      pollStartRef.current = Date.now();
      pollIntervalRef.current = setInterval(() => {
        void checkTransactionStatus(transactionId, email);
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setStatus("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to start checkout.",
      );
    }
  }

  return (
    <div
      className={`min-h-screen flex flex-col items-center justify-center gap-5 font-sans px-6 ${bg}`}
    >
      <img src={iconUrl} alt="HitTheBell" className="w-10 h-10" />

      {/* Plan picker */}
      {status === "pick" && (
        <div className="w-full max-w-sm flex flex-col gap-4">
          <div className="text-center">
            <p className={`text-[16px] font-semibold ${textPrimary}`}>
              Choose your plan
            </p>
            <p className={`mt-1 text-[13px] ${textSecondary}`}>
              Cancel anytime from Paddle's customer portal.
            </p>
          </div>

          {/* Yearly card */}
          <button
            onClick={() => setSelectedPlan("yearly")}
            className={`w-full rounded-2xl border-2 px-4 py-3.5 text-left transition-colors duration-150 ${
              selectedPlan === "yearly" ? cardSelected : cardBase
            }`}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className={`text-[13px] font-semibold ${textPrimary}`}>
                    Yearly
                  </span>
                  <span className="rounded-full bg-[#ff4e45] px-2 py-0.5 text-[10px] font-bold text-white">
                    BEST VALUE
                  </span>
                </div>
                <div className={`mt-0.5 text-[12px] ${textSecondary}`}>
                  Billed once a year · save 33%
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className={`text-[15px] font-bold ${textPrimary}`}>$23.99</div>
                  <div className={`text-[11px] ${textSecondary}`}>$2.00&thinsp;/&thinsp;mo</div>
                </div>
                <div
                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    selectedPlan === "yearly"
                      ? "border-[#ff4e45] bg-[#ff4e45]"
                      : isDark
                        ? "border-[#555]"
                        : "border-[#ccc2b3]"
                  }`}
                >
                  {selectedPlan === "yearly" && (
                    <div className="w-1.5 h-1.5 rounded-full bg-white" />
                  )}
                </div>
              </div>
            </div>
          </button>

          {/* Monthly card */}
          <button
            onClick={() => setSelectedPlan("monthly")}
            className={`w-full rounded-2xl border-2 px-4 py-3.5 text-left transition-colors duration-150 ${
              selectedPlan === "monthly" ? cardSelected : cardBase
            }`}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className={`text-[13px] font-semibold ${textPrimary}`}>
                  Monthly
                </div>
                <div className={`mt-0.5 text-[12px] ${textSecondary}`}>
                  Billed every month
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className={`text-[15px] font-bold ${textPrimary}`}>$2.99</div>
                  <div className={`text-[11px] ${textSecondary}`}>per month</div>
                </div>
                <div
                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    selectedPlan === "monthly"
                      ? "border-[#ff4e45] bg-[#ff4e45]"
                      : isDark
                        ? "border-[#555]"
                        : "border-[#ccc2b3]"
                  }`}
                >
                  {selectedPlan === "monthly" && (
                    <div className="w-1.5 h-1.5 rounded-full bg-white" />
                  )}
                </div>
              </div>
            </div>
          </button>

          <button
            onClick={() => void handleSubscribe()}
            className="w-full rounded-full bg-[#ff4e45] py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-[#ff5f57]"
          >
            Continue to checkout
          </button>

          <button
            onClick={handleClose}
            className={`text-[12px] text-center transition-colors ${textSecondary} hover:opacity-70`}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Loading */}
      {status === "loading" && (
        <div className="flex flex-col items-center gap-3">
          <svg
            className="animate-spin"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          <p className={`text-[13px] ${textSecondary}`}>Preparing checkout…</p>
        </div>
      )}

      {/* Awaiting payment in new tab */}
      {status === "awaiting" && (
        <div className="w-full max-w-sm flex flex-col items-center gap-4 text-center">
          <svg
            className="animate-spin"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          <div>
            <p className={`text-[14px] font-semibold ${textPrimary}`}>
              Complete your purchase
            </p>
            <p className={`mt-1 text-[12px] ${textSecondary}`}>
              A checkout tab has opened. Finish payment there — this window will update automatically.
            </p>
          </div>
          <button
            onClick={handleClose}
            className={`text-[12px] transition-colors ${textSecondary} hover:opacity-70`}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Success */}
      {status === "success" && (
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="w-12 h-12 rounded-full bg-[#e8f5ec] flex items-center justify-center">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#1f6a45"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <p className={`text-[15px] font-semibold ${textPrimary}`}>
            You're subscribed!
          </p>
          <p className={`text-[13px] ${textSecondary}`}>
            HitTheBell Pro is now active. You can close this window.
          </p>
          <button
            onClick={handleClose}
            className="mt-2 rounded-full bg-[#ff4e45] px-5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#ff5f57]"
          >
            Close
          </button>
        </div>
      )}

      {/* Error */}
      {status === "error" && (
        <div className="flex flex-col items-center gap-3 text-center">
          <p className={`text-[14px] font-semibold ${textPrimary}`}>
            Something went wrong
          </p>
          <p className={`text-[13px] ${textSecondary}`}>
            {errorMessage ?? "Could not open checkout."}
          </p>
          <button
            onClick={handleClose}
            className={`mt-2 rounded-full border px-5 py-2 text-[13px] font-semibold transition-colors ${
              isDark
                ? "border-[#3a3a3a] text-[#d0d0d0] hover:bg-[#1c1c1c]"
                : "border-[#cfc6b8] text-[#5f584b] hover:bg-[#e4dccf]"
            }`}
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}

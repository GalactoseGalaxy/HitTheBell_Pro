import { useEffect, useRef, useState } from "react";
import { initializePaddle, type Paddle } from "@paddle/paddle-js";
import browser from "webextension-polyfill";
import { setHasPaidAccess, setPaddleCustomerId, setSyncEnabled, setLastSyncEmail } from "../lib/storage";
import { BACKEND_URL } from "../lib/config";

const PADDLE_CLIENT_TOKEN = import.meta.env.VITE_PADDLE_CLIENT_TOKEN || "";
const PADDLE_PRICE_ID = import.meta.env.VITE_PADDLE_PRICE_ID || "";
const PADDLE_ENV = (import.meta.env.VITE_PADDLE_ENV as "production" | "sandbox") || "production";

// Read prefill email from URL query param (?email=...)
function getEmailParam(): string {
  try {
    return new URL(window.location.href).searchParams.get("email") ?? "";
  } catch {
    return "";
  }
}

type CheckoutStatus = "loading" | "open" | "success" | "error";

export default function Checkout() {
  const paddleRef = useRef<Paddle | null>(null);
  const [status, setStatus] = useState<CheckoutStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (!PADDLE_CLIENT_TOKEN || !PADDLE_PRICE_ID) {
      setStatus("error");
      setErrorMessage(
        "Checkout is not configured yet. Missing VITE_PADDLE_CLIENT_TOKEN or VITE_PADDLE_PRICE_ID.",
      );
      return;
    }

    let cancelled = false;

    async function openCheckout() {
      try {
        const paddle = await initializePaddle({
          token: PADDLE_CLIENT_TOKEN,
          environment: PADDLE_ENV,
          checkout: {
            settings: {
              displayMode: "overlay",
              theme: systemPrefersDark ? "dark" : "light",
              locale: "en",
            },
          },
          eventCallback(event) {
            if (cancelled) return;

            if (event.name === "checkout.completed") {
              const customerId =
                event.data?.customer?.id ??
                event.data?.transaction?.customer_id ??
                null;
              const email =
                event.data?.customer?.email ?? getEmailParam() ?? null;

              void (async () => {
                try {
                  if (customerId) {
                    await setPaddleCustomerId(customerId);
                    await setSyncEnabled(true);
                    if (email) await setLastSyncEmail(email);

                    // Optimistically mark paid — webhook will confirm shortly
                    await setHasPaidAccess(true);

                    // Refresh status from backend in case webhook already fired
                    try {
                      const res = await fetch(`${BACKEND_URL}/customers/${customerId}`);
                      if (res.ok) {
                        const payload = await res.json() as { status?: string; paidThrough?: string } | null;
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
                } finally {
                  setStatus("success");
                }
              })();
            }

            if (event.name === "checkout.closed" && status !== "success") {
              window.close();
            }

            if (event.name === "checkout.error") {
              setStatus("error");
              setErrorMessage("Something went wrong with checkout. Please try again.");
            }
          },
        });

        if (cancelled) return;
        paddleRef.current = paddle ?? null;

        const prefillEmail = getEmailParam();
        paddle?.Checkout.open({
          items: [{ priceId: PADDLE_PRICE_ID, quantity: 1 }],
          customer: prefillEmail ? { email: prefillEmail } : undefined,
        });

        setStatus("open");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage(
          err instanceof Error ? err.message : "Failed to initialize checkout.",
        );
      }
    }

    void openCheckout();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isDark = systemPrefersDark;
  const bg = isDark ? "bg-[#0f0f0f]" : "bg-[#f6f3eb]";
  const textPrimary = isDark ? "text-white" : "text-[#1c1914]";
  const textSecondary = isDark ? "text-[#aaa]" : "text-[#5f584b]";
  const iconUrl = browser.runtime.getURL("icon.png");

  function handleClose() {
    window.close();
  }

  return (
    <div className={`min-h-screen flex flex-col items-center justify-center gap-4 font-sans ${bg}`}>
      <img src={iconUrl} alt="HitTheBell" className="w-10 h-10" />

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
            <path d="M21 12a9 9 0 1 1-6.219-8.56" className={textSecondary} />
          </svg>
          <p className={`text-[13px] ${textSecondary}`}>Opening checkout…</p>
        </div>
      )}

      {status === "open" && (
        <p className={`text-[13px] ${textSecondary}`}>
          Complete your purchase in the overlay above.
        </p>
      )}

      {status === "success" && (
        <div className="flex flex-col items-center gap-3 text-center px-6">
          <div className="w-12 h-12 rounded-full bg-[#e8f5ec] flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1f6a45" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <p className={`text-[15px] font-semibold ${textPrimary}`}>You're subscribed!</p>
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

      {status === "error" && (
        <div className="flex flex-col items-center gap-3 text-center px-6">
          <p className={`text-[14px] font-semibold ${textPrimary}`}>Something went wrong</p>
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

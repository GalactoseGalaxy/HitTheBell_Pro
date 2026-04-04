import { useEffect, useRef, useState } from "react";
import { initializePaddle, type Paddle } from "@paddle/paddle-js";
import browser from "webextension-polyfill";
import {
  setHasPaidAccess,
  setPaddleCustomerId,
  setSyncEnabled,
  setLastSyncEmail,
} from "../lib/storage";
import { BACKEND_URL } from "../lib/config";

const PADDLE_CLIENT_TOKEN = import.meta.env.VITE_PADDLE_CLIENT_TOKEN || "";
const PADDLE_PRICE_ID_MONTHLY = import.meta.env.VITE_PADDLE_PRICE_ID_MONTHLY || "";
const PADDLE_PRICE_ID_YEARLY = import.meta.env.VITE_PADDLE_PRICE_ID_YEARLY || "";
const PADDLE_ENV =
  (import.meta.env.VITE_PADDLE_ENV as "production" | "sandbox") || "production";

function getEmailParam(): string {
  try {
    return new URL(window.location.href).searchParams.get("email") ?? "";
  } catch {
    return "";
  }
}

type Plan = "monthly" | "yearly";
type CheckoutStatus = "pick" | "loading" | "open" | "success" | "error";

export default function Checkout() {
  const paddleRef = useRef<Paddle | null>(null);
  const [status, setStatus] = useState<CheckoutStatus>("pick");
  const [selectedPlan, setSelectedPlan] = useState<Plan>("yearly");
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

  function handleClose() {
    window.close();
  }

  async function handleSubscribe() {
    if (!PADDLE_CLIENT_TOKEN) {
      setStatus("error");
      setErrorMessage("Checkout is not configured yet. Missing VITE_PADDLE_CLIENT_TOKEN.");
      return;
    }

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
      const paddle = await initializePaddle({
        token: PADDLE_CLIENT_TOKEN,
        environment: PADDLE_ENV,
        checkout: {
          settings: {
            displayMode: "overlay",
            theme: isDark ? "dark" : "light",
            locale: "en",
          },
        },
        eventCallback(event) {
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

                  // Refresh from backend in case webhook already fired
                  try {
                    const res = await fetch(`${BACKEND_URL}/customers/${customerId}`);
                    if (res.ok) {
                      const payload = (await res.json()) as {
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
              } finally {
                setStatus("success");
              }
            })();
          }

          if (event.name === "checkout.closed") {
            setStatus((current) => (current === "success" ? "success" : "pick"));
          }

          if (event.name === "checkout.error") {
            setStatus("error");
            setErrorMessage("Something went wrong with checkout. Please try again.");
          }
        },
      });

      paddleRef.current = paddle ?? null;

      const prefillEmail = getEmailParam();
      paddle?.Checkout.open({
        items: [{ priceId, quantity: 1 }],
        customer: prefillEmail ? { email: prefillEmail } : undefined,
      });

      setStatus("open");
    } catch (err) {
      setStatus("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to initialize checkout.",
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
          <p className={`text-[13px] ${textSecondary}`}>Opening checkout…</p>
        </div>
      )}

      {/* Overlay is open — background hint */}
      {status === "open" && (
        <p className={`text-[13px] ${textSecondary}`}>
          Complete your purchase in the overlay above.
        </p>
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

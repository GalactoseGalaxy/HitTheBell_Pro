import "./index.css";
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import Popup from "./Popup";

// Lazy-load Checkout so Paddle JS (~180 kB) is only fetched when the
// checkout window is actually opened, not on every popup open.
const Checkout = lazy(() => import("../checkout/Checkout"));

const isCheckout = new URL(window.location.href).searchParams.has("checkout");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isCheckout ? (
      <Suspense fallback={null}>
        <Checkout />
      </Suspense>
    ) : (
      <Popup />
    )}
  </StrictMode>,
);

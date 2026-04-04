import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Checkout from "./Checkout";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Checkout />
  </StrictMode>,
);

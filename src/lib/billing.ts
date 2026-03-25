export interface BillingActionResult {
  message: string;
}

export async function startCheckout(): Promise<BillingActionResult> {
  return {
    message: "Checkout will be wired up when Paddle is connected.",
  };
}

export async function restorePurchase(): Promise<BillingActionResult> {
  return {
    message: "Restore will be available once purchases are connected.",
  };
}

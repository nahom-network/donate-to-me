import { Jami as PaymentClient, type CheckoutResult } from "jami-sdk";
import type { Env } from "./types";
import { PAYMENT_TIMEOUT_MS } from "./constants";
import { fetchWithTimeout } from "./util";

export type { CheckoutResult };

/** Payment API client with a hard timeout on every request. */
export function paymentClient(env: Env): PaymentClient {
  const timedFetch: typeof fetch = (input, init) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return fetchWithTimeout(href, init ?? {}, PAYMENT_TIMEOUT_MS);
  };
  return new PaymentClient({ token: env.JAMI_TOKEN, fetch: timedFetch });
}

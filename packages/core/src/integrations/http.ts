import { AppError } from "../errors";

/** JSON POST with a timeout; maps 429/5xx to retryable errors and 4xx to terminal ones. */
export async function postJson<T>(
  url: string,
  body: unknown,
  opts: {
    headers: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
    provider: string;
    /** POST unless set; HubSpot's association calls are PUT. */
    method?: "POST" | "PUT" | "PATCH" | "GET";
  },
): Promise<T> {
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)])
    : AbortSignal.timeout(opts.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      ...(opts.method === "GET" ? {} : { body: JSON.stringify(body) }),
      signal,
    });
  } catch (err) {
    throw new AppError("upstream_error", `${opts.provider}: request failed`, { retryable: true, cause: err });
  }
  if (!res.ok) {
    // The body can echo prompt or customer text; keep it out of errors and the ledger.
    await res.body?.cancel().catch(() => {});
    if (res.status === 429)
      throw new AppError("rate_limited", `${opts.provider}: rate limited`, { retryable: true });
    const retryable = res.status >= 500;
    throw new AppError("upstream_error", `${opts.provider}: HTTP ${res.status}`, { retryable });
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** JSON GET with the same error mapping. */
export const getJson = <T>(url: string, opts: Omit<Parameters<typeof postJson>[2], "method">): Promise<T> =>
  postJson<T>(url, undefined, { ...opts, method: "GET" });

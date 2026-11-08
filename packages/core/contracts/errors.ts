import { z } from "zod";

export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "cap_reached",
  "budget_exhausted",
  "suppressed",
  "ungrounded_claim",
  "illegal_transition",
  "upstream_error",
  "not_configured",
  "internal",
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** The one error shape on every endpoint and crew tool. */
export const ErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    requestId: z.string(),
    retryable: z.boolean(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const HTTP_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  cap_reached: 429,
  budget_exhausted: 429,
  suppressed: 422,
  ungrounded_claim: 422,
  illegal_transition: 409,
  upstream_error: 502,
  not_configured: 503,
  internal: 500,
};

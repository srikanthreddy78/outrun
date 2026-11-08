import { type ErrorBody, type ErrorCode, HTTP_STATUS } from "../contracts";

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["rate_limited", "upstream_error", "internal"]);

/** The one error class we throw. It renders as the contract's ErrorBody. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  /** From an upstream Retry-After, when there was one. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; cause?: unknown; retryAfterSeconds?: number } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "AppError";
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
    this.status = HTTP_STATUS[code];
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }

  toBody(requestId: string): ErrorBody {
    return { error: { code: this.code, message: this.message, requestId, retryable: this.retryable } };
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError("internal", "internal error", { cause: err });
}

export type KindroidErrorKind =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "server"
  | "network"
  | "generation"
  | "stream"
  | "aborted"

const FRIENDLY: Record<KindroidErrorKind, string> = {
  bad_request: "Kindroid rejected the request",
  unauthorized: "API key is invalid or revoked (check KINDROID_API_KEY or config.toml)",
  forbidden: "Not allowed: this needs an active Kindroid subscription",
  not_found: "Unknown Kindroid or group ID",
  conflict: "Can't do that right now",
  rate_limited: "Rate limited by Kindroid",
  server: "Kindroid server error",
  network: "Network error talking to Kindroid",
  generation: "The AI failed to generate a reply",
  stream: "The reply stream broke off",
  aborted: "Stopped",
}

export class KindroidError extends Error {
  readonly kind: KindroidErrorKind
  readonly status?: number
  readonly detail?: string
  /** Text received before a stream failed, if any. */
  readonly partial?: string

  constructor(kind: KindroidErrorKind, opts: { status?: number; detail?: string; partial?: string } = {}) {
    const detail = opts.detail ? redact(opts.detail).trim().slice(0, 300) : undefined
    super(detail ? `${FRIENDLY[kind]}: ${detail}` : FRIENDLY[kind])
    this.name = "KindroidError"
    this.kind = kind
    this.status = opts.status
    this.detail = detail
    this.partial = opts.partial
  }
}

/** Remove anything that looks like a Kindroid API key from a string before it is shown or logged. */
export function redact(text: string): string {
  return text.replace(/kn_[A-Za-z0-9_\-]{4,}/g, "kn_…")
}

export function kindForStatus(status: number): KindroidErrorKind {
  switch (status) {
    case 400:
      return "bad_request"
    case 401:
      return "unauthorized"
    case 403:
      return "forbidden"
    case 404:
      return "not_found"
    case 409:
      return "conflict"
    case 429:
      return "rate_limited"
    default:
      return status >= 500 ? "server" : "bad_request"
  }
}

export function isAbort(err: unknown): boolean {
  if (err instanceof KindroidError) return err.kind === "aborted"
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")
}

export function describeError(err: unknown): string {
  if (err instanceof KindroidError) return err.message
  if (err instanceof Error) return redact(err.message)
  return redact(String(err))
}

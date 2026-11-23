// Typed gateway failures: the stable public error codes, the error class, and
// the sanitizers that keep upstream payloads out of public envelopes.

/** Stable typed error codes returned at gateway boundaries. */
export type GatewayErrorCode =
  | "capability_unsupported"
  | "ambiguous_model"
  | "model_not_found"
  | "model_not_allowed"
  | "upstream_not_found"
  | "context_length_exceeded"
  | "request_too_large"
  | "accounts_unavailable"
  | "accounts_rate_limited"
  | "capacity_exhausted"
  | "upstream_overloaded"
  | "provider_capacity_exhausted"
  | "upstream_queued"
  | "proxy_pool_capacity_exceeded"
  | "proxy_pool_provider_capacity_exceeded"
  | "proxy_pool_blocked"
  | "proxy_pool_cooldown"
  | "proxy_pool_unavailable"
  | "proxy_pool_unhealthy"
  | "invalid_pool_limits"
  | "admission_unavailable"
  | "route_unavailable"
  | "slug_reserved"
  | "quota_exceeded"
  | "rate_limited"
  | "authentication_failed"
  | "policy_rejected"
  | "invalid_request"
  | "not_found"
  | "link_not_found"
  | "link_expired"
  | "link_revoked"
  | "link_disabled"
  | "invalid_sequence"
  | "invalid_lifecycle"
  | "unsupported_field"
  | "unsupported_media_type"
  | "upstream_conflict"
  | "upstream_unprocessable"
  | "internal_error"
  | "transport_unavailable"
  | "tunnel_setup_failed"
  | "platform_unavailable"
  | "tenant_capacity_exhausted"
  | "tls_rejected"
  | "proxy_auth_required"
  | "deadline_exceeded"
  | "transport_closed"
  | "max_connections_exceeded"
  | "overloaded"
  | "proxy_unreachable"
  | "tool_call_loop_detected"
  | "client_router_denied"
  | "shutting_down";

/** Identifies which boundary produced a safe public error. */
export type GatewayErrorOrigin = "cartethyia" | "upstream" | "network";

/**
 * Error with a client-safe stable code, origin, and sanitized metadata.
 */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;
  readonly origin: GatewayErrorOrigin;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: GatewayErrorCode,
    status: number,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    origin: GatewayErrorOrigin = "cartethyia",
  ) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
    this.origin = origin;
    this.details = details;
  }
}

/**
 * Legacy origin brand prefixes. Older builds stamped these into the public
 * `message`; strip them so a value that crossed two shapers is not doubled
 * and so clients never see product branding in the error text.
 *
 * Blame lives in the structured `origin` field (`cartethyia` | `upstream` |
 * `network`). The public message is always `code: explanatory` for every
 * origin — gateway and upstream look the same on the wire.
 */
const LEGACY_ORIGIN_LABELS: readonly string[] = [
  "Cartethyia Error:",
  "Upstream Error:",
  "Network Error:",
];

function stripLegacyOriginLabel(message: string): string {
  const trimmed = message.trim();
  for (const prefix of LEGACY_ORIGIN_LABELS) {
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trimStart();
  }
  return trimmed;
}

/**
 * Public client-facing error text: a plain sentence, with no machine code
 * stamped into it.
 *
 * The code is not lost — it travels in the envelope's `error.code` field, and
 * the HTTP status carries the class. Stamping it into the text
 * (`accounts_unavailable: Model 'x' has no available account (52 candidate(s)
 * unusable: credit_floor_reached, model_cooldown)`) would put internal enum
 * names in front of the operator's sentence and make the message unreadable
 * while adding nothing the field does not already carry.
 *
 * Stripping is idempotent, and that is the point: a message that already
 * carries a `code:` prefix — stamped by an older builder, or by a code path
 * that formats before it reaches here — loses it once instead of being
 * doubled. Origin is never written into the text either; clients that need the
 * layer read `error.origin`.
 */
export function formatPublicErrorMessage(code: string, message: string): string {
  const strippedOrigin = stripLegacyOriginLabel(message);
  // A leading `<code>:` is the old stamping; drop it so the sentence stands on
  // its own. Matched against the code this call is formatting, so a message
  // that legitimately begins with some other word is left alone.
  const prefix = `${code}:`;
  const explanatory = strippedOrigin.startsWith(prefix)
    ? strippedOrigin.slice(prefix.length).trimStart()
    : strippedOrigin;
  if (explanatory.length === 0) return code;
  return explanatory;
}

/** Formats a gateway error for public/internal clients without mutating it. */
export function explainGatewayError(error: GatewayError): string {
  return formatPublicErrorMessage(error.code, error.message);
}

const PUBLIC_ERROR_DETAIL_KEYS = new Set([
  "accountId",
  "accountScope",
  "available",
  "capacity",
  "configuredPools",
  "cooldownReason",
  "gateway_hint",
  "currentInflight",
  "credentialEvidence",
  "model",
  "poolId",
  "pools",
  "providerCode",
  "providerId",
  "providerStatus",
  "providerScope",
  "raw",
  "rateLimitScope",
  "reason",
  "reasons",
  "candidate_count",
  "requestId",
  "retryAfterMs",
  "retryAt",
  "safeMessage",
  "scope",
  "status",
  "upstreamRequestId",
  "upstreamStatus",
  "maxInflight",
  "weight",
]);
function sanitizePublicDetail(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 3) return "[redacted]";
  if (Array.isArray(value))
    return value.slice(0, 32).map((entry) => sanitizePublicDetail(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sanitizePublicDetail(entry, depth + 1),
    ]),
  );
}

/** Returns bounded allowlisted details suitable for public error envelopes. */
export function publicGatewayErrorDetails(
  error: GatewayError,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(error.details)
      .filter(([key]) => PUBLIC_ERROR_DETAIL_KEYS.has(key))
      .map(([key, value]) => [key, sanitizePublicDetail(value)]),
  );
}

/**
 * Whether a client may learn which upstream served it.
 *
 * `expose` is the historical envelope: the upstream's own message, its status
 * and code, the provider id, and a raw excerpt of its body. `hide` is for a
 * deployment that resells capacity and must not reveal its suppliers: every
 * failure reads as this gateway's own, in a small neutral vocabulary. The mode
 * is resolved from configuration by the caller (`resolveUpstreamIdentityMode`
 * in `src/config/security.ts`); this module stays free of environment reads.
 */
export type UpstreamIdentityMode = "expose" | "hide";

/** One failure as a client sees it, before the request id is stamped. */
export interface PublicErrorView {
  readonly origin: GatewayErrorOrigin;
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * Codes that name the gateway's internals — accounts, providers, egress pools,
 * the upstream itself — folded onto the neutral code a client can act on.
 * A code absent here and from {@link NEUTRAL_ERROR_MESSAGES} is kept as is.
 */
const CONCEALED_CODE_ALIASES: Readonly<Record<string, string>> = {
  ambiguous_model: "model_not_found",
  upstream_not_found: "model_not_found",
  upstream_conflict: "invalid_request",
  upstream_unprocessable: "invalid_request",
  invalid_sequence: "invalid_request",
  invalid_lifecycle: "invalid_request",
  accounts_rate_limited: "rate_limited",
  provider_capacity_exhausted: "rate_limited",
  proxy_pool_capacity_exceeded: "rate_limited",
  proxy_pool_provider_capacity_exceeded: "rate_limited",
  tenant_capacity_exhausted: "rate_limited",
  accounts_unavailable: "overloaded",
  route_unavailable: "overloaded",
  upstream_overloaded: "overloaded",
  upstream_queued: "overloaded",
  proxy_pool_blocked: "overloaded",
  proxy_pool_cooldown: "overloaded",
  proxy_pool_unavailable: "overloaded",
  proxy_pool_unhealthy: "overloaded",
  admission_unavailable: "overloaded",
  transport_unavailable: "overloaded",
  transport_closed: "overloaded",
  tunnel_setup_failed: "overloaded",
  platform_unavailable: "overloaded",
  tls_rejected: "overloaded",
  proxy_auth_required: "overloaded",
  proxy_unreachable: "overloaded",
  max_connections_exceeded: "overloaded",
};

/**
 * Codes that describe the *gateway's* credential or balance when the upstream
 * produced them. A supplier rejecting the reseller's key is not the client's
 * key being wrong, so telling the client "check your API key" would be both
 * false and a hint that a second key exists behind this one.
 */
const UPSTREAM_ACCOUNT_CODES: ReadonlySet<string> = new Set([
  "authentication_failed",
  "quota_exceeded",
]);

/** The neutral sentence for each public code. Never names a provider, model, account, or pool. */
const NEUTRAL_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_request: "The request was rejected as invalid. Check the parameters and try again.",
  authentication_failed: "Authentication failed. Check your API key.",
  policy_rejected: "The request was refused by policy.",
  model_not_found: "The requested model is not available.",
  model_not_allowed: "This API key is not allowed to use the requested model.",
  capability_unsupported: "The requested model does not support a feature used in this request.",
  context_length_exceeded: "The request is longer than the model's context window. Shorten the input or lower the output limit.",
  request_too_large: "The request body is too large.",
  unsupported_field: "The request contains a field that is not supported.",
  unsupported_media_type: "The request contains media of a type that is not supported.",
  rate_limited: "Too many requests right now. Retry after a short wait.",
  quota_exceeded: "The usage limit for this API key has been reached.",
  capacity_exhausted: "Too many concurrent requests for this API key. Retry when one finishes.",
  overloaded: "The service is temporarily unavailable. Retry shortly.",
  deadline_exceeded: "The request timed out. Retry, or reduce the size of the request.",
  tool_call_loop_detected: "The response was stopped because the model kept repeating the same tool call.",
  not_found: "Not found.",
  internal_error: "An internal error occurred. Retry; if it persists, contact support with the request id.",
};

/** Detail keys a concealed envelope keeps: retry timing, which names nothing. */
const CONCEALED_DETAIL_KEYS: ReadonlySet<string> = new Set(["retryAfterMs", "retryAt"]);

/**
 * Applies {@link UpstreamIdentityMode} to one client-facing failure.
 *
 * `expose` returns the view unchanged. `hide`:
 * - reports every failure as the gateway's (`origin: "cartethyia"`), because
 *   `upstream`/`network` already says a supplier sits behind the gateway;
 * - folds internal codes onto the neutral set, and turns an upstream
 *   credential/balance refusal into `overloaded` 503 — it is the gateway's
 *   problem, not the client's;
 * - replaces the message with a fixed sentence, so the supplier's own wording
 *   (a fingerprint on its own) never reaches the client;
 * - drops every detail except retry timing.
 *
 * The HTTP status is kept except for that credential case, so client retry
 * logic keyed on status classes behaves the same in both modes. Telemetry and
 * Request Detail keep the original error; only the client copy is concealed.
 */
export function concealPublicError(view: PublicErrorView, mode: UpstreamIdentityMode): PublicErrorView {
  if (mode === "expose") return view;
  const fromSupplier = view.origin !== "cartethyia";
  const accountFailure = fromSupplier && UPSTREAM_ACCOUNT_CODES.has(view.code);
  const status = accountFailure ? 503 : view.status;
  let code = accountFailure ? "overloaded" : (CONCEALED_CODE_ALIASES[view.code] ?? view.code);
  // A supplier code with no neutral sentence is unknown vocabulary: fold it by
  // status class rather than pass the supplier's own code through.
  if (fromSupplier && NEUTRAL_ERROR_MESSAGES[code] === undefined) {
    code = status >= 500 ? "overloaded" : "invalid_request";
  }
  const neutral = NEUTRAL_ERROR_MESSAGES[code];
  return {
    origin: "cartethyia",
    code,
    status,
    // A gateway-only code with no neutral sentence (a share link, a
    // client-router denial, an Elysia built-in) never carried upstream text, so
    // its own message stands.
    message: neutral === undefined ? view.message : `${neutral} (request {requestId})`,
    details: Object.fromEntries(
      Object.entries(view.details).filter(([key]) => CONCEALED_DETAIL_KEYS.has(key)),
    ),
  };
}

/** The public view of a {@link GatewayError}, concealed per `mode`. */
export function publicGatewayErrorView(
  error: GatewayError,
  mode: UpstreamIdentityMode = "expose",
): PublicErrorView {
  return concealPublicError(
    {
      origin: error.origin,
      code: error.code,
      status: error.status,
      message: explainGatewayError(error),
      details: publicGatewayErrorDetails(error),
    },
    mode,
  );
}

/** Serializes a GatewayError with the same public shape as transport errors. */
export function publicGatewayErrorBody(
  error: GatewayError,
  mode: UpstreamIdentityMode = "expose",
): {
  readonly error: {
    readonly origin: GatewayErrorOrigin;
    readonly code: string;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>>;
  };
} {
  const view = publicGatewayErrorView(error, mode);
  return {
    error: {
      origin: view.origin,
      code: view.code,
      message: view.message,
      details: view.details,
    },
  };
}

/** Creates the typed rejection required when a semantic feature is unavailable. */
export function capabilityUnsupported(
  capability: string,
  details: Readonly<Record<string, unknown>> = {},
): GatewayError {
  return new GatewayError(
    "capability_unsupported",
    400,
    `The selected route does not support capability: ${capability} (request {requestId}). Drop the ${capability} part of the request, or route to a model that accepts it. Know your tools — this one just isn't in the box 🧰`,
    { capability, ...details },
  );
}

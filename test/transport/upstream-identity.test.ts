/**
 * `CARTETHYIA_UPSTREAM_IDENTITY=hide`: a reseller deployment must not tell a
 * client which upstream served it — not in an error's text, code, origin or
 * details, and not in a response's model name, fingerprint or id.
 *
 * `expose` (the default) must stay byte-identical to the historical envelope,
 * so each concealment assertion is paired with the unchanged `expose` reading.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  GatewayError,
  concealPublicError,
  publicGatewayErrorBody,
  type PublicErrorView,
} from "../../src/protocol/gateway-error";
import { resolveUpstreamIdentityMode } from "../../src/config/security";
import { concealResponseIdentity } from "../../src/transport/surface/public-identity";
import { createErrorNormalizationMiddleware } from "../../src/transport/guards/error-lifecycle";
import { ProxyRequestStateStore } from "../../src/transport/request/state";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";

const ENV = "CARTETHYIA_UPSTREAM_IDENTITY";
const previous = process.env[ENV];
afterEach(() => {
  if (previous === undefined) delete process.env[ENV];
  else process.env[ENV] = previous;
});

/** The shape OpenScale's own 400 reached the client in before this change. */
function upstreamInvalidValue(): GatewayError {
  return new GatewayError(
    "invalid_request",
    400,
    "Invalid value for 'temperature': 9 is out of range; it takes a number from 0 to 2.",
    {
      providerId: "openscale",
      providerStatus: 400,
      providerCode: "invalid_value",
      raw: '{"error":{"message":"Invalid value for \'temperature\'","code":"invalid_value"}}',
    },
    "upstream",
  );
}

function view(partial: Partial<PublicErrorView> & Pick<PublicErrorView, "code">): PublicErrorView {
  return { origin: "upstream", status: 400, message: "supplier wording", details: {}, ...partial };
}

describe("mode resolution", () => {
  test("defaults to expose, accepts hide, refuses anything else", () => {
    delete process.env[ENV];
    expect(resolveUpstreamIdentityMode()).toBe("expose");
    process.env[ENV] = "HIDE";
    expect(resolveUpstreamIdentityMode()).toBe("hide");
    process.env[ENV] = "hidden";
    expect(() => resolveUpstreamIdentityMode()).toThrow(/expose" or "hide/);
  });
});

describe("concealPublicError", () => {
  test("expose returns the view untouched", () => {
    const original = view({ code: "invalid_request", details: { providerId: "openscale" } });
    expect(concealPublicError(original, "expose")).toBe(original);
  });

  test("an upstream 400 loses the supplier's wording, origin, code and details", () => {
    const body = publicGatewayErrorBody(upstreamInvalidValue(), "hide");
    expect(body.error.origin).toBe("cartethyia");
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toBe(
      "The request was rejected as invalid. Check the parameters and try again. (request {requestId})",
    );
    expect(body.error.details).toEqual({});
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("openscale");
    expect(serialized).not.toContain("temperature");
    expect(serialized).not.toContain("invalid_value");
  });

  test("the exposed envelope is what it always was", () => {
    const body = publicGatewayErrorBody(upstreamInvalidValue());
    expect(body.error.origin).toBe("upstream");
    expect(body.error.details.providerId).toBe("openscale");
    expect(body.error.message).toContain("temperature");
  });

  test("internal capacity and availability codes fold onto neutral ones", () => {
    const capacity = concealPublicError(
      view({ origin: "cartethyia", code: "provider_capacity_exhausted", status: 429, details: { providerId: "openscale", maxInflight: 1, candidate_count: 1 } }),
      "hide",
    );
    expect(capacity.code).toBe("rate_limited");
    expect(capacity.status).toBe(429);
    expect(capacity.details).toEqual({});

    const unavailable = concealPublicError(view({ origin: "cartethyia", code: "accounts_unavailable", status: 503 }), "hide");
    expect(unavailable.code).toBe("overloaded");
    expect(unavailable.message).not.toMatch(/account|provider|pool|upstream/i);
  });

  test("retry timing survives: it names nothing and clients need it", () => {
    const concealed = concealPublicError(
      view({ origin: "cartethyia", code: "accounts_rate_limited", status: 429, details: { retryAfterMs: 5000, retryAt: "2026-11-23T00:00:00Z", providerId: "openscale" } }),
      "hide",
    );
    expect(concealed.details).toEqual({ retryAfterMs: 5000, retryAt: "2026-11-23T00:00:00Z" });
  });

  test("a supplier refusing the gateway's own key is not reported as the client's key", () => {
    const concealed = concealPublicError(view({ code: "authentication_failed", status: 401 }), "hide");
    expect(concealed.code).toBe("overloaded");
    expect(concealed.status).toBe(503);
    // The same code produced by the gateway is about the client's key and stays.
    const own = concealPublicError(view({ origin: "cartethyia", code: "authentication_failed", status: 401 }), "hide");
    expect(own.code).toBe("authentication_failed");
    expect(own.status).toBe(401);
  });

  test("an unknown supplier code folds by status class", () => {
    expect(concealPublicError(view({ code: "upstream_something_new", status: 422 }), "hide").code).toBe("invalid_request");
    expect(concealPublicError(view({ code: "upstream_something_new", status: 502 }), "hide").code).toBe("overloaded");
  });

  test("a gateway-only code with no neutral sentence keeps its own text", () => {
    const own = concealPublicError(
      view({ origin: "cartethyia", code: "link_expired", status: 404, message: "This share link has expired (request {requestId})." }),
      "hide",
    );
    expect(own.code).toBe("link_expired");
    expect(own.message).toBe("This share link has expired (request {requestId}).");
  });
});

describe("error middleware", () => {
  function app(): Elysia {
    const stateStore = new ProxyRequestStateStore(undefined);
    return new Elysia()
      .use(createErrorNormalizationMiddleware({ stateStore }))
      .get("/fail", () => {
        throw upstreamInvalidValue();
      }) as unknown as Elysia;
  }

  test("hide conceals the wire envelope and stamps the request id", async () => {
    process.env[ENV] = "hide";
    const response = await app().handle(new Request("https://gateway.test/fail"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: Record<string, unknown> };
    const requestId = response.headers.get("x-request-id");
    expect(body.error.origin).toBe("cartethyia");
    expect(body.error.details).toEqual({});
    expect(body.error.message).toBe(
      `The request was rejected as invalid. Check the parameters and try again. (request ${requestId})`,
    );
    expect(JSON.stringify(body)).not.toContain("openscale");
  });

  test("expose keeps the upstream envelope", async () => {
    delete process.env[ENV];
    const response = await app().handle(new Request("https://gateway.test/fail"));
    const body = (await response.json()) as { error: { origin: string; details: Record<string, unknown> } };
    expect(body.error.origin).toBe("upstream");
    expect(body.error.details.providerId).toBe("openscale");
  });
});

describe("concealResponseIdentity", () => {
  const start = {
    type: "response_start",
    sequence_number: 0,
    event_id: "chatcmpl-xkGhpmeCp6f10owhxCdg5s7G",
    response_id: "resp_upstream_1",
    model: "deepseek/deepseek-v4.1-flash-1017",
    system_fingerprint: "fp_supplier",
  } as CanonicalEvent;

  test("the opening event names the client's model, with no fingerprint or supplier id", () => {
    const concealed = concealResponseIdentity(start, "ds-flash", "chat") as Record<string, unknown>;
    expect(concealed.model).toBe("ds-flash");
    expect(concealed.system_fingerprint).toBeUndefined();
    expect(concealed.event_id).toBeUndefined();
    expect(concealed.response_id).toBeUndefined();
  });

  test("responses keeps its ids so previous_response_id still chains", () => {
    const concealed = concealResponseIdentity(start, "ds-flash", "responses") as Record<string, unknown>;
    expect(concealed.model).toBe("ds-flash");
    expect(concealed.event_id).toBe("chatcmpl-xkGhpmeCp6f10owhxCdg5s7G");
    expect(concealed.response_id).toBe("resp_upstream_1");
    expect(concealed.system_fingerprint).toBeUndefined();
  });

  test("other events pass through untouched", () => {
    const delta = { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "hi" } } as CanonicalEvent;
    expect(concealResponseIdentity(delta, "ds-flash", "chat")).toBe(delta);
  });
});

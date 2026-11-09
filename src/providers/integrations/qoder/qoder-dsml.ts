/**
 * Recovery for DSML tool-call markup that Qoder's DeepSeek models write into
 * the plain-text content stream.
 *
 * Qoder's normal wire is structured `tool_calls`, but DeepSeek on Qoder
 * sometimes falls back to its native markup and writes it as visible text:
 *
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="">
 *   <｜｜DSML｜｜ parameter name="path" string="true">app/Foo.php</｜｜DSML｜｜ parameter>
 *   <｜｜DSML｜｜ parameter name="offset" string="false">2230｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ calls>
 *
 * The markup Qoder lets through is routinely malformed: doubled separators,
 * closing tags missing `</`, a missing `</…invoke>`, and even an empty
 * `name=""`. The strict CodeBuddy parser and the regex fuzzy parser in
 * `protocol/dsml.ts` both reject that shape, so the block reached the client
 * as raw text and no tool ran.
 *
 * This parser tokenizes every DSML tag it can find and builds calls
 * positionally, so a missing closer simply ends the value at the next tag. An
 * empty or unknown tool name is resolved against the request's declared tools
 * by matching the parameter keys to each tool's JSON schema; it is accepted
 * only when exactly one declared tool fits.
 */
import { randomUUID } from "node:crypto";
import { GatewayError } from "../../../protocol/gateway-error";
import type { CanonicalEvent } from "../../../protocol/canonical-model";

export interface QoderDsmlCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** The slice of a declared tool this parser needs. */
export interface QoderDsmlTool {
  readonly name: string;
  readonly jsonSchema?: unknown;
}

export interface QoderDsmlResult {
  readonly calls: readonly QoderDsmlCall[];
  /** Prose that preceded the first DSML tag. */
  readonly before: string;
  /** Prose that followed the closing `calls` tag, if any. */
  readonly after: string;
}

/** Fullwidth vertical line → ASCII. Both are one UTF-16 unit, so indexes hold. */
function normalizePipes(text: string): string {
  return text.replace(/｜/g, "|");
}

const SEP = String.raw`\|(?:\s*\|){0,2}`;

/** Start of any DSML tag (opening or closing) in pipe-normalized text. */
const DSML_TAG_START_RE = new RegExp(String.raw`<\s*\/?\s*${SEP}\s*DSML`, "i");

/**
 * One DSML tag, tolerant of a missing `<` / `</` and a missing `>`:
 *   1: the `<` / `</` prefix (may be absent)
 *   2: tag kind (calls, invoke, parameter, …)
 *   3: attribute text
 */
const DSML_TOKEN_RE = new RegExp(
  String.raw`(<\s*\/?\s*)?${SEP}\s*DSML\s*${SEP}\s*([A-Za-z_]+)((?:\s+[A-Za-z_-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>?`,
  "gi",
);

const ATTR_RE = /([A-Za-z_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const TOOL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;

/** True when `text` contains the start of a DSML tag. */
export function findDsmlStart(text: string): number {
  const match = DSML_TAG_START_RE.exec(normalizePipes(text));
  return match ? match.index : -1;
}

/**
 * The suffix of `text` that may be the beginning of a DSML tag split across
 * frames (`<`, `<｜`, `<｜｜DS`, …). Empty when nothing needs holding.
 */
export function dsmlPartialTail(text: string): string {
  const at = text.lastIndexOf("<");
  if (at < 0 || text.length - at > 16) return "";
  const tail = text.slice(at);
  if (tail.includes(">")) return "";
  const norm = normalizePipes(tail);
  return /^<\s*\/?\s*(?:\|[\s|]*(?:D(?:S(?:M(?:L)?)?)?)?)?$/i.test(norm) ? tail : "";
}

interface Token {
  readonly kind: string;
  readonly closing: boolean;
  readonly attrs: Readonly<Record<string, string>>;
  readonly start: number;
  readonly end: number;
}

function tokenize(text: string): Token[] {
  const norm = normalizePipes(text);
  const tokens: Token[] = [];
  DSML_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DSML_TOKEN_RE.exec(norm)) !== null) {
    if (m[0].length === 0) {
      DSML_TOKEN_RE.lastIndex += 1;
      continue;
    }
    const prefix = m[1] ?? "";
    const kind = (m[2] ?? "").toLowerCase();
    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR_RE.exec(m[3] ?? "")) !== null) {
      attrs[(a[1] ?? "").toLowerCase()] = a[2] ?? a[3] ?? "";
    }
    // A `parameter` / `invoke` tag carrying `name=` opens; one without it is a
    // closer even when the model dropped the `</` (`2230｜｜DSML｜｜ parameter>`).
    const closing =
      prefix.includes("/") ||
      ((kind === "parameter" || kind === "invoke") && attrs["name"] === undefined) ||
      (!prefix.includes("<") && attrs["name"] === undefined);
    tokens.push({ kind, closing, attrs, start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

function schemaOf(tool: QoderDsmlTool | undefined): { props: Record<string, unknown>; required: string[] } {
  const schema = (tool?.jsonSchema ?? {}) as Record<string, unknown>;
  const props =
    typeof schema["properties"] === "object" && schema["properties"] !== null
      ? (schema["properties"] as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema["required"])
    ? (schema["required"] as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  return { props, required };
}

/**
 * Picks the declared tool a call meant. An exact (then case-insensitive) name
 * match wins; otherwise the parameter keys must fit exactly one tool's schema
 * (every key declared, every required key present).
 */
function resolveToolName(
  name: string,
  keys: readonly string[],
  tools: readonly QoderDsmlTool[],
): string | undefined {
  if (tools.length === 0) return TOOL_NAME_RE.test(name) ? name : undefined;
  if (name.length > 0) {
    const exact = tools.find((t) => t.name === name);
    if (exact) return exact.name;
    const folded = tools.filter((t) => t.name.toLowerCase() === name.toLowerCase());
    if (folded.length === 1) return folded[0]!.name;
  }
  if (keys.length === 0) return undefined;
  const fits = tools.filter((tool) => {
    const { props, required } = schemaOf(tool);
    const declared = Object.keys(props);
    if (declared.length === 0) return false;
    return keys.every((k) => declared.includes(k)) && required.every((r) => keys.includes(r));
  });
  return fits.length === 1 ? fits[0]!.name : undefined;
}

function propertyType(tool: QoderDsmlTool | undefined, key: string): string | undefined {
  const prop = schemaOf(tool).props[key];
  if (typeof prop !== "object" || prop === null) return undefined;
  const type = (prop as Record<string, unknown>)["type"];
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.find((t): t is string => typeof t === "string" && t !== "null");
  return undefined;
}

function decodeValue(raw: string, stringAttr: string | undefined, schemaType: string | undefined): unknown {
  // DSML values sit on their own lines inside the tags; drop one framing
  // newline on each side without touching meaningful inner whitespace.
  const value = raw.replace(/^\r?\n/, "").replace(/\r?\n[ \t]*$/, "");
  if (stringAttr === "true") return value;
  if (schemaType === "string") return value;
  if (stringAttr === "false" || (schemaType !== undefined && schemaType !== "string")) {
    try {
      return JSON.parse(value.trim());
    } catch {
      return value;
    }
  }
  return value;
}

interface DraftCall {
  name: string;
  params: Array<{ key: string; stringAttr: string | undefined; raw: string }>;
}

/**
 * Parses a buffer that starts at (or contains) a DSML block. Returns null when
 * no tool call could be recovered; a call whose tool cannot be identified
 * makes the whole block unrecoverable rather than running a guessed tool.
 */
export function parseQoderDsml(
  text: string,
  tools: readonly QoderDsmlTool[] = [],
): QoderDsmlResult | null {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;

  const drafts: DraftCall[] = [];
  let current: DraftCall | undefined;
  let afterIndex = -1;

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind === "invoke" && !tok.closing) {
      current = { name: (tok.attrs["name"] ?? "").trim(), params: [] };
      drafts.push(current);
    } else if (tok.kind === "invoke" && tok.closing) {
      current = undefined;
    } else if (tok.kind === "parameter" && !tok.closing) {
      if (!current) {
        // A parameter outside any invoke: the model dropped the invoke tag.
        current = { name: "", params: [] };
        drafts.push(current);
      }
      // The value runs to the next DSML tag, whatever it is — this is what
      // makes a missing or broken closer harmless.
      const next = tokens[i + 1];
      const raw = text.slice(tok.end, next ? next.start : text.length);
      const key = tok.attrs["name"] ?? "";
      if (key.length > 0) current.params.push({ key, stringAttr: tok.attrs["string"], raw });
    } else if (tok.kind.endsWith("calls") && tok.closing) {
      afterIndex = tok.end;
      current = undefined;
    }
  }

  if (drafts.length === 0) return null;
  const calls: QoderDsmlCall[] = [];
  for (const draft of drafts) {
    const keys = draft.params.map((p) => p.key);
    const name = resolveToolName(draft.name, keys, tools);
    if (name === undefined) return null;
    const tool = tools.find((t) => t.name === name);
    const args: Record<string, unknown> = {};
    for (const p of draft.params) args[p.key] = decodeValue(p.raw, p.stringAttr, propertyType(tool, p.key));
    calls.push({
      id: `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      name,
      arguments: JSON.stringify(args),
    });
  }

  const first = tokens[0]!;
  return {
    calls,
    before: text.slice(0, first.start),
    after: afterIndex >= 0 ? text.slice(afterIndex) : "",
  };
}

/** True when the buffer clearly attempted a DSML tool call (has an invoke or parameter tag). */
export function isQoderDsmlAttempt(text: string): boolean {
  return tokenize(text).some((t) => t.kind === "invoke" || t.kind === "parameter");
}

/** Cap on a held DSML block; past it the turn fails closed instead of buffering forever. */
const DSML_HOLD_MAX_CHARS = 4 * 1024 * 1024;

const DSML_UNRECOVERABLE_MESSAGE =
  "Qoder returned an unparseable tool-call echo (request {requestId}); no tools were emitted. The upstream came back empty-handed — retry 🌙";

function dsmlUnrecoverableError(): GatewayError {
  return new GatewayError(
    "platform_unavailable",
    502,
    DSML_UNRECOVERABLE_MESSAGE,
    { providerId: "qoder" },
    "upstream",
  );
}

/**
 * Wraps one Qoder canonical event stream (gRPC, IDE, or COSY surface) and
 * turns DSML markup written into the text stream back into tool calls.
 *
 * Everything from the first DSML tag on is held; a possible partial tag split
 * across frames (`<｜｜DS`) is held until the next text piece decides it. At
 * the terminal event (or end of stream) the held block is parsed: recovered
 * calls are emitted as `tool_call_delta` before the terminal, which then
 * carries `tool_use`; an unmistakable DSML call that cannot be recovered fails
 * the turn (502, retryable) instead of leaking markup to the client; anything
 * else is released as ordinary text. A stream with no DSML passes through
 * unchanged apart from sequence numbers, which are renumbered so inserted
 * events keep the order strict.
 */
export async function* recoverQoderDsmlEvents(
  events: AsyncIterable<CanonicalEvent>,
  tools: readonly QoderDsmlTool[],
): AsyncGenerator<CanonicalEvent> {
  let seq: number | undefined;
  const next = (event: CanonicalEvent): CanonicalEvent => {
    seq = seq === undefined ? event.sequence_number : seq + 1;
    return { ...event, sequence_number: seq } as CanonicalEvent;
  };
  const text = (value: string): CanonicalEvent =>
    next({ type: "content_delta", sequence_number: 0, content: { kind: "text", text: value } } as CanonicalEvent);
  let held = "";
  let tail = "";
  const callIds = new Set<string>();
  let recoveredCalls = false;

  function* flush(): Generator<CanonicalEvent> {
    if (tail.length > 0) {
      if (held.length > 0) held += tail;
      else yield text(tail);
      tail = "";
    }
    if (held.length === 0) return;
    const block = held;
    held = "";
    const recovered = parseQoderDsml(block, tools);
    if (recovered !== null) {
      const prose = `${recovered.before}${recovered.after}`.trim();
      if (prose.length > 0) yield text(prose);
      for (const call of recovered.calls) {
        yield next({
          type: "tool_call_delta",
          sequence_number: 0,
          call_id: call.id,
          index: callIds.size,
          name: call.name,
          arguments_delta: call.arguments,
        } as CanonicalEvent);
        callIds.add(call.id);
      }
      recoveredCalls = recovered.calls.length > 0;
      return;
    }
    if (isQoderDsmlAttempt(block)) throw dsmlUnrecoverableError();
    yield text(block);
  }

  for await (const event of events) {
    if (event.type === "content_delta" && event.content.kind === "text") {
      let piece = tail + event.content.text;
      tail = "";
      if (held.length > 0) {
        held += piece;
        if (held.length > DSML_HOLD_MAX_CHARS) throw dsmlUnrecoverableError();
        continue;
      }
      const at = findDsmlStart(piece);
      if (at >= 0) {
        if (at > 0) yield text(piece.slice(0, at));
        held = piece.slice(at);
        continue;
      }
      const partial = dsmlPartialTail(piece);
      if (partial.length > 0) {
        tail = partial;
        piece = piece.slice(0, piece.length - partial.length);
      }
      if (piece.length > 0) yield text(piece);
      continue;
    }
    if (event.type === "tool_call_delta") callIds.add(event.call_id);
    if (event.type === "terminal") {
      yield* flush();
      if (recoveredCalls && event.state === "complete") {
        yield next({ ...event, stop_reason: "tool_use", provider_stop_reason: "tool_calls" } as CanonicalEvent);
      } else {
        yield next(event);
      }
      recoveredCalls = false;
      continue;
    }
    yield next(event);
  }
  yield* flush();
}

/**
 * Response-side half of `CARTETHYIA_UPSTREAM_IDENTITY=hide` (the error half is
 * `concealPublicError` in `src/protocol/gateway-error.ts`).
 *
 * A successful response names its upstream in three places, all on the opening
 * `message_start`/`response_start` event that every surface encoder reads: the
 * upstream's own model id (`deepseek/deepseek-v4.1-flash-1017` — a naming
 * scheme and a version pin that identify a supplier on their own), the
 * upstream's `system_fingerprint`, and the upstream's response id format.
 * This rewrites that event before encoding, so chat, messages, responses and
 * completion all answer with the model name the client asked for.
 *
 * Applied to the client copy only: telemetry, the event transcript, and the
 * `reportedModel` stamp read the original events.
 */
import type { CanonicalEvent, SourceSurface } from "../../protocol/canonical-model";

export function concealResponseIdentity(
  event: CanonicalEvent,
  publicModel: string,
  surface: SourceSurface,
): CanonicalEvent {
  if (event.type !== "message_start" && event.type !== "response_start") return event;
  const { system_fingerprint: _fingerprint, event_id, response_id, ...rest } = event;
  return {
    ...rest,
    model: publicModel,
    // Responses ids stay: a client continues a conversation by sending one
    // back as `previous_response_id`, and a gateway-minted id would point the
    // upstream at a response it never stored. Every other surface's id is
    // cosmetic, so the encoder mints its own.
    ...(surface === "responses" && event_id !== undefined ? { event_id } : {}),
    ...(surface === "responses" && response_id !== undefined ? { response_id } : {}),
  } as CanonicalEvent;
}

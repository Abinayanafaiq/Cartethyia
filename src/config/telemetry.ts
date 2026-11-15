/**
 * Durable, metadata-only request telemetry retention resolvers.
 */

import { CONFIG_SPEC, readInt } from "./spec";

/** Metadata-only telemetry retention window; payload frames have their own short TTL. */
export function resolveTelemetryRetentionDays(): number {
  return readInt(
    "CARTETHYIA_TELEMETRY_RETENTION_DAYS",
    CONFIG_SPEC.CARTETHYIA_TELEMETRY_RETENTION_DAYS,
  );
}

/**
 * Days of account/pool health events (status transitions) kept. Every
 * cooldown/recovery writes a row and nothing else removes them, so a busy
 * account accumulated tens of thousands; deleting it then cascaded all of
 * them in one blocking statement.
 */
export function resolveHealthEventRetentionDays(): number {
  return readInt(
    "CARTETHYIA_HEALTH_EVENT_RETENTION_DAYS",
    CONFIG_SPEC.CARTETHYIA_HEALTH_EVENT_RETENTION_DAYS,
  );
}

/** Combined redacted payload capture limit for the five stored body surfaces. */
export function resolveTelemetryPayloadMaxBytes(): number {
  return readInt(
    "CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES",
    CONFIG_SPEC.CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES,
  );
}


import { logger } from "@elizaos/core";

const PRIVATE_KEY_PATTERN = /suiprivkey1[a-z0-9]{20,}/gi;

let configuredKey: string | null = null;

export function setConfiguredKey(key: string | null): void {
  configuredKey = key;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (value !== null && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function redact(value: unknown): string {
  let str = stringify(value);
  str = str.replace(PRIVATE_KEY_PATTERN, "[REDACTED_KEY]");
  if (configuredKey) {
    str = str.replaceAll(configuredKey, "[REDACTED_KEY]");
  }
  return str;
}

/** Logs through the ElizaOS logger (so LOG_LEVEL applies), redacting every argument first. */
export function createLogger(prefix: string) {
  const line = (args: unknown[]) => `[${prefix}] ${args.map(redact).join(" ")}`;
  return {
    log: (...args: unknown[]) => logger.info(line(args)),
    warn: (...args: unknown[]) => logger.warn(line(args)),
    error: (...args: unknown[]) => logger.error(line(args)),
    debug: (...args: unknown[]) => logger.debug(line(args)),
  };
}

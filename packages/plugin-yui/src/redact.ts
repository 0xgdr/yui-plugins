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

export function createLogger(prefix: string) {
  return {
    log: (...args: unknown[]) => console.log(`[${prefix}]`, ...args.map(redact)),
    warn: (...args: unknown[]) => console.warn(`[${prefix}]`, ...args.map(redact)),
    error: (...args: unknown[]) => console.error(`[${prefix}]`, ...args.map(redact)),
    debug: (...args: unknown[]) => console.debug(`[${prefix}]`, ...args.map(redact)),
  };
}

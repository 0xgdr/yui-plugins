import type { IAgentRuntime } from "@elizaos/core";

export interface FakeClock {
  now: () => number;
  sleepMs: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
  sleeps: number[];
}

/** A clock that only moves when the code under test sleeps (or the test advances it). */
export function createFakeClock(start = 1_760_000_000_000): FakeClock {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleepMs: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

export type MockRuntime = IAgentRuntime & {
  /** Test-only: makes a constructed service visible to getService. */
  addService: (service: unknown) => void;
};

/** Mirrors the 1.7.2 surface the plugin uses: getSetting and a synchronous getService. */
export function createMockRuntime(
  settings: Record<string, string>,
  extra: Record<string, unknown> = {}
): MockRuntime {
  const services = new Map<string, unknown>();
  return {
    getSetting: (key: string) => settings[key] ?? null,
    getService: (name: string) => services.get(name) ?? null,
    addService: (service: unknown) => {
      services.set("yui", service);
    },
    ...extra,
  } as unknown as MockRuntime;
}

export interface ConsoleCapture {
  logs: string[];
  stop: () => void;
}

export function captureConsole(): ConsoleCapture {
  const logs: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => console[m]);
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      logs.push(
        args
          .map((a) => {
            if (typeof a === "string") return a;
            try {
              return JSON.stringify(a);
            } catch {
              return String(a);
            }
          })
          .join(" ")
      );
    };
  }
  return {
    logs,
    stop: () => methods.forEach((m, i) => (console[m] = originals[i])),
  };
}

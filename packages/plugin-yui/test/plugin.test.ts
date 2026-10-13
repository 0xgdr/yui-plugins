import { describe, test, expect } from "bun:test";
import type { Action, Provider } from "@elizaos/core";
import yuiPlugin from "../src/index";

describe("Plugin structure (Test 18)", () => {
  test("plugin has required shape and types", () => {
    expect(yuiPlugin).toBeDefined();
    expect(yuiPlugin.name).toBe("yui");
    expect(yuiPlugin.description).toBeDefined();
    expect(typeof yuiPlugin.description).toBe("string");

    expect(yuiPlugin.services).toBeDefined();
    expect(Array.isArray(yuiPlugin.services)).toBe(true);
    expect(yuiPlugin.services?.length).toBeGreaterThan(0);

    expect(yuiPlugin.actions).toBeDefined();
    expect(Array.isArray(yuiPlugin.actions)).toBe(true);
    expect(yuiPlugin.actions?.length).toBeGreaterThan(0);

    expect(yuiPlugin.providers).toBeDefined();
    expect(Array.isArray(yuiPlugin.providers)).toBe(true);
    expect(yuiPlugin.providers?.length).toBeGreaterThan(0);
  });

  test("all actions have required properties", () => {
    const actions = yuiPlugin.actions as Action[];

    for (const action of actions) {
      expect(action.name).toBeDefined();
      expect(typeof action.name).toBe("string");

      expect(action.description).toBeDefined();
      expect(typeof action.description).toBe("string");

      expect(action.validate).toBeDefined();
      expect(typeof action.validate).toBe("function");

      expect(action.handler).toBeDefined();
      expect(typeof action.handler).toBe("function");

      expect(action.examples).toBeDefined();
      expect(Array.isArray(action.examples)).toBe(true);
      expect(action.examples!.length).toBeGreaterThanOrEqual(2);
    }

    const actionNames = actions.map((a) => a.name);
    expect(actionNames).toContain("YUI_LIST_ROOMS");
    expect(actionNames).toContain("YUI_READ_ROOM");
    expect(actionNames).toContain("YUI_POST");
    expect(actionNames).toContain("YUI_POST_SIGNED");
    expect(actionNames).toContain("YUI_ASK_SUI");
    expect(actionNames).toContain("YUI_CHECK_COIN");
    expect(actionNames).toContain("YUI_SEARCH_DIRECTORY");
    expect(actionNames).toContain("YUI_FIND_SERVICE");
    expect(actionNames).toContain("YUI_INBOX");
  });

  test("all providers have required properties", () => {
    const providers = yuiPlugin.providers as Provider[];

    for (const provider of providers) {
      expect(provider.name).toBeDefined();
      expect(typeof provider.name).toBe("string");

      expect(provider.get).toBeDefined();
      expect(typeof provider.get).toBe("function");
    }

    const providerNames = providers.map((p) => p.name);
    expect(providerNames).toContain("YUI_ROOMS");
    expect(providerNames).toContain("YUI_INBOX");
  });
});

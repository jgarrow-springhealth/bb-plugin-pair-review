import { describe, expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { DEFAULT_PREFERENCES } from "../contract";

function createHarness() {
  const host = createFakePluginHost({
    pluginId: "pair-review",
    sdk: {
      system: {
        config: async () => ({ primaryHostId: "host-1" }),
      },
      projects: {
        list: async () => [],
      },
      plugins: {
        callRpc: async () => ({ changed: false }),
      },
    },
    experimental_callHostRpc: async () => ({}),
  });
  plugin(host.bb);
  return host.harness;
}

async function lastPreferences(harness: ReturnType<typeof createHarness>) {
  await harness.behavior.runCli(["status"]);
  return (
    harness.inspection.experimental_hostRpcCalls.at(-1)?.input as {
      preferences: unknown;
    }
  ).preferences;
}

describe("Pair Review settings", () => {
  test("registers documented defaults in BB's native settings UI", async () => {
    const harness = createHarness();
    const descriptors = harness.inspection.registrations.settingsDescriptors;

    expect(Object.keys(descriptors)).toEqual(Object.keys(DEFAULT_PREFERENCES));
    for (const [key, value] of Object.entries(DEFAULT_PREFERENCES)) {
      expect(descriptors[key]?.default).toBe(value);
      expect(descriptors[key]?.description).toBeTruthy();
    }

    await harness.lifecycle.dispose();
  });

  test.each([
    ["forkPath", "relative/pair-review"],
    ["hostname", "https://github.com"],
    ["reviewProvider", "other"],
    ["reviewModel", "bad model"],
    ["fixProvider", "copilot"],
    ["resolverMaxRounds", 6],
    ["preparationConcurrency", 0],
    ["teams", "missing-a-slash"],
    ["teammates", "not_a_github_handle"],
  ])("rejects invalid %s values at the settings boundary", async (key, value) => {
    const harness = createHarness();

    await expect(
      harness.behavior.setSettings({ [key]: value }),
    ).rejects.toThrow();

    await harness.lifecycle.dispose();
  });

  test("persists valid settings across reload and applies them to host work", async () => {
    const harness = createHarness();
    await harness.behavior.setSettings({
      forkPath: "pair-review",
      hostname: "github.example.com",
      reviewProvider: "claude",
      reviewModel: "opus",
      fixProvider: "codex",
      fixModel: "gpt-5.6-sol-high",
      resolverMaxRounds: 5,
      preparationConcurrency: 8,
    });

    expect(await lastPreferences(harness)).toMatchObject({
      forkPath: "pair-review",
      hostname: "github.example.com",
      reviewProvider: "claude",
      reviewModel: "opus",
      fixProvider: "codex",
      fixModel: "gpt-5.6-sol-high",
      resolverMaxRounds: 5,
      preparationConcurrency: 8,
    });

    await harness.lifecycle.reload(plugin);
    expect(await lastPreferences(harness)).toMatchObject({
      forkPath: "pair-review",
      hostname: "github.example.com",
      reviewProvider: "claude",
      reviewModel: "opus",
      fixProvider: "codex",
      fixModel: "gpt-5.6-sol-high",
      resolverMaxRounds: 5,
      preparationConcurrency: 8,
    });

    await harness.lifecycle.dispose();
  });

  test("resets every stored value to its documented default", async () => {
    const harness = createHarness();
    await harness.behavior.setSettings({
      hostname: "github.example.com",
      publish: true,
      resolverMaxRounds: 5,
    });

    await expect(harness.behavior.callRpc("resetSettings", null)).resolves.toEqual(
      DEFAULT_PREFERENCES,
    );
    expect(await lastPreferences(harness)).toEqual(DEFAULT_PREFERENCES);
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "changed",
      payload: {},
    });

    await harness.lifecycle.dispose();
  });
});

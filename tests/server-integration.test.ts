import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const url = "https://github.com/example/project/pull/12";
const row = {
  id: "batch/0",
  batchId: "batch",
  index: 0,
  key: "github.com/example/project#12",
  url,
  title: "Change behavior",
  subject: "example/project #12",
  author: "dev",
  head: "a".repeat(40),
  base: "b".repeat(40),
  branch: "feature",
  model: "openai/gpt-5",
  attempt: 1,
  reviewState: "findings",
  resolverState: "disabled",
  count: 1,
  attention: null,
  updatedAt: "2026-10-09T12:00:00Z",
  path: "/retained",
  owned: false,
  superseded: false,
  submitted: false,
  finalReview: false,
  dismissed: false,
  running: false,
  canRetry: false,
  canAttempt: false,
  canResolve: false,
  canValidate: false,
  publish: false,
  briefState: "missing",
  changes: null,
};
const hostDetails = {
  row,
  summary: "Summary",
  changes: null,
  findings: [],
  patches: [],
  briefing: {
    available: false,
    state: "unavailable",
    head: null,
    file: null,
    hostId: null,
    stale: false,
    error: null,
    updatedAt: null,
    threadId: null,
  },
  activity: [],
  feedback: { complete: false, error: null, comments: [] },
};

function harness(callPluginRpc: (request: any) => unknown | Promise<unknown>) {
  const host = createFakePluginHost({
    pluginId: "pair-review",
    sdk: {
      system: {
        config: async () => ({ primaryHostId: "host-1" }),
      },
      plugins: {
        callRpc: callPluginRpc,
      },
    },
    experimental_callHostRpc: async ({ input }) => {
      const request = input as { operation: string };
      if (request.operation === "start") return { batchId: "batch" };
      if (request.operation === "resolverStart")
        return { batchId: "resolver-batch", index: 0 };
      if (request.operation === "details") return hostDetails;
      throw Error(`Unexpected host operation: ${request.operation}`);
    },
  });
  plugin(host.bb);
  return host.harness;
}

test("Pair Review works alone and omits the optional briefing", async () => {
  const h = harness(async () => {
    throw Error("plugin not installed");
  });
  const result = (await h.callRpc("details", {
    batchId: "batch",
    index: 0,
  })) as typeof hostDetails;
  expect(result.briefing).toEqual({
    available: false,
    state: "unavailable",
    head: null,
    file: null,
    hostId: null,
    stale: false,
    error: null,
    updatedAt: null,
    threadId: null,
  });
  expect((result as any).stacks).toEqual({ available: false, stacks: [], launchPath: null });
  await h.lifecycle.dispose();
});

test("details show the Stack Control stacks running the PR when that plugin is installed", async () => {
  const stacks = {
    stacks: [
      {
        namespace: "ns-1",
        name: "pr-project-12",
        status: "ready",
        health: "4 of 4 required healthy",
        expiresAt: "2026-10-26T18:20:29.636Z",
        path: "/plugins/stack-control/stacks/ns-1",
        why: "runs #12",
      },
    ],
    launchPath: "/plugins/stack-control/stacks/~launch/x",
  };
  const callPluginRpc = vi.fn(async (request: any) => {
    if (request.pluginId === "stack-control") return stacks;
    throw Error("plugin not installed");
  });
  const h = harness(callPluginRpc);
  const result = (await h.callRpc("details", { batchId: "batch", index: 0 })) as any;
  expect(callPluginRpc).toHaveBeenCalledWith(
    expect.objectContaining({
      pluginId: "stack-control",
      method: "stacks_for",
      input: { repo: "example/project", number: 12, headRef: "feature" },
    }),
  );
  expect(result.stacks).toEqual({ available: true, ...stacks });
  await h.lifecycle.dispose();
});

test("manual resolver loop requests are forwarded only after confirmation", async () => {
  const h = harness(async () => {
    throw Error("plugin not installed");
  });
  await expect(
    h.callRpc("resolverStart", {
      url,
      confirmed: true,
      maxRounds: 3,
    }),
  ).resolves.toEqual({ batchId: "resolver-batch", index: 0 });
  const call = h.inspection.experimental_hostRpcCalls.find(
    (entry) => (entry.input as any).operation === "resolverStart",
  );
  expect(call?.input).toMatchObject({
    operation: "resolverStart",
    payload: { url, confirmed: true, maxRounds: 3 },
  });
  await h.lifecycle.dispose();
});

test("starting Pair Review requests a standalone briefing without waiting for it", async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const callPluginRpc = vi.fn((request: any) => {
    if (request.pluginId === "pr-briefings") return pending;
    return { changed: false };
  });
  const h = harness(callPluginRpc);
  await expect(h.callRpc("start", { urls: [url] })).resolves.toEqual({
    batchId: "batch",
  });
  expect(callPluginRpc).toHaveBeenCalledWith(
    expect.objectContaining({
      pluginId: "pr-briefings",
      method: "briefing_generate",
      input: { url },
    }),
  );
  release({
    available: true,
    state: "queued",
    head: null,
    file: null,
    hostId: null,
    stale: false,
    error: null,
    updatedAt: 1,
  });
  await h.lifecycle.dispose();
});

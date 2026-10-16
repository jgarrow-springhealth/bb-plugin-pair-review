// @vitest-environment jsdom
// A PR details page must not spend GitHub API quota just by staying open.
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const url = "https://github.com/example/project/pull/12";
const key = "github.com/example/project#12";
const pr = {
  key,
  url,
  title: "Quota-friendly change",
  subject: "example/project #12",
  author: "someone",
  head: "a".repeat(40),
  branch: "feature/quota",
  updatedAt: "2026-10-07T00:00:00Z",
  tags: ["Other direct request"],
  freshness: "not_reviewed",
  previousAt: null,
  previousModel: null,
  changes: { files: 1, additions: 3, deletions: 1 },
};
const briefing = {
  available: false,
  state: "unavailable",
  head: null,
  file: null,
  hostId: null,
  stale: false,
  error: null,
  updatedAt: null,
  threadId: null,
};
const feedback = { complete: true, error: null, comments: [] };
const row = (over: Record<string, unknown> = {}) => ({
  id: "batch/0",
  batchId: "batch",
  index: 0,
  key,
  title: pr.title,
  subject: pr.subject,
  url,
  author: pr.author,
  head: pr.head,
  base: "b".repeat(40),
  branch: pr.branch,
  model: "openai/gpt-5",
  updatedAt: "2026-10-07T00:00:00Z",
  attempt: 1,
  reviewState: "reviewing",
  resolverState: "disabled",
  count: 0,
  attention: null,
  resolverError: null,
  path: null,
  owned: false,
  superseded: false,
  dismissed: false,
  running: true,
  canRetry: false,
  canAttempt: false,
  canResolve: false,
  canValidate: false,
  publish: false,
  changes: pr.changes,
  submitted: false,
  finalReview: false,
  ...over,
});
const base = {
  queue: [pr],
  rows: [] as unknown[],
  warnings: [],
  updatedAt: "2026-10-07T00:00:00Z",
  queueRefreshedAt: "2026-10-07T00:00:00Z",
  health: {
    forkPath: "/fork",
    version: "5.3.4",
    nodeVersion: "v24.0.0",
    ready: true,
    error: null,
  },
  hostId: "host-fixture",
  preferences: {
    forkPath: "pair-review",
    hostname: "github.com",
    reviewModel: "openai/gpt-5",
    fixModel: "openai/gpt-5",
    reviewThinking: "medium",
    fixThinking: "medium",
    resolverMaxRounds: 3,
    publish: false,
    feedback: true,
    hideReviewed: true,
    preparationConcurrency: 4,
  },
};
const prDetails = (review: { batchId: string; index: number } | null) => ({
  pr,
  review,
  patches: [],
  patchError: null,
  feedback,
  canResolve: false,
  briefing,
});

let slot: ReturnType<typeof renderSlot>;
afterEach(() => slot?.lifecycle.unmount());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handlers = Record<string, (input?: any) => unknown>;
async function open(rpc: Handlers) {
  // Module state (the cached snapshot) must not leak between tests.
  vi.resetModules();
  const app = await loadPluginApp(() => import("../app"));
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "pr/github.com/example/project/12" },
    { rpc },
  );
}
const calls = (method: string) =>
  slot.inspection.rpcCalls.filter((call) => call.method === method);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an unreviewed PR page asks GitHub once, however long it stays open", async () => {
  await open({
    snapshot: () => base,
    refresh: () => base,
    prDetails: () => prDetails(null),
  });
  await slot.findByRole("heading", { name: pr.title });
  // Longer than the page's 3-second poll interval, so a poll must have run.
  await wait(3400);
  expect(calls("prDetails")).toHaveLength(1);
  expect(calls("refresh")).toHaveLength(0);
}, 10_000);

test("Refresh from GitHub on a PR page re-reads that PR", async () => {
  await open({
    snapshot: () => base,
    refresh: () => base,
    prDetails: () => prDetails(null),
  });
  await slot.findByRole("heading", { name: pr.title });
  fireEvent.click(slot.getByRole("button", { name: "Refresh from GitHub" }));
  await waitFor(() => expect(calls("prDetails")).toHaveLength(2));
  expect(calls("refresh")).toHaveLength(1);
});

test("a review starting for this PR re-reads it once, and then follows it locally", async () => {
  let rows: unknown[] = [];
  const target = { batchId: "batch", index: 0 };
  await open({
    snapshot: () => ({ ...base, rows }),
    refresh: () => ({ ...base, rows }),
    prDetails: () => prDetails(rows.length ? target : null),
    details: () => ({
      row: rows[0],
      summary: "Review in progress",
      changes: pr.changes,
      findings: [],
      patches: [],
      briefing,
      activity: [],
      feedback,
    }),
  });
  await slot.findByRole("heading", { name: pr.title });
  expect(calls("prDetails")).toHaveLength(1);

  rows = [row()];
  await slot.behavior.emitRealtime("changed", {});
  await waitFor(() => expect(calls("prDetails")).toHaveLength(2));
  await waitFor(() => expect(calls("details").length).toBeGreaterThan(0));

  // From here the page follows the run through local state only.
  const before = calls("prDetails").length;
  rows = [row({ running: false, reviewState: "findings", count: 2 })];
  await slot.behavior.emitRealtime("changed", {});
  await waitFor(() => expect(calls("prDetails")).toHaveLength(before + 1));
  await wait(3400);
  expect(calls("prDetails")).toHaveLength(before + 1);
}, 15_000);

test("a failed GitHub read stops polling and offers Retry", async () => {
  let fail = true;
  await open({
    snapshot: () => base,
    refresh: () => base,
    prDetails: () => {
      if (fail) throw Error("gh: API rate limit exceeded");
      return prDetails(null);
    },
  });
  expect(await slot.findByText(/API rate limit exceeded/)).toBeTruthy();
  await wait(3400);
  expect(calls("prDetails")).toHaveLength(1);
  // The error stays up instead of flipping back to "Loading…".
  expect(slot.getByText(/API rate limit exceeded/)).toBeTruthy();

  fail = false;
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  await slot.findByRole("heading", { name: pr.title });
  expect(calls("prDetails")).toHaveLength(2);
  expect(slot.queryByText(/API rate limit exceeded/)).toBeNull();
}, 10_000);

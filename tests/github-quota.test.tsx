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
      if (fail) throw Error("gh: Bad credentials (HTTP 401)");
      return prDetails(null);
    },
  });
  expect(await slot.findByText(/Bad credentials/)).toBeTruthy();
  await wait(3400);
  expect(calls("prDetails")).toHaveLength(1);
  // The error stays up instead of flipping back to "Loading…".
  expect(slot.getByText(/Bad credentials/)).toBeTruthy();

  fail = false;
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  await slot.findByRole("heading", { name: pr.title });
  expect(calls("prDetails")).toHaveLength(2);
  expect(slot.queryByText(/Bad credentials/)).toBeNull();
}, 10_000);

const inMinutes = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();
const limits = (coreRemaining: number) => ({
  core: { limit: 5000, remaining: coreRemaining, resetAt: inMinutes(9) },
  search: { limit: 30, remaining: 30, resetAt: inMinutes(1) },
  graphql: { limit: 5000, remaining: 4990, resetAt: inMinutes(40) },
});
async function openOverview(rpc: Handlers) {
  vi.resetModules();
  const app = await loadPluginApp(() => import("../app"));
  slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc });
}

test("a rate-limited refresh says when GitHub resets and holds Refresh until then", async () => {
  await openOverview({
    snapshot: () => base,
    refresh: () => {
      throw Error(
        "Error: gh exited 1: gh: API rate limit exceeded for user ID 165939280.",
      );
    },
    rateLimit: () => limits(0),
  });
  fireEvent.click(await slot.findByRole("tab", { name: /^PR Queue/ }));
  fireEvent.click(slot.getByRole("button", { name: "Refresh from GitHub" }));
  const notice = await slot.findByRole("alert", {
    name: undefined,
  });
  await waitFor(() =>
    expect(notice.textContent).toMatch(/It resets at .*\(in (9|10) minutes\)/),
  );
  expect(notice.textContent).toMatch(/GitHub's API rate limit is used up/);
  expect(notice.textContent).toMatch(
    /The queue below is from your last refresh/,
  );
  // The raw gh output, including the account's user ID, is not shown.
  expect(slot.queryByText(/165939280/)).toBeNull();
  const refresh = slot.getByRole("button", { name: /^Refresh after / });
  expect(refresh.hasAttribute("disabled")).toBe(true);
  expect(calls("rateLimit")).toHaveLength(1);
  expect(calls("refresh")).toHaveLength(1);
});

test("a short-term secondary limit asks to wait without blocking Refresh", async () => {
  let fail = true;
  await openOverview({
    snapshot: () => base,
    refresh: () => {
      if (fail) throw Error("gh: You have exceeded a secondary rate limit.");
      return base;
    },
    rateLimit: () => limits(4000),
  });
  fireEvent.click(await slot.findByRole("tab", { name: /^PR Queue/ }));
  fireEvent.click(slot.getByRole("button", { name: "Refresh from GitHub" }));
  expect(
    await slot.findByText("GitHub asked Pair Review to slow down"),
  ).toBeTruthy();
  const refresh = slot.getByRole("button", { name: "Refresh from GitHub" });
  await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(false));
  fail = false;
  fireEvent.click(refresh);
  await waitFor(() =>
    expect(
      slot.queryByText("GitHub asked Pair Review to slow down"),
    ).toBeNull(),
  );
});

test("a rate-limited PR page explains the wait instead of a raw error", async () => {
  await open({
    snapshot: () => base,
    refresh: () => base,
    prDetails: () => {
      throw Error("gh: API rate limit exceeded for user ID 165939280.");
    },
    rateLimit: () => limits(0),
  });
  expect(
    await slot.findByText("GitHub's API rate limit is used up"),
  ).toBeTruthy();
  await waitFor(() =>
    expect(
      slot.getByText(/This page loads once it can reach GitHub again/)
        .textContent,
    ).toMatch(/It resets at/),
  );
  expect(slot.queryByText(/165939280/)).toBeNull();
  expect(
    slot.getByRole("button", { name: "Retry" }).hasAttribute("disabled"),
  ).toBe(true);
});

test("Setup health shows the remaining GitHub budget when opened", async () => {
  await openOverview({
    snapshot: () => base,
    refresh: () => base,
    rateLimit: () => limits(4321),
  });
  fireEvent.click(await slot.findByRole("button", { name: /Setup health/ }));
  expect(
    await slot.findByText(/4,321 of 5,000 requests left · resets/),
  ).toBeTruthy();
  expect(slot.getByText(/30 of 30 searches left/)).toBeTruthy();
});

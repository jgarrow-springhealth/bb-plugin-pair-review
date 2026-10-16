// @vitest-environment jsdom
// Before spending time on findings, a reviewer must be able to tell whether
// they are about the pull request's current code.
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import "./picker";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const url = "https://github.com/example/project/pull/12";
const key = "github.com/example/project#12";
const reviewed = "a".repeat(40);
const newer = "b".repeat(40);
const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();
const queueItem = (head: string) => ({
  key,
  url,
  title: "Retry webhook deliveries",
  subject: "example/project #12",
  author: "someone",
  head,
  branch: "feature/retries",
  updatedAt: minutesAgo(90),
  tags: ["Team request"],
  freshness: head === reviewed ? "current" : "stale",
  previousAt: minutesAgo(90),
  previousModel: "openai/gpt-5",
  changes: { files: 2, additions: 40, deletions: 3 },
});
const row = {
  id: "batch/0",
  batchId: "batch",
  index: 0,
  key,
  title: "Retry webhook deliveries",
  subject: "example/project #12",
  url,
  author: "someone",
  head: reviewed,
  base: "c".repeat(40),
  branch: "feature/retries",
  model: "openai/gpt-5",
  updatedAt: minutesAgo(90),
  attempt: 1,
  reviewState: "findings",
  resolverState: "disabled",
  count: 2,
  attention: null,
  resolverError: null,
  path: null,
  owned: false,
  superseded: false,
  dismissed: false,
  running: false,
  canRetry: false,
  canAttempt: false,
  canResolve: false,
  canValidate: false,
  publish: false,
  changes: { files: 2, additions: 40, deletions: 3 },
  submitted: false,
  finalReview: false,
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
const details = (r = row) => ({
  row: r,
  summary: "2 findings in the exact reviewed changes.",
  changes: r.changes,
  findings: [
    {
      id: 1,
      file: "src/retry.ts",
      title: "Retries never back off",
      body: "Every retry fires immediately.",
      line: 14,
      sourcePath: null,
      kind: "bug",
      severity: "medium",
      suggestion: null,
      disposition: null,
      reason: null,
    },
  ],
  patches: [],
  briefing,
  activity: [],
  feedback: { complete: true, error: null, comments: [] },
});
const snapshot = (queueHead: string, refreshedMinutesAgo: number) => ({
  queue: [queueItem(queueHead)],
  rows: [row],
  warnings: [],
  updatedAt: minutesAgo(0),
  queueRefreshedAt: minutesAgo(refreshedMinutesAgo),
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
});
const status = (head: string, state = "open") => ({
  head,
  state,
  checkedAt: new Date().toISOString(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handlers = Record<string, (input?: any) => unknown>;
let slot: ReturnType<typeof renderSlot>;
afterEach(() => slot?.lifecycle.unmount());
async function openReview(rpc: Handlers) {
  vi.resetModules();
  const app = await loadPluginApp(() => import("../app"));
  slot = renderSlot(app.navPanels[0], { subPath: "batch/0" }, { rpc });
  await slot.findByRole("heading", { name: row.title, level: 1 });
}
const calls = (method: string) =>
  slot.inspection.rpcCalls.filter((call) => call.method === method);
/** The text of the Freshness metric: its value and note. */
const freshnessMetric = () =>
  slot.getByText("Freshness", { selector: "span" }).parentElement!
    .textContent ?? "";

test("a saved queue that says current is overruled by a live check that finds new commits", async () => {
  await openReview({
    // The saved queue is an hour old and still lists the reviewed commit.
    snapshot: () => snapshot(reviewed, 60),
    refresh: () => snapshot(reviewed, 60),
    details: () => details(),
    prStatus: () => status(newer),
  });
  // A short pill in the header, and again beside the Findings heading.
  const pills = await slot.findAllByLabelText(/^Outdated: /);
  expect(pills).toHaveLength(2);
  expect(pills[0]!.getAttribute("aria-label")).toBe(
    "Outdated: Reviewed aaaaaaaaaa · GitHub head is now bbbbbbbbbb · checked just now",
  );
  expect(
    within(
      slot.getByRole("heading", { name: "Findings" }).parentElement!,
    ).getByText("Outdated"),
  ).toBeTruthy();
  // The detail lives in a tooltip, not in a paragraph on the page.
  fireEvent.pointerMove(pills[0]!, { pointerType: "mouse" });
  expect(
    (await screen.findByRole("tooltip", {}, { timeout: 2000 })).textContent,
  ).toBe(
    "Reviewed aaaaaaaaaa · GitHub head is now bbbbbbbbbb · checked just now",
  );
  expect(slot.queryByText(/These findings are for/)).toBeNull();
  expect(slot.queryByText(/New commits may already/)).toBeNull();
  expect(freshnessMetric()).toMatch(
    /New commits.*GitHub head is now bbbbbbbbbb · checked just now/,
  );
  expect(calls("prStatus")).toEqual([
    expect.objectContaining({ input: { url } }),
  ]);
});

test("findings on the current head say so, with when it was checked", async () => {
  await openReview({
    snapshot: () => snapshot(reviewed, 60),
    refresh: () => snapshot(reviewed, 60),
    details: () => details(),
    prStatus: () => status(reviewed),
  });
  await waitFor(() =>
    expect(freshnessMetric()).toMatch(
      /Current.*Head unchanged · checked just now/,
    ),
  );
  expect(slot.queryByText("Outdated")).toBeNull();
  expect(slot.queryByText("Not confirmed")).toBeNull();
});

test("the live check runs once per page, not on every poll, and again on Refresh", async () => {
  await openReview({
    snapshot: () => snapshot(reviewed, 5),
    refresh: () => snapshot(reviewed, 0),
    details: () => details(),
    prStatus: () => status(reviewed),
  });
  await waitFor(() => expect(calls("prStatus")).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 3400));
  expect(calls("prStatus")).toHaveLength(1);
  fireEvent.click(slot.getByRole("button", { name: "Refresh from GitHub" }));
  await waitFor(() => expect(calls("prStatus")).toHaveLength(2));
}, 10_000);

test("when GitHub can't be reached, the page says it can't confirm instead of claiming Current", async () => {
  await openReview({
    snapshot: () => snapshot(reviewed, 120),
    refresh: () => snapshot(reviewed, 120),
    details: () => details(),
    prStatus: () => {
      throw Error("gh: Bad credentials (HTTP 401)");
    },
  });
  const pills = await slot.findAllByLabelText(/^Not confirmed: /);
  expect(pills[0]!.getAttribute("aria-label")).toBe(
    "Not confirmed: Unchanged as of 2 hours ago · couldn't reach GitHub",
  );
  expect(freshnessMetric()).toMatch(
    /Not confirmed.*Unchanged as of 2 hours ago · couldn't reach GitHub/,
  );
  expect(slot.queryByText("Current")).toBeNull();
  expect(slot.queryByText("Outdated")).toBeNull();
});

test("a merged pull request is labeled merged", async () => {
  await openReview({
    snapshot: () => ({ ...snapshot(reviewed, 60), queue: [] }),
    refresh: () => ({ ...snapshot(reviewed, 60), queue: [] }),
    details: () => details(),
    prStatus: () => status(reviewed, "merged"),
  });
  await waitFor(() =>
    expect(freshnessMetric()).toMatch(
      /Merged.*No commits after this review · checked just now/,
    ),
  );
  expect(slot.queryByText("Outdated")).toBeNull();
});

test("a PR page uses its own live read and makes no extra freshness call", async () => {
  vi.resetModules();
  const app = await loadPluginApp(() => import("../app"));
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "pr/github.com/example/project/12" },
    {
      rpc: {
        snapshot: () => snapshot(reviewed, 60),
        refresh: () => snapshot(reviewed, 60),
        prDetails: () => ({
          pr: queueItem(newer),
          review: { batchId: "batch", index: 0 },
          patches: [],
          patchError: null,
          feedback: { complete: true, error: null, comments: [] },
          canResolve: false,
          briefing,
        }),
        details: () => details(),
        prStatus: () => status(newer),
      },
    },
  );
  expect(await slot.findAllByLabelText(/^Outdated: /)).toHaveLength(2);
  expect(calls("prStatus")).toHaveLength(0);
  expect(calls("prDetails")).toHaveLength(1);
});

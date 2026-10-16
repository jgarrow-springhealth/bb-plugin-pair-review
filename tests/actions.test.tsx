// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { choose, shown } from "./picker";
// Reproduce the live host's fresh RPC object identity on each hook render.
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return { ...actual, useRpc: () => ({ ...actual.useRpc() }) };
});
const pr = {
  key: "github.com/example/project#12",
  url: "https://github.com/example/project/pull/12",
  title: "Inspectable PR",
  subject: "example/project #12",
  author: "someone",
  head: "a".repeat(40),
  branch: "feature/inspectable",
  updatedAt: "2026-10-07T00:00:00Z",
  tags: ["Direct request"],
  freshness: "not_reviewed",
  previousAt: null,
  previousModel: null,
  changes: { files: 3, additions: 21, deletions: 8 },
};
const unavailableBriefing = {
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
const missingBriefing = {
  available: true,
  state: "missing",
  head: null,
  file: null,
  hostId: null,
  stale: false,
  error: null,
  updatedAt: null,
  threadId: null,
};
const readyBriefing = {
  available: true,
  state: "ready",
  head: pr.head,
  file: "/retained/pr-briefing.html",
  hostId: "briefing-host",
  stale: false,
  error: null,
  updatedAt: 1,
  threadId: "briefing-thread",
};
const currentPatches = [
  {
    path: "src/inspectable.ts",
    patch:
      "diff --git a/src/inspectable.ts b/src/inspectable.ts\n--- a/src/inspectable.ts\n+++ b/src/inspectable.ts\n@@ -1 +1 @@\n-old\n+new\n",
  },
];
const snapshot = {
  rows: [],
  queue: [pr],
  warnings: [],
  updatedAt: "2026-10-07T00:00:00Z",
  health: {
    forkPath: "/example/pair-review",
    version: "5.2.3",
    nodeVersion: "v26.5.0",
    ready: true,
    error: null,
    provider: "pi",
    reviewModel: "openai/gpt-5.6-sol",
    fixModel: "openai/gpt-5.6-sol",
    teams: ["exampleorg/platform"],
    teammates: ["alice"],
    port: 7247,
    database: "shared",
  },
  hostId: "host-fixture",
  preferences: {
    forkPath: "~/Dev/pair-review",
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
let slot: ReturnType<typeof renderSlot> | undefined;
afterEach(() => {
  slot?.lifecycle.unmount();
  slot = undefined;
  vi.restoreAllMocks();
});
/** Overview and detail lists sit behind tabs; select one by its label. */
async function openTab(name: string) {
  const tab = await slot!.findByRole("tab", { name: new RegExp(`^${name}`) });
  fireEvent.click(tab);
  return tab;
}
test("every queue card has Details that navigates without starting a review", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const start = vi.fn();
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    { rpc: { snapshot: () => snapshot, refresh: () => snapshot, start } },
  );
  await openTab("PR Queue");
  const title = await slot.findByRole("heading", { name: pr.title });
  expect(
    within(title.closest("article")!).getByLabelText(
      "3 changed files, 21 additions, 8 deletions",
    ),
  ).toBeTruthy();
  fireEvent.click(
    within(title.closest("article")!).getByRole("button", { name: "Details" }),
  );
  expect(start).not.toHaveBeenCalled();
  expect(slot.inspection.rpcCalls.some((c) => c.method === "start")).toBe(
    false,
  );
  expect(slot.inspection.navigateCalls).toContainEqual(
    expect.objectContaining({
      method: "toPluginPanel",
      options: { subPath: "pr/github.com/example/project/12" },
    }),
  );
});
test("Review latest changes starts the engine without navigating away from the queue", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const start = vi.fn(() => ({ batchId: "new-batch" }));
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    { rpc: { snapshot: () => snapshot, refresh: () => snapshot, start } },
  );
  await openTab("PR Queue");
  const title = await slot.findByRole("heading", { name: pr.title });
  fireEvent.click(
    within(title.closest("article")!).getByRole("button", {
      name: "Review latest changes",
    }),
  );
  await waitFor(() => expect(start).toHaveBeenCalledWith({ urls: [pr.url] }));
  expect(slot.inspection.navigateCalls).toHaveLength(0);
});
test("needs-attention runs can be dismissed without deleting evidence", async () => {
  const action = vi.fn(() => ({ accepted: true as const }));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const row = {
    id: "failed-batch/0",
    batchId: "failed-batch",
    index: 0,
    key: pr.key,
    title: pr.title,
    subject: pr.subject,
    url: pr.url,
    author: pr.author,
    head: pr.head,
    base: "b".repeat(40),
    branch: pr.branch,
    model: "openai/gpt-5.6-sol",
    updatedAt: snapshot.updatedAt,
    attempt: 1,
    reviewState: "needs_attention",
    resolverState: "disabled",
    count: 0,
    attention: "Old provider failure",
    path: null,
    owned: false,
    superseded: false,
    dismissed: false,
    running: false,
    canRetry: false,
    canAttempt: true,
    canValidate: false,
    publish: false,
    briefState: "missing",
  };
  const page = {
    ...snapshot,
    rows: [row],
    queue: [],
  };
  slot = renderSlot(
    (await loadPluginApp(() => import("../app"))).navPanels[0],
    { subPath: "" },
    {
      rpc: {
        snapshot: () => page,
        refresh: () => page,
        action,
      },
    },
  );

  await openTab("Needs attention");
  const card = (await slot.findByText("Review couldn’t finish")).closest(
    "article",
  )!;
  fireEvent.click(within(card).getByRole("button", { name: "Dismiss run" }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith({
      batchId: "failed-batch",
      index: 0,
      action: "dismiss",
      confirmed: true,
    }),
  );
  expect(confirm).toHaveBeenCalledWith(
    expect.stringContaining("not be deleted"),
  );
  confirm.mockRestore();
});

test("dismissed runs stay out of needs-attention and can be restored separately", async () => {
  const action = vi.fn(() => ({ accepted: true as const }));
  const dismissedRow = {
    id: "old-batch/0",
    batchId: "old-batch",
    index: 0,
    key: pr.key,
    title: pr.title,
    subject: pr.subject,
    url: pr.url,
    author: pr.author,
    head: pr.head,
    base: "b".repeat(40),
    branch: pr.branch,
    model: "openai/gpt-5.6-sol",
    updatedAt: snapshot.updatedAt,
    attempt: 1,
    reviewState: "needs_attention",
    resolverState: "disabled",
    count: 0,
    attention: "Old provider failure",
    path: null,
    owned: false,
    superseded: false,
    dismissed: true,
    running: false,
    canRetry: false,
    canAttempt: true,
    canValidate: false,
    publish: false,
    briefState: "missing",
  };
  const page = {
    ...snapshot,
    rows: [dismissedRow],
    queue: [],
  };
  slot = renderSlot(
    (await loadPluginApp(() => import("../app"))).navPanels[0],
    { subPath: "" },
    {
      rpc: {
        snapshot: () => page,
        refresh: () => page,
        action,
      },
    },
  );

  const attention = await openTab("Needs attention");
  expect(within(attention).getByText("0")).toBeTruthy();
  expect(slot.getByText("Nothing needs attention.")).toBeTruthy();
  expect(slot.queryByRole("heading", { name: pr.title })).toBeNull();

  await openTab("Dismissed");
  await slot.findByRole("heading", { name: "Dismissed runs" });
  const title = await slot.findByRole("heading", { name: pr.title });
  const card = title.closest("article")!;
  expect(within(card).getByText("Dismissed")).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: "Restore" }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith({
      batchId: "old-batch",
      index: 0,
      action: "restore",
      confirmed: false,
    }),
  );
});

test("retained reviews are labeled Outdated when GitHub has a newer head", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const row = {
    id: "stale-batch/0",
    batchId: "stale-batch",
    index: 0,
    key: pr.key,
    title: "Review of an earlier head",
    subject: pr.subject,
    url: pr.url,
    author: pr.author,
    head: "b".repeat(40),
    base: "d".repeat(40),
    branch: pr.branch,
    model: "openai/gpt-5.6-sol",
    updatedAt: snapshot.updatedAt,
    attempt: 1,
    reviewState: "findings",
    resolverState: "disabled",
    count: 2,
    attention: null,
    path: null,
    owned: false,
    superseded: false,
    dismissed: false,
    running: false,
    canRetry: false,
    canAttempt: false,
    canValidate: false,
    publish: false,
    briefState: "ready",
    changes: pr.changes,
    submitted: false,
  };
  const page = {
    ...snapshot,
    rows: [row],
    queue: [{ ...pr, freshness: "stale" as const }],
  };
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    { rpc: { snapshot: () => page, refresh: () => page } },
  );
  await openTab("Recent reviews");
  const title = await slot.findByRole("heading", {
    name: "Review of an earlier head",
  });
  const card = title.closest("article")!;
  expect(within(card).getByText("Outdated")).toBeTruthy();
  expect(within(card).getByLabelText("2 findings")).toBeTruthy();
});

test("submitted GitHub reviews are omitted from Recent reviews", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const row = {
    id: "submitted-batch/0",
    batchId: "submitted-batch",
    index: 0,
    key: pr.key,
    title: "Already submitted review",
    subject: pr.subject,
    url: pr.url,
    author: pr.author,
    head: pr.head,
    base: "b".repeat(40),
    branch: pr.branch,
    model: "openai/gpt-5.6-sol",
    updatedAt: snapshot.updatedAt,
    attempt: 1,
    reviewState: "findings",
    resolverState: "disabled",
    count: 2,
    attention: null,
    path: null,
    owned: false,
    superseded: false,
    dismissed: false,
    running: false,
    canRetry: false,
    canAttempt: false,
    canValidate: false,
    publish: false,
    briefState: "ready",
    changes: pr.changes,
    submitted: true,
  };
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    {
      rpc: {
        snapshot: () => ({ ...snapshot, rows: [row], queue: [] }),
        refresh: () => ({ ...snapshot, rows: [row], queue: [] }),
      },
    },
  );
  await openTab("Recent reviews");
  await slot.findByRole("heading", { name: "Recent reviews" });
  expect(
    slot.queryByRole("heading", { name: "Already submitted review" }),
  ).toBeNull();
  expect(slot.getByText("No retained reviews yet.")).toBeTruthy();
});

test("an unreviewed PR shows code and opens Pair Review without starting analysis", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const start = vi.fn();
  const openFork = vi.fn(() => ({
    url: "http://localhost:7247/pr/example/project/12",
  }));
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "pr/github.com/example/project/12" },
    {
      rpc: {
        snapshot: () => snapshot,
        refresh: () => snapshot,
        prDetails: () => ({
          pr,
          review: null,
          patches: currentPatches,
          patchError: null,
          briefing: missingBriefing,
        }),
        start,
        openFork,
      },
      openUrl: () => true,
    },
  );
  const main = await slot.findByRole("main");
  await waitFor(() =>
    expect(within(main).getByRole("heading", { name: pr.title })).toBeTruthy(),
  );
  expect(
    within(main).getByText(/Opening Details does not start a review/),
  ).toBeTruthy();
  expect(
    within(main).getByLabelText("3 changed files, 21 additions, 8 deletions"),
  ).toBeTruthy();
  expect(start).not.toHaveBeenCalled();
  const briefingHeading = within(main).getByRole("heading", {
    name: "PR briefing",
  });
  const summaryHeading = within(main).getByRole("heading", {
    name: "Review summary",
  });
  const changesHeading = within(main).getByRole("heading", {
    name: "Code changes",
  });
  expect(
    briefingHeading.compareDocumentPosition(summaryHeading) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    summaryHeading.compareDocumentPosition(changesHeading) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(main.querySelector(".pr-diff")).toBeTruthy();
  expect(
    main.querySelector('[data-file-path="src/inspectable.ts"]'),
  ).toBeTruthy();
  expect(
    slot.inspection.rpcCalls.find((c) => c.method === "prDetails")?.input,
  ).toEqual({ url: pr.url });
  expect(
    slot.inspection.rpcCalls.some((c) =>
      ["start", "action", "openFork"].includes(c.method),
    ),
  ).toBe(false);
  fireEvent.click(
    within(main).getByRole("button", { name: "Open Pair Review" }),
  );
  await waitFor(() => expect(openFork).toHaveBeenCalledWith({ url: pr.url }));
  expect(start).not.toHaveBeenCalled();
});
test("the details page uses the shared spinner instead of a Running badge", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const selection = { batchId: "running-batch", index: 0 };
  const row = {
    id: "running-batch/0",
    ...selection,
    key: pr.key,
    title: pr.title,
    subject: pr.subject,
    url: pr.url,
    author: pr.author,
    head: pr.head,
    base: "b".repeat(40),
    branch: pr.branch,
    model: "openai/gpt-5.6-sol",
    updatedAt: snapshot.updatedAt,
    attempt: 1,
    reviewState: "reviewing",
    resolverState: "disabled",
    count: 0,
    attention: null,
    path: "/retained/work",
    owned: false,
    superseded: false,
    running: true,
    canRetry: false,
    canAttempt: false,
    canValidate: false,
    publish: false,
    briefState: "missing",
  };
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "running-batch/0" },
    {
      rpc: {
        snapshot: () => snapshot,
        refresh: () => snapshot,
        details: () => ({
          row,
          summary: "Review in progress",
          findings: [],
          patches: [],
          briefing: unavailableBriefing,
          activity: [],
          feedback: { complete: false, error: null, comments: [] },
        }),
      },
    },
  );

  const indicator = await slot.findByLabelText("Review in progress");
  const header = indicator.closest("header")!;
  expect(header).toBeTruthy();
  expect(within(header).queryByText("Running")).toBeNull();
  expect(header.querySelector(".pr-spinner")).toBeTruthy();
  expect(slot.queryByRole("heading", { name: "PR briefing" })).toBeNull();
  expect(
    within(header).getByRole("button", { name: "Open Pair Review" }),
  ).toBeTruthy();
  expect(
    slot.queryByRole("heading", { name: "Start a Pair Review" }),
  ).toBeNull();
});

test("starting from details immediately follows the new live review without navigation", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const previous = { batchId: "failed-batch", index: 0 };
  const next = { batchId: "new-live-batch", index: 0 };
  const baseRow = {
    key: pr.key,
    title: pr.title,
    subject: pr.subject,
    url: pr.url,
    author: pr.author,
    head: pr.head,
    base: "b".repeat(40),
    branch: pr.branch,
    model: "openai/gpt-5.6-sol",
    updatedAt: snapshot.updatedAt,
    attempt: 1,
    resolverState: "disabled",
    count: 0,
    path: null,
    owned: false,
    superseded: false,
    canRetry: false,
    canAttempt: false,
    canValidate: false,
    publish: false,
    briefState: "missing",
  };
  const response = (selection: typeof previous) => {
    const running = selection.batchId === next.batchId;
    return {
      row: {
        id: `${selection.batchId}/0`,
        ...selection,
        ...baseRow,
        reviewState: running ? "reviewing" : "needs_attention",
        attention: running ? null : "Previous review failed",
        running,
      },
      summary: running ? "Live review accepted" : "Previous review failed",
      findings: [],
      patches: [],
      briefing: missingBriefing,
      activity: [],
      feedback: { complete: false, error: null, comments: [] },
    };
  };
  let acceptStart!: (value: { batchId: string }) => void;
  const start = vi.fn(
    () =>
      new Promise<{ batchId: string }>((resolve) => {
        acceptStart = resolve;
      }),
  );
  const details = vi.fn((selection: unknown) =>
    response(selection as typeof previous),
  );
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "failed-batch/0" },
    {
      rpc: {
        snapshot: () => snapshot,
        refresh: () => snapshot,
        start,
        details,
      },
    },
  );

  const detail = (
    await slot.findByRole("heading", {
      name: "Review could not finish",
    })
  ).closest("main")!;
  fireEvent.click(
    within(detail).getByRole("button", { name: "Start fresh review" }),
  );
  expect(await slot.findByLabelText("Review in progress")).toBeTruthy();

  acceptStart({ batchId: next.batchId });
  await waitFor(() => expect(details).toHaveBeenCalledWith(next));
  expect(await slot.findByText("Live review accepted")).toBeTruthy();
  expect(slot.getByLabelText("Review in progress")).toBeTruthy();
  expect(slot.getByRole("button", { name: "Stop review" })).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Cancel batch" })).toBeNull();
  expect(slot.inspection.navigateCalls).toHaveLength(0);
});

test("human feedback can manually start the resolver loop without an analysis", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const resolverStart = vi.fn(() => ({ batchId: "feedback-loop", index: 0 }));
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "pr/github.com/example/project/12" },
    {
      rpc: {
        snapshot: () => snapshot,
        refresh: () => snapshot,
        prDetails: () => ({
          pr,
          review: null,
          patches: currentPatches,
          patchError: null,
          briefing: unavailableBriefing,
          canResolve: true,
          feedback: {
            complete: true,
            error: null,
            comments: [
              {
                author: "reviewer",
                body: "This condition can discard the final item.",
                location: "src/inspectable.ts:42",
                disposition: null,
                reason: null,
              },
            ],
          },
        }),
        resolverStart,
      },
    },
  );

  const main = await slot.findByRole("main");
  const buttons = within(main).getAllByRole("button", {
    name: "Start resolver loop",
  });
  fireEvent.click(buttons[0]);
  const dialog = await slot.findByRole("dialog");
  expect(within(dialog).getByText(/Up to 3 rounds/)).toBeTruthy();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Start resolver loop" }),
  );
  await waitFor(() =>
    expect(resolverStart).toHaveBeenCalledWith({
      url: pr.url,
      confirmed: true,
    }),
  );
  expect(slot.inspection.navigateCalls).toContainEqual(
    expect.objectContaining({
      method: "toPluginPanel",
      options: { subPath: "feedback-loop/0" },
    }),
  );
});

test("a manual resolver loop can override its maximum rounds", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const resolverStart = vi.fn(() => ({ batchId: "custom-loop", index: 0 }));
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "pr/github.com/example/project/12" },
    {
      rpc: {
        snapshot: () => snapshot,
        refresh: () => snapshot,
        prDetails: () => ({
          pr,
          review: null,
          patches: currentPatches,
          patchError: null,
          briefing: unavailableBriefing,
          canResolve: true,
          feedback: {
            complete: true,
            error: null,
            comments: [
              {
                author: "reviewer",
                body: "Please verify this branch.",
                location: "Review summary",
                disposition: null,
                reason: null,
              },
            ],
          },
        }),
        resolverStart,
      },
    },
  );

  const main = await slot.findByRole("main");
  fireEvent.click(
    within(main).getAllByRole("button", { name: "Start resolver loop" })[0],
  );
  const dialog = await slot.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("radio", { name: /Override for this run/ }),
  );
  expect(within(dialog).getByText(/1 to 5 rounds/)).toBeTruthy();
  const rounds = within(dialog).getByLabelText("Maximum resolver rounds");
  const start = within(dialog).getByRole("button", {
    name: "Start resolver loop",
  });
  fireEvent.change(rounds, { target: { value: "6" } });
  expect((start as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(rounds, { target: { value: "5" } });
  fireEvent.click(start);
  await waitFor(() =>
    expect(resolverStart).toHaveBeenCalledWith({
      url: pr.url,
      confirmed: true,
      maxRounds: 5,
    }),
  );
});

test("the details page retains the complete review error", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const selection = { batchId: "failed-batch", index: 0 };
  const error =
    "Analysis failed: No API key found for openai. Work preserved at /retained/work.";
  const row = {
    id: "failed-batch/0",
    ...selection,
    key: pr.key,
    title: pr.title,
    subject: pr.subject,
    url: pr.url,
    author: pr.author,
    head: pr.head,
    base: "b".repeat(40),
    branch: "feature/inspectable",
    model: "openai/gpt-5",
    updatedAt: snapshot.updatedAt,
    attempt: 1,
    reviewState: "needs_attention",
    resolverState: "pending",
    count: 0,
    attention: error,
    path: "/retained/work",
    owned: false,
    superseded: false,
    running: false,
    canRetry: false,
    canAttempt: true,
    canValidate: false,
    publish: false,
    briefState: "missing",
  };
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "pr/github.com/example/project/12" },
    {
      rpc: {
        snapshot: () => snapshot,
        refresh: () => snapshot,
        prDetails: () => ({
          pr,
          review: selection,
          patches: currentPatches,
          patchError: null,
        }),
        details: () => ({
          row,
          summary: "Analysis has not produced a verified result yet.",
          findings: [],
          patches: [],
          briefing: missingBriefing,
          activity: [],
          feedback: { complete: false, error: null, comments: [] },
        }),
      },
    },
  );
  expect(await slot.findByText(error)).toBeTruthy();
  expect(
    slot.getByRole("heading", { name: "Review could not finish" }),
  ).toBeTruthy();
});
test("a resolver failure does not relabel a completed review as failed", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const selection = { batchId: "resolver-failed-batch", index: 0 };
  const resolverError = "A disposition is required for every finding";
  const row = {
    id: "resolver-failed-batch/0",
    ...selection,
    key: pr.key,
    title: pr.title,
    subject: pr.subject,
    url: pr.url,
    author: pr.author,
    head: pr.head,
    base: "b".repeat(40),
    branch: "feature/inspectable",
    model: "openai/gpt-5",
    updatedAt: snapshot.updatedAt,
    attempt: 1,
    reviewState: "findings",
    resolverState: "failed",
    count: 3,
    attention: null,
    resolverError,
    path: "/retained/resolver-checkout",
    owned: true,
    superseded: false,
    running: false,
    canRetry: true,
    canAttempt: false,
    canValidate: false,
    publish: false,
    briefState: "ready",
  };
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "pr/github.com/example/project/12" },
    {
      rpc: {
        snapshot: () => snapshot,
        refresh: () => snapshot,
        prDetails: () => ({
          pr,
          review: selection,
          patches: currentPatches,
          patchError: null,
        }),
        details: () => ({
          row,
          summary: "Verified review summary",
          findings: [],
          patches: [],
          briefing: readyBriefing,
          activity: [],
          feedback: { complete: true, error: null, comments: [] },
        }),
      },
    },
  );
  expect(
    await slot.findByRole("heading", {
      name: "Review completed; resolver run failed",
    }),
  ).toBeTruthy();
  expect(slot.getByText(resolverError)).toBeTruthy();
  expect(slot.getByLabelText("3 findings")).toBeTruthy();
  expect(
    slot.queryByRole("heading", { name: "Needs human attention" }),
  ).toBeNull();
  expect(slot.queryByText(/Work preserved at/)).toBeNull();
  expect(
    slot.getByRole("button", { name: "Retry optional resolution" }),
  ).toBeTruthy();
  await openTab("Feedback");
  expect(
    slot.getByText("No unresolved human feedback was found."),
  ).toBeTruthy();
});
test("a PR detail route reuses existing saved review details, without analysis", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const selection = { batchId: "saved-batch", index: 0 };
  const refresh = vi.fn(() => snapshot);
  const row = {
    id: "saved-batch/0",
    ...selection,
    key: pr.key,
    title: pr.title,
    subject: pr.subject,
    url: pr.url,
    author: pr.author,
    head: "c".repeat(40),
    base: "b".repeat(40),
    branch: "feature",
    model: "openai/gpt-5",
    updatedAt: snapshot.updatedAt,
    attempt: 1,
    reviewState: "findings",
    resolverState: "disabled",
    count: 1,
    attention: null,
    path: null,
    owned: false,
    superseded: false,
    running: false,
    canRetry: false,
    canAttempt: false,
    canValidate: false,
    publish: false,
    briefState: "ready",
  };
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "pr/github.com/example/project/12" },
    {
      openFilePreview: () => true,
      rpc: {
        snapshot: () => snapshot,
        refresh,
        prDetails: () => ({
          pr,
          review: selection,
          patches: currentPatches,
          patchError: null,
        }),
        details: () => ({
          row,
          summary: "Previously saved verified summary",
          findings: [
            {
              id: 1,
              file: "src/features/reviews/very-specific-review-file.ts",
              title: "Keep the review state current",
              body: "The current state can become stale.",
              line: 42,
              sourcePath: null,
              kind: "bug",
              severity: "medium",
              suggestion: "Refresh the state before deciding.",
              disposition: null,
              reason: null,
            },
          ],
          patches: [
            {
              path: "src/one.ts",
              patch:
                "diff --git a/src/one.ts b/src/one.ts\n--- a/src/one.ts\n+++ b/src/one.ts\n@@ -1 +1 @@\n-old\n+new\n",
            },
            {
              path: "src/two.ts",
              patch:
                "diff --git a/src/two.ts b/src/two.ts\n--- a/src/two.ts\n+++ b/src/two.ts\n@@ -1 +1 @@\n-before\n+after\n",
            },
          ],
          briefing: readyBriefing,
          activity: [],
          feedback: { complete: false, error: "Not captured", comments: [] },
        }),
      },
    },
  );
  await slot.findByText("Previously saved verified summary");
  // A retained review opens on its findings; the diff is one tab away.
  expect((await openTab("Findings")).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(
    slot.getByText("src/features/reviews/very-specific-review-file.ts"),
  ).toBeTruthy();
  expect(slot.getByText(":42")).toBeTruthy();
  fireEvent.click(
    slot.getByRole("button", { name: /Keep the review state current/ }),
  );
  expect(slot.getByRole("heading", { name: "Comment" })).toBeTruthy();
  expect(slot.getByRole("heading", { name: "Suggestion" })).toBeTruthy();
  expect(slot.getByText("Refresh the state before deciding.")).toBeTruthy();
  await openTab("Changes");
  expect(shown("Changed file")).toBe("src/one.ts");
  const briefingHeading = slot.getByRole("heading", { name: "PR briefing" });
  const summaryHeading = slot.getByRole("heading", {
    name: "Review summary",
  });
  const changesHeading = slot.getByRole("heading", { name: "Code changes" });
  expect(
    briefingHeading.compareDocumentPosition(summaryHeading) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    summaryHeading.compareDocumentPosition(changesHeading) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const codeChanges = changesHeading.closest("section");
  expect(codeChanges?.querySelector(".pr-diff")).toBeTruthy();
  expect(
    codeChanges?.querySelector('[data-file-path="src/one.ts"]'),
  ).toBeTruthy();
  expect(
    codeChanges?.querySelector('[data-file-path="src/two.ts"]'),
  ).toBeNull();
  await choose("Changed file", "src/two.ts");
  expect(shown("Changed file")).toBe("src/two.ts");
  expect(
    codeChanges?.querySelector('[data-file-path="src/two.ts"]'),
  ).toBeTruthy();
  expect(
    codeChanges?.querySelector('[data-file-path="src/one.ts"]'),
  ).toBeNull();
  expect(slot.getByRole("button", { name: "Open Pair Review" })).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Pair Review fork" })).toBeNull();
  expect(slot.getByText("Outdated")).toBeTruthy();
  await openTab("Feedback");
  expect(slot.getByText("Not captured")).toBeTruthy();
  const refreshCalls = refresh.mock.calls.length;
  fireEvent.click(slot.getByRole("button", { name: "Refresh from GitHub" }));
  await waitFor(() =>
    expect(refresh.mock.calls.length).toBeGreaterThan(refreshCalls),
  );
  fireEvent.click(slot.getByRole("button", { name: "Open briefing" }));
  expect(slot.inspection.navigateCalls).toContainEqual({
    method: "experimental_openFilePreview",
    options: {
      target: {
        kind: "host",
        hostId: readyBriefing.hostId,
        path: "/retained/pr-briefing.html",
      },
      location: null,
    },
  });
  fireEvent.click(slot.getByRole("button", { name: "Open briefing thread" }));
  expect(slot.inspection.navigateCalls).toContainEqual({
    method: "toThread",
    threadId: "briefing-thread",
  });
  await new Promise((r) => setTimeout(r, 100));
  // Opened once; the explicit Refresh asked GitHub about this PR once more.
  expect(
    slot.inspection.rpcCalls.filter((c) => c.method === "prDetails"),
  ).toHaveLength(2);
  expect(
    slot.inspection.rpcCalls.find((c) => c.method === "details")?.input,
  ).toEqual(selection);
  expect(slot.inspection.rpcCalls.some((c) => c.method === "start")).toBe(
    false,
  );
});

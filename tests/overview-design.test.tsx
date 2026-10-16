// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import "./picker";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const queueItem = (number: number, tag: string) => ({
  key: `github.com/example/project#${number}`,
  url: `https://github.com/example/project/pull/${number}`,
  title: `Change ${number}`,
  subject: `example/project #${number}`,
  author: "author",
  head: "a".repeat(40),
  branch: `feature/${number}`,
  updatedAt: "2026-10-07T12:00:00Z",
  tags: [tag],
  freshness: "not_reviewed",
  previousAt: null,
  previousModel: null,
  changes: { files: 2, additions: 10, deletions: 1 },
});
const row = (overrides: Record<string, unknown>) => ({
  id: "batch/0",
  batchId: "batch",
  index: 0,
  key: "github.com/example/project#9",
  title: "Reviewed change",
  subject: "example/project #9",
  url: "https://github.com/example/project/pull/9",
  author: "author",
  head: "a".repeat(40),
  base: "b".repeat(40),
  branch: "feature/9",
  model: "openai/gpt-5",
  updatedAt: "2026-10-07T12:00:00Z",
  attempt: 1,
  reviewState: "findings",
  resolverState: "disabled",
  count: 3,
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
  changes: { files: 2, additions: 10, deletions: 1 },
  submitted: false,
  finalReview: false,
  ...overrides,
});
const snapshot = {
  queue: [
    queueItem(1, "Team request"),
    queueItem(2, "Team request"),
    queueItem(3, "Authored"),
  ],
  rows: [
    row({}),
    row({
      id: "failed/0",
      batchId: "failed",
      title: "Failed change",
      key: "github.com/example/project#8",
      subject: "example/project #8",
      reviewState: "needs_attention",
      attention: "Provider failure",
      count: 0,
    }),
  ],
  warnings: [],
  updatedAt: "2026-10-07T12:00:00Z",
  health: {
    forkPath: "/fork",
    version: "5.3.4",
    nodeVersion: "v26.5.0",
    ready: true,
    error: null,
    provider: "pi",
    reviewModel: "openai/gpt-5",
    resolverProvider: "pi",
    fixModel: "openai/gpt-5",
    teams: ["example/team"],
    teammates: [],
    port: 7247,
    database: "shared",
  },
  hostId: "host-fixture",
  preferences: {
    forkPath: "/fork",
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
let slot: ReturnType<typeof renderSlot>;
afterEach(() => slot?.lifecycle.unmount());

async function overview() {
  const app = await loadPluginApp(() => import("../app"));
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    { rpc: { snapshot: () => snapshot, refresh: () => snapshot } },
  );
  fireEvent.click(await slot.findByRole("tab", { name: /^PR Queue/ }));
  return slot;
}

test("summary metrics switch the overview tab", async () => {
  await overview();
  const metric = slot.getByRole("button", { name: /^Needs attention/ });
  fireEvent.click(metric);
  expect(metric.getAttribute("aria-pressed")).toBe("true");
  expect(
    slot
      .getByRole("tab", { name: /^Needs attention/ })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(slot.getByRole("heading", { name: "Failed change" })).toBeTruthy();
});

test("the request breakdown filters the queue and toggles back to all", async () => {
  await overview();
  expect(
    slot.getByRole("img", { name: /Team requests 2 PRs \(67%\)/ }),
  ).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Show Authored (1)" }));
  await waitFor(() =>
    expect(slot.queryByRole("heading", { name: "Change 1" })).toBeNull(),
  );
  expect(slot.getByRole("heading", { name: "Change 3" })).toBeTruthy();
  expect(
    slot
      .getByRole("button", { name: /^Authored/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(slot.getByRole("button", { name: "Show Authored (1)" }));
  expect(slot.getByRole("heading", { name: "Change 1" })).toBeTruthy();
});

test("findings filter praise apart and the history tab opens other attempts", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const detailsRow = row({});
  const older = row({
    id: "older/0",
    batchId: "older",
    updatedAt: "2026-10-06T12:00:00Z",
    reviewState: "needs_attention",
    attention: "Provider failure",
    count: 0,
  });
  const page = { ...snapshot, rows: [detailsRow, older] };
  const finding = (id: number, overrides: Record<string, unknown>) => ({
    id,
    file: "src/a.ts",
    title: `Finding ${id}`,
    body: `Body ${id}`,
    line: id * 10,
    sourcePath: null,
    kind: "bug",
    severity: "medium",
    suggestion: null,
    disposition: null,
    reason: null,
    ...overrides,
  });
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "batch/0" },
    {
      rpc: {
        snapshot: () => page,
        refresh: () => page,
        details: () => ({
          row: detailsRow,
          summary: "Summary",
          changes: detailsRow.changes,
          findings: [
            finding(1, {}),
            finding(2, { severity: "minor", kind: "improvement" }),
            finding(3, { severity: null, kind: "praise", title: "Nice work" }),
          ],
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
          feedback: { complete: true, error: null, comments: [] },
        }),
      },
    },
  );
  await slot.findByRole("heading", { name: "Findings" });
  expect(
    slot.getByRole("img", {
      name: "Actionable findings by severity: 1 medium, 1 low",
    }),
  ).toBeTruthy();
  expect(slot.queryByText("Nice work")).toBeNull();
  // An open finding becomes its own tinted card, edged in its severity color.
  const findingButton = slot.getByRole("button", { name: /^Finding 1/ });
  const item = findingButton.closest("li")!;
  expect(item.className).not.toContain("bg-surface-recessed");
  fireEvent.click(findingButton);
  expect(findingButton.getAttribute("aria-expanded")).toBe("true");
  expect(item.className).toContain("bg-surface-recessed");
  expect(item.style.boxShadow).toContain("var(--warning)");
  fireEvent.click(findingButton);
  expect(item.className).not.toContain("bg-surface-recessed");
  fireEvent.click(slot.getByRole("radio", { name: "Praise 1" }));
  expect(slot.getByText("Nice work")).toBeTruthy();
  expect(slot.queryByText("Finding 1")).toBeNull();
  fireEvent.click(slot.getByRole("radio", { name: "All 3" }));
  fireEvent.click(slot.getByRole("radio", { name: "By severity" }));
  const medium = slot.getByRole("region", { name: "medium" });
  expect(within(medium).getByText("Finding 1")).toBeTruthy();
  expect(within(medium).getByText("src/a.ts:10")).toBeTruthy();

  fireEvent.click(slot.getByRole("tab", { name: /^History/ }));
  const attempts = slot.getByRole("list", { name: "Review attempts" });
  expect(within(attempts).getByText("Viewing")).toBeTruthy();
  fireEvent.click(
    within(attempts).getByRole("button", { name: "Review failed" }),
  );
  expect(slot.inspection.navigateCalls).toContainEqual(
    expect.objectContaining({
      method: "toPluginPanel",
      options: { subPath: "older/0" },
    }),
  );
});

test("icon-only actions explain themselves in a tooltip, even when disabled", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const notReady = {
    ...snapshot,
    health: { ...snapshot.health, ready: false },
  };
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    { rpc: { snapshot: () => notReady, refresh: () => notReady } },
  );
  fireEvent.click(await slot.findByRole("tab", { name: /^PR Queue/ }));
  const row = (await slot.findByRole("heading", { name: "Change 1" })).closest(
    "article",
  )!;
  const open = within(row).getByRole("button", { name: "Open PR" });
  fireEvent.pointerMove(open, { pointerType: "mouse" });
  expect(
    (await screen.findByRole("tooltip", {}, { timeout: 2000 })).textContent,
  ).toBe("Open PR");
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());

  // A disabled button gets no pointer events; its wrapper carries the hint.
  const review = within(row).getByRole("button", {
    name: "Review latest changes",
  });
  expect(review.hasAttribute("disabled")).toBe(true);
  const wrapper = review.closest("[data-hint-wrapper]")!;
  fireEvent.pointerMove(wrapper, { pointerType: "mouse" });
  expect(
    (await screen.findByRole("tooltip", {}, { timeout: 2000 })).textContent,
  ).toBe("Review latest changes");
});

/** Module state (the cached snapshot) must not leak between these tests. */
async function freshApp() {
  vi.resetModules();
  return loadPluginApp(() => import("../app"));
}
const calls = (method: string) =>
  slot.inspection.rpcCalls.filter((call) => call.method === method);

test("opening the page uses the saved queue and does not ask GitHub", async () => {
  const app = await freshApp();
  const refreshedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const page = { ...snapshot, queueRefreshedAt: refreshedAt };
  let finishRefresh!: () => void;
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    {
      rpc: {
        snapshot: () => page,
        refresh: () =>
          new Promise((resolve) => {
            finishRefresh = () => resolve(page);
          }),
      },
    },
  );
  const label = await slot.findByText("Refreshed 5 minutes ago");
  expect(label.getAttribute("title")).toMatch(/^Last refreshed /);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(calls("refresh")).toHaveLength(0);
  fireEvent.click(slot.getByRole("tab", { name: /^PR Queue/ }));
  expect(slot.queryByText(/No saved queue yet/)).toBeNull();

  // Refreshing is the user's call. While it runs the button says so, and the
  // header keeps showing the last completed refresh.
  fireEvent.click(slot.getByRole("button", { name: "Refresh from GitHub" }));
  await waitFor(() =>
    expect(
      slot
        .getByRole("button", { name: "Refreshing GitHub…" })
        .hasAttribute("disabled"),
    ).toBe(true),
  );
  expect(slot.getByText("Refreshed 5 minutes ago")).toBeTruthy();
  expect(slot.queryByText("Refreshing from GitHub…")).toBeNull();
  finishRefresh();
  await waitFor(() =>
    expect(
      slot
        .getByRole("button", { name: "Refresh from GitHub" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(calls("refresh")).toHaveLength(1);
});

test("with no saved queue it asks GitHub once, even as the page keeps polling", async () => {
  const app = await freshApp();
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    {
      rpc: {
        snapshot: () => snapshot,
        // Fails like a rate limit: there must be no retry loop.
        refresh: () => {
          throw Error("gh: API rate limit exceeded");
        },
      },
    },
  );
  await slot.findByText(/GitHub queue could not be refreshed/);
  await slot.behavior.emitRealtime("changed", {});
  await new Promise((resolve) => setTimeout(resolve, 3400));
  expect(calls("refresh")).toHaveLength(1);
  // The failure stays visible, with an explicit retry instead of an automatic one.
  expect(slot.getByRole("button", { name: "Retry PR discovery" })).toBeTruthy();
}, 10_000);

test("the header admits when the queue has never been refreshed", async () => {
  const app = await loadPluginApp(() => import("../app"));
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    { rpc: { snapshot: () => snapshot, refresh: () => snapshot } },
  );
  expect(await slot.findByText("Not refreshed yet")).toBeTruthy();
});

// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
const snapshot = {
  rows: [],
  queue: [],
  warnings: [],
  updatedAt: "2026-10-07T00:00:00Z",
  health: {
    forkPath: "/Users/example/Dev/pair-review",
    version: "5.2.3",
    nodeVersion: "v26.5.0",
    ready: true,
    error: null,
    repository: {
      name: "example/pair-review",
      url: "https://github.com/example/pair-review",
    },
  },
  hostId: "host-fixture",
  preferences: {
    forkPath: "~/Dev/pair-review",
    hostname: "github.com",
    reviewModel: "openai/gpt-5",
    fixModel: "openai/gpt-5",
    reviewThinking: "medium" as const,
    fixThinking: "medium" as const,
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
});
test("registers a dedicated Pair Review navigation page", async () => {
  const app = await loadPluginApp(() => import("../app"));
  expect(app.navPanels).toHaveLength(1);
  expect(app.navPanels[0]).toMatchObject({
    id: "reviews",
    title: "Pair Review",
    path: "reviews",
    icon: "Search",
  });
  expect(app.experimentalSidebarNavigations).toHaveLength(0);
});
test("shows a GitHub origin link, a header start bar, and the local-branch dialog", async () => {
  const app = await loadPluginApp(() => import("../app"));
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    { rpc: { snapshot: () => snapshot, refresh: () => snapshot } },
  );
  const link = await slot.findByRole("link", { name: "example/pair-review" });
  expect(link.getAttribute("href")).toBe(
    "https://github.com/example/pair-review",
  );
  expect(slot.queryByLabelText("Optional batch name")).toBeNull();
  expect(slot.queryByText(/\/Users\/example/)).toBeNull();
  // Starting a review lives in the header, not in its own section, so the
  // summary sits directly above the lists it filters.
  const startBar = slot.getByRole("form", { name: "Start a Pair Review" });
  expect(startBar.closest("header")).toBeTruthy();
  expect(
    within(startBar).getByLabelText("GitHub pull request URLs"),
  ).toBeTruthy();
  expect(
    within(startBar)
      .getByRole("button", { name: "Start Pair Review" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(slot.queryByRole("heading", { name: "Start a Pair Review" })).toBeNull();
  const summary = slot.getByRole("region", { name: "Review summary" });
  const lists = slot.getByRole("region", { name: "Pair Review lists" });
  expect(
    startBar.compareDocumentPosition(summary) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    summary.compareDocumentPosition(lists) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  // Local reviews open in a dialog that keeps the field guidance.
  expect(slot.queryByLabelText("Local checkout path")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Review a local branch…" }));
  const dialog = await slot.findByRole("dialog", {
    name: "Review a local branch",
  });
  expect(
    within(dialog)
      .getByLabelText("Local checkout path")
      .getAttribute("placeholder"),
  ).toBe("/Users/you/Code/repository");
  expect(
    within(dialog).getByText(/Full path to the local Git checkout/),
  ).toBeTruthy();
  expect(within(dialog).getByText(/Compare from this ref/)).toBeTruthy();
  expect(within(dialog).getByText(/Blank uses/)).toBeTruthy();
  expect(
    within(dialog)
      .getByRole("button", { name: "Confirm local review" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(slot!.queryByRole("dialog")).toBeNull());

  const tabs = within(
    slot.getByRole("tablist", { name: "Pair Review lists" }),
  ).getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent?.replace(/\d+$/, ""))).toEqual([
    "PR Queue",
    "Running",
    "Needs attention",
    "Final Review",
    "Recent reviews",
    "Dismissed",
  ]);
  fireEvent.click(tabs[0]!);
  expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
  const queue = slot.getByRole("heading", { name: "PR Queue" });
  const controls = slot.getByRole("group", { name: "Request type" });
  expect(
    queue.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
test("a local branch review previews, confirms, and starts from the dialog", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const preview = vi.fn(() => ({
    base: "origin/main",
    baseSha: "b".repeat(40),
    head: "c".repeat(40),
  }));
  const start = vi.fn(() => ({ batchId: "local-batch" }));
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    {
      rpc: {
        snapshot: () => snapshot,
        refresh: () => snapshot,
        preview,
        start,
      },
    },
  );
  await slot.findByRole("link", { name: "example/pair-review" });
  fireEvent.click(slot.getByRole("button", { name: "Review a local branch…" }));
  const dialog = await slot.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Local checkout path"), {
    target: { value: "/work/project" },
  });
  fireEvent.change(within(dialog).getByLabelText("Local branch"), {
    target: { value: "feature/local" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Confirm local review" }),
  );
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith({
      urls: [],
      local: {
        path: "/work/project",
        branch: "feature/local",
        expectedHead: "c".repeat(40),
        expectedBase: "b".repeat(40),
      },
    }),
  );
  expect(preview).toHaveBeenCalledWith({
    urls: [],
    local: { path: "/work/project", branch: "feature/local" },
  });
  expect(confirm).toHaveBeenCalledWith(
    expect.stringContaining("Publication is disabled"),
  );
  await waitFor(() => expect(slot!.queryByRole("dialog")).toBeNull());
  expect(slot.inspection.navigateCalls).toContainEqual(
    expect.objectContaining({
      method: "toPluginPanel",
      options: { subPath: "local-batch/0" },
    }),
  );
  confirm.mockRestore();
});
test("starts without a name and navigates to review details", async () => {
  const app = await loadPluginApp(() => import("../app"));
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    {
      rpc: {
        snapshot: () => snapshot,
        refresh: () => snapshot,
        start: () => ({ batchId: "fixture-batch" }),
      },
    },
  );
  await slot.findByRole("link", { name: "example/pair-review" });
  fireEvent.change(slot.getByLabelText("GitHub pull request URLs"), {
    target: { value: "https://github.com/example/project/pull/12" },
  });
  fireEvent.click(slot.getByRole("button", { name: "Start Pair Review" }));
  await waitFor(() =>
    expect(
      slot!.inspection.rpcCalls.find((c) => c.method === "start")?.input,
    ).toEqual({ urls: ["https://github.com/example/project/pull/12"] }),
  );
  await waitFor(() =>
    expect(slot!.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toPluginPanel" }),
    ),
  );
});
test("automatically discovers PRs on entry and displays the saved refreshed queue", async () => {
  const app = await loadPluginApp(() => import("../app"));
  let value: any = snapshot;
  const refresh = vi.fn(() => {
    value = {
      ...snapshot,
      queue: [
        {
          key: "github.com/example/project/12",
          url: "https://github.com/example/project/pull/12",
          title: "Discovered automatically",
          subject: "example/project #12",
          author: "someone",
          head: "a".repeat(40),
          tags: ["Direct request"],
          freshness: "not_reviewed",
          previousAt: null,
          previousModel: null,
        },
      ],
    };
    return value;
  });
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    { rpc: { snapshot: () => value, refresh } },
  );
  await slot.findByRole("heading", { name: "Discovered automatically" });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(
    slot.inspection.rpcCalls.filter((c) => c.method === "start"),
  ).toHaveLength(0);
});
test("discovery errors survive successful status polling and offer an explicit retry", async () => {
  const app = await loadPluginApp(() => import("../app"));
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    {
      rpc: {
        snapshot: () => snapshot,
        refresh: () => {
          throw Error("GitHub authentication failed");
        },
      },
    },
  );
  await slot.findByText(/GitHub queue could not be refreshed/);
  await waitFor(() =>
    expect(
      slot!
        .getByRole("button", { name: "Refresh from GitHub" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  await slot.behavior.emitRealtime("changed", {});
  expect(slot.getByText(/GitHub queue could not be refreshed/)).toBeTruthy();
  expect(slot.getByRole("button", { name: "Retry PR discovery" })).toBeTruthy();
});

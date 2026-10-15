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
test("shows a GitHub origin link, no batch name or filesystem label, and a native disclosure", async () => {
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
  expect(
    slot.getByText("Local checkout or branch").closest("summary")?.parentElement
      ?.tagName,
  ).toBe("DETAILS");
  const controls = slot.getByRole("heading", {
    name: "Filter and batch PR queue",
  });
  const running = slot.getByRole("heading", { name: "Running" });
  const recent = slot.getByRole("heading", { name: "Recent reviews" });
  const queue = slot.getByRole("heading", { name: "Your PR queue" });
  expect(
    controls.compareDocumentPosition(running) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    running.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    recent.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    slot
      .getByRole("button", { name: "Start Pair Review" })
      .hasAttribute("disabled"),
  ).toBe(true);
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

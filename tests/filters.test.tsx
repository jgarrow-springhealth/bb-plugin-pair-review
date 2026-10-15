// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
const pr = (number: number, repo: string, tag: string) => ({
  key: `github.com/example/${repo}#${number}`,
  url: `https://github.com/example/${repo}/pull/${number}`,
  title: `Change ${number}`,
  subject: `example/${repo} #${number}`,
  author: "author",
  head: "a".repeat(40),
  branch: `feature/${repo}-${number}`,
  updatedAt: "2026-10-07T12:34:56Z",
  tags: [tag],
  freshness: "not_reviewed",
  previousAt: null,
  previousModel: null,
});
const queue = [
  pr(1, "one", "Teammate request"),
  pr(2, "two", "Other direct request"),
  pr(3, "one", "Team request"),
];
const snapshot = {
  queue,
  rows: [],
  warnings: [],
  updatedAt: "2026-10-07T00:00:00Z",
  health: {
    forkPath: "/trusted/fork",
    version: "5.2.3",
    nodeVersion: "v26.5.0",
    ready: true,
    error: null,
  },
  hostId: "host-fixture",
  preferences: {
    forkPath: "/trusted/fork",
    hostname: "github.com",
    reviewModel: "openai/gpt-5",
    fixModel: "openai/gpt-5",
    reviewThinking: "medium",
    fixThinking: "medium",
    resolverMaxRounds: 3,
    publish: false,
    feedback: true,
    hideReviewed: true,
    teams: "example/frontend",
    teammates: "author",
    preparationConcurrency: 4,
  },
};
let slot: ReturnType<typeof renderSlot>;
afterEach(() => slot?.lifecycle.unmount());
async function render(value: any = snapshot) {
  const app = await loadPluginApp(() => import("../app"));
  slot = renderSlot(
    app.navPanels[0],
    { subPath: "" },
    { rpc: { snapshot: () => value, refresh: () => value } },
  );
  await slot.findByRole("heading", { name: "Change 1" });
  return slot;
}
test("separate request tabs intersect repository and text filters", async () => {
  await render();
  const firstCard = slot
    .getByRole("heading", { name: "Change 1" })
    .closest("article")!;
  expect(within(firstCard).getByText(/Last updated/)).toBeTruthy();
  expect(within(firstCard).queryByText("feature/one-1")).toBeNull();
  expect(within(firstCard).queryByText("aaaaaaaaaa")).toBeNull();
  expect(slot.queryByRole("button", { name: /^Direct requests/ })).toBeNull();
  fireEvent.change(
    slot.getByRole("combobox", { name: "Filter by repository" }),
    { target: { value: "example/one" } },
  );
  expect(slot.queryByRole("heading", { name: "Change 2" })).toBeNull();
  expect(slot.getByRole("heading", { name: "Change 3" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: /^Team requests/ }));
  expect(slot.queryByRole("heading", { name: "Change 1" })).toBeNull();
  expect(slot.getByRole("heading", { name: "Change 3" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: /^Teammate requests/ }));
  expect(slot.getByRole("heading", { name: "Change 1" })).toBeTruthy();
  expect(slot.queryByRole("heading", { name: "Change 3" })).toBeNull();
  fireEvent.change(slot.getByRole("textbox", { name: "Search PR queue" }), {
    target: { value: "absent" },
  });
  expect(slot.queryByRole("heading", { name: "Change 1" })).toBeNull();
});
test("running PR replaces freshness with a spinner and stays visible even when current reviews are hidden", async () => {
  const row = {
    id: "batch/0",
    batchId: "batch",
    index: 0,
    key: queue[0].key,
    title: "Active work",
    subject: "example/one #1",
    url: queue[0].url,
    author: "author",
    head: "a".repeat(40),
    base: "b".repeat(40),
    branch: "feature",
    model: "openai/gpt-5",
    updatedAt: snapshot.updatedAt,
    attempt: 1,
    reviewState: "reviewing",
    resolverState: "pending",
    count: 0,
    attention: null,
    path: null,
    owned: false,
    superseded: false,
    running: true,
    canRetry: false,
    canAttempt: false,
    canValidate: false,
    publish: false,
    briefState: "missing",
  };
  await render({
    ...snapshot,
    queue: [{ ...queue[0], freshness: "current" }, ...queue.slice(1)],
    rows: [row],
  });
  const card = slot
    .getByRole("heading", { name: "Change 1" })
    .closest("article")!;
  expect(
    within(card)
      .getByRole("status", { name: "Review in progress" })
      .querySelector(".pr-spinner"),
  ).toBeTruthy();
  expect(within(card).queryByText("Review in progress")).toBeNull();
  const runningCard = slot
    .getByRole("heading", { name: "Active work" })
    .closest("article")!;
  expect(within(runningCard).queryByText("Running")).toBeNull();
  expect(
    within(runningCard)
      .getByRole("status", { name: "Review in progress" })
      .querySelector(".pr-spinner"),
  ).toBeTruthy();
  expect(within(card).queryByText("Not reviewed")).toBeNull();
  expect(
    within(card)
      .getByRole("button", { name: "Review running" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
test("overview cards replace a full review error with a compact treatment", async () => {
  const error =
    "Analysis failed: No API key found for openai. Full retained diagnostic.";
  const row = {
    id: "failed/0",
    batchId: "failed",
    index: 0,
    key: queue[0].key,
    title: "Failed work",
    subject: "example/one #1",
    url: queue[0].url,
    author: "author",
    head: "a".repeat(40),
    base: "b".repeat(40),
    branch: "feature",
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
  await render({ ...snapshot, rows: [row] });
  expect(slot.queryByText(error)).toBeNull();
  for (const name of ["Change 1", "Failed work"]) {
    const card = slot.getByRole("heading", { name }).closest("article")!;
    expect(within(card).getByText("Review failed")).toBeTruthy();
    expect(within(card).getByText("Review couldn’t finish")).toBeTruthy();
    expect(
      within(card).getByText(/Open Details to see the full error/),
    ).toBeTruthy();
  }
});
test("superseded attempts do not display an in-flight badge", async () => {
  await render({
    ...snapshot,
    rows: [
      {
        id: "batch/0",
        batchId: "batch",
        index: 0,
        key: queue[0].key,
        title: "Old work",
        subject: "example/one #1",
        url: queue[0].url,
        author: "author",
        head: "a".repeat(40),
        updatedAt: snapshot.updatedAt,
        attempt: 1,
        reviewState: "reviewing",
        resolverState: "pending",
        briefState: "missing",
        running: true,
        superseded: true,
        attention: null,
      },
    ],
  });
  await waitFor(() =>
    expect(
      within(
        slot.getByRole("heading", { name: "Change 1" }).closest("article")!,
      ).getByText("Not reviewed"),
    ).toBeTruthy(),
  );
});

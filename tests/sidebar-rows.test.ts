import { expect, test } from "vitest";
import type { ReviewRow, Snapshot } from "../contract";
import { pairReviewProjectRows } from "../sidebar-rows";

const row = (overrides: Partial<ReviewRow>): ReviewRow =>
  ({
    id: "batch/0",
    batchId: "batch",
    index: 0,
    key: "github.com/example/repo#1",
    title: "Review me",
    subject: "example/repo #1",
    url: "https://github.com/example/repo/pull/1",
    author: "dev",
    head: "a".repeat(40),
    base: "b".repeat(40),
    branch: "feature",
    model: "openai/gpt-5",
    updatedAt: "2026-10-09T12:00:00Z",
    attempt: 1,
    reviewState: "findings",
    resolverState: "disabled",
    count: 3,
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
    changes: null,
    submitted: false,
    ...overrides,
  }) as ReviewRow;

const snapshot = (rows: ReviewRow[]): Snapshot =>
  ({
    rows,
    queue: [],
    warnings: [],
    updatedAt: "2026-10-09T12:00:00Z",
    health: { forkPath: "/Users/example/Dev/pair-review/" },
  }) as unknown as Snapshot;

test("maps the latest active reviews to thread-shaped Pair Review project rows", () => {
  const rows = pairReviewProjectRows(
    snapshot([
      row({
        id: "old/0",
        batchId: "old",
        updatedAt: "2026-10-08T12:00:00Z",
        count: 1,
      }),
      row({
        id: "current/0",
        batchId: "current",
        updatedAt: "2026-10-09T12:00:00Z",
        count: 4,
      }),
      row({
        id: "live/0",
        batchId: "live",
        key: "github.com/example/repo#2",
        title: "Live review",
        reviewState: "reviewing",
        running: true,
        count: 0,
        updatedAt: "2026-10-07T12:00:00Z",
      }),
      row({ id: "dismissed/0", key: "dismissed", dismissed: true }),
      row({
        id: "submitted-old/0",
        key: "submitted",
        updatedAt: "2026-10-08T12:00:00Z",
      }),
      row({
        id: "submitted/0",
        key: "submitted",
        submitted: true,
        updatedAt: "2026-10-09T12:00:00Z",
      }),
    ]),
    [
      {
        id: "proj_pair",
        name: "Pair Review",
        sources: [
          { type: "local_path", path: "/Users/example/Dev/pair-review" },
        ],
      },
    ],
  );

  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    id: "live/0",
    projectId: "proj_pair",
    title: "Live review",
    status: "running",
    statusLabel: "In progress",
    href: "/plugins/pair-review/reviews/live/0",
  });
  expect(rows[1]).toMatchObject({
    id: "current/0",
    status: "done",
    statusLabel: "4 findings",
    count: 4,
  });
});

test("returns no rows when the Pair Review BB project cannot be resolved", () => {
  expect(pairReviewProjectRows(snapshot([row({})]), [])).toEqual([]);
});

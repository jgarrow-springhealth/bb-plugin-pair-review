import { expect, test } from "vitest";
import { Input, keyFor } from "../engine/types";
import { initial } from "../engine/status";
import { latestReviewSelection } from "../pr-details";
const target = {
  kind: "pr",
  host: "github.com",
  owner: "example",
  repo: "project",
  number: 12,
  url: "https://github.com/example/project/pull/12",
  title: "PR",
  author: "someone",
  headBranch: "feature",
  baseBranch: "main",
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  headRepo: "example/project",
} as const;
function batch(batchId: string, createdAt: string) {
  return initial(
    Input.parse({
      version: 1,
      batchId,
      createdAt,
      login: "viewer",
      settings: {},
      targets: [target],
      origin: "test",
    }),
  );
}
test("no history returns no selection, not a newly created batch", () =>
  expect(latestReviewSelection([], keyFor(target))).toBeNull());
test("chooses the latest non-superseded attempt without mutating history", () => {
  const s = batch("saved", "2026-01-01T00:00:00Z");
  s.state = "complete";
  s.entries.push({ ...s.entries[0], attempt: 2 });
  const before = JSON.stringify(s);
  expect(latestReviewSelection([s], keyFor(target))).toEqual({
    batchId: "saved",
    index: 1,
  });
  expect(JSON.stringify(s)).toBe(before);
});
test("prioritizes running work over completed history and newer batches over late updates to old ones", () => {
  const old = batch("old", "2026-01-01T00:00:00Z"),
    fresh = batch("fresh", "2026-02-01T00:00:00Z");
  old.state = fresh.state = "complete";
  old.updatedAt = "2026-03-01T00:00:00Z";
  expect(latestReviewSelection([old, fresh], keyFor(target))).toEqual({
    batchId: "fresh",
    index: 0,
  });
  old.state = "running";
  expect(latestReviewSelection([fresh, old], keyFor(target))).toEqual({
    batchId: "old",
    index: 0,
  });
});
test("ignores runs dismissed from the BB review lists", () => {
  const old = batch("old", "2026-01-01T00:00:00Z"),
    current = batch("current", "2026-02-01T00:00:00Z");
  old.state = current.state = "complete";
  expect(
    latestReviewSelection(
      [old, current],
      keyFor(target),
      new Set(["current/0"]),
    ),
  ).toEqual({ batchId: "old", index: 0 });
  expect(
    latestReviewSelection(
      [old, current],
      keyFor(target),
      new Set(["current/0", "old/0"]),
    ),
  ).toBeNull();
});

test("uses canonical target identity, not a mismatched entry key", () => {
  const s = batch("bad", "2026-01-01T00:00:00Z");
  s.entries[0].key = "github.com/other/project#12";
  expect(latestReviewSelection([s], "github.com/other/project#12")).toBeNull();
});

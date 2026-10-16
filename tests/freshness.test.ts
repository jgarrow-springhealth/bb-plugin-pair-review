import { expect, test } from "vitest";
import {
  FRESH_FOR_MS,
  newestHead,
  reviewFreshness,
  type HeadSource,
} from "../freshness";

const reviewed = "a".repeat(40);
const newer = "b".repeat(40);
const now = Date.parse("2026-10-16T16:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const head = (
  sha: string,
  checkedMsAgo: number | null,
  over: Partial<HeadSource> = {},
): HeadSource => ({
  head: sha,
  checkedAt: checkedMsAgo === null ? null : ago(checkedMsAgo),
  state: null,
  source: "queue",
  ...over,
});

test("a review of an older commit is stale, and says when that was checked", () => {
  const f = reviewFreshness({
    reviewedHead: reviewed,
    source: head(newer, 5_000, { source: "live", state: "open" }),
    local: false,
    nowMs: now,
  });
  expect(f).toMatchObject({
    status: "stale",
    stale: true,
    verified: true,
    value: "New commits",
    note: "GitHub head is now bbbbbbbbbb · checked just now",
    tone: "warn",
  });
});

test("a stale head stays stale however old the check is", () => {
  const f = reviewFreshness({
    reviewedHead: reviewed,
    source: head(newer, 3 * 60 * 60 * 1000),
    local: false,
    nowMs: now,
  });
  expect(f).toMatchObject({
    stale: true,
    verified: false,
    value: "New commits",
  });
  expect(f.note).toBe("GitHub head is now bbbbbbbbbb · checked 3 hours ago");
});

test("an unchanged head is Current only when checked recently", () => {
  expect(
    reviewFreshness({
      reviewedHead: reviewed,
      source: head(reviewed, 12 * 60 * 1000),
      local: false,
      nowMs: now,
    }),
  ).toMatchObject({
    status: "current",
    value: "Current",
    note: "Head unchanged · checked 12 minutes ago",
    tone: "good",
  });
  const old = reviewFreshness({
    reviewedHead: reviewed,
    source: head(reviewed, FRESH_FOR_MS + 60_000),
    local: false,
    nowMs: now,
  });
  expect(old).toMatchObject({
    status: "unverified",
    stale: false,
    verified: false,
    value: "Not confirmed",
    note: "Unchanged as of 31 minutes ago · refresh to check",
    tone: "neutral",
  });
});

test("a failed live check never claims Current", () => {
  expect(
    reviewFreshness({
      reviewedHead: reviewed,
      source: head(reviewed, 2 * 60 * 60 * 1000),
      local: false,
      checkError: "gh: API rate limit exceeded",
      nowMs: now,
    }),
  ).toMatchObject({
    status: "unverified",
    note: "Unchanged as of 2 hours ago · couldn't reach GitHub",
  });
  expect(
    reviewFreshness({
      reviewedHead: reviewed,
      source: null,
      local: false,
      checkError: "boom",
      nowMs: now,
    }),
  ).toMatchObject({
    status: "unknown",
    note: "Couldn't reach GitHub to check",
  });
  expect(
    reviewFreshness({
      reviewedHead: reviewed,
      source: head(reviewed, null),
      local: false,
      nowMs: now,
    }),
  ).toMatchObject({
    status: "unverified",
    checked: null,
    note: "Unchanged as of an unknown time · refresh to check",
  });
});

test("merged and closed pull requests say whether commits landed after the review", () => {
  expect(
    reviewFreshness({
      reviewedHead: reviewed,
      source: head(reviewed, 1000, { source: "live", state: "merged" }),
      local: false,
      nowMs: now,
    }),
  ).toMatchObject({
    status: "merged",
    stale: false,
    value: "Merged",
    note: "No commits after this review · checked just now",
    tone: "neutral",
  });
  expect(
    reviewFreshness({
      reviewedHead: reviewed,
      source: head(newer, 1000, { source: "live", state: "closed" }),
      local: false,
      nowMs: now,
    }),
  ).toMatchObject({
    status: "closed",
    stale: true,
    value: "Closed",
    tone: "warn",
  });
});

test("local-branch reviews have nothing on GitHub to compare", () => {
  expect(
    reviewFreshness({
      reviewedHead: reviewed,
      source: null,
      local: true,
      nowMs: now,
    }),
  ).toMatchObject({ status: "local", stale: false, value: "Local branch" });
});

test("the most recently checked head wins, whichever source it came from", () => {
  const live = head(newer, 60_000, { source: "live" });
  const queue = head(reviewed, 30_000, { source: "queue" });
  expect(newestHead(live, queue)).toBe(queue);
  expect(newestHead(head(reviewed, null), live)).toBe(live);
  expect(newestHead(null, undefined)).toBeNull();
});

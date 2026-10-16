import { expect, test } from "vitest";
import {
  describeReset,
  isRateLimitError,
  limitStatus,
  parseRateLimit,
} from "../github-limits";

test.each([
  "Error: Error: gh exited 1: gh: API rate limit exceeded for user ID 1.",
  "gh: You have exceeded a secondary rate limit. Please wait a few minutes.",
  "HTTP 403: API rate limit reached (https://api.github.com/graphql)",
  "gh: HTTP 429 Too Many Requests",
])("recognizes rate limiting: %s", (message) =>
  expect(isRateLimitError(Error(message))).toBe(true),
);

test.each([
  "gh: Not Found (HTTP 404)",
  "GitHub authentication failed",
  "Diff exceeds the 4 MiB page limit",
])("does not mistake other failures for rate limiting: %s", (message) =>
  expect(isRateLimitError(message)).toBe(false),
);

const now = Date.parse("2026-10-16T19:44:00Z");
const bucket = (remaining: number, reset: string, limit = 5000) => ({
  limit,
  remaining,
  resetAt: reset,
});

test("reports the latest refill among the budgets that are used up", () => {
  expect(
    limitStatus(
      {
        core: bucket(0, "2026-10-16T19:53:04Z"),
        search: bucket(0, "2026-10-16T19:45:00Z", 30),
        graphql: bucket(4000, "2026-10-16T20:03:00Z"),
      },
      now,
    ),
  ).toEqual({ resetAt: "2026-10-16T19:53:04Z", secondary: false });
});

test("no exhausted budget means GitHub's short-term secondary limit applied", () => {
  expect(
    limitStatus(
      {
        core: bucket(4000, "2026-10-16T19:53:04Z"),
        search: bucket(30, "2026-10-16T19:45:00Z", 30),
        graphql: null,
      },
      now,
    ),
  ).toEqual({ resetAt: null, secondary: true });
  // A used-up bucket whose reset already passed no longer blocks anything.
  expect(
    limitStatus(
      { core: bucket(0, "2026-10-16T19:00:00Z"), search: null, graphql: null },
      now,
    ),
  ).toEqual({ resetAt: null, secondary: true });
  expect(limitStatus(null, now)).toEqual({ resetAt: null, secondary: true });
});

test("describes how long until a reset", () => {
  expect(describeReset("2026-10-16T19:53:04Z", now)).toMatch(
    /\(in 10 minutes\)$/,
  );
  expect(describeReset("2026-10-16T19:44:30Z", now)).toMatch(
    /\(in under a minute\)$/,
  );
  expect(describeReset("2026-10-16T21:44:00Z", now)).toMatch(
    /\(in about 2 hours\)$/,
  );
});

test("parses gh api rate_limit output and ignores malformed buckets", () => {
  expect(
    parseRateLimit({
      resources: {
        core: { limit: 5000, remaining: 0, reset: 1792180384, used: 5000 },
        search: { limit: 30, remaining: 30, reset: 1792179900 },
        graphql: { limit: "5000" },
      },
    }),
  ).toEqual({
    core: {
      limit: 5000,
      remaining: 0,
      resetAt: new Date(1792180384 * 1000).toISOString(),
    },
    search: {
      limit: 30,
      remaining: 30,
      resetAt: new Date(1792179900 * 1000).toISOString(),
    },
    graphql: null,
  });
  expect(parseRateLimit(null)).toEqual({
    core: null,
    search: null,
    graphql: null,
  });
});

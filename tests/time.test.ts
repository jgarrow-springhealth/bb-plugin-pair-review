import { expect, test } from "vitest";
import { relativeRefreshedAt, relativeUpdatedAt } from "../time";
const now = Date.parse("2026-06-18T12:00:00Z");
const ago = (milliseconds: number) =>
  new Date(now - milliseconds).toISOString();
const hour = 60 * 60 * 1000;
const day = 24 * hour;
const week = 7 * day;
test.each([
  [30 * 60 * 1000, "less than an hour ago"],
  [hour, "1 hour ago"],
  [47 * hour, "47 hours ago"],
  [48 * hour, "2 days ago"],
  [13 * day, "13 days ago"],
  [14 * day, "2 weeks ago"],
  [8 * week, "8 weeks ago"],
])("uses requested relative-time threshold for %s ms", (elapsed, expected) =>
  expect(relativeUpdatedAt(ago(elapsed), now)).toBe(expected),
);
test("switches to M/D/YY at nine weeks and handles invalid/future values", () => {
  expect(relativeUpdatedAt(ago(9 * week), now)).toBe("4/16/26");
  expect(relativeUpdatedAt("invalid", now)).toBe("unknown");
  expect(relativeUpdatedAt(new Date(now + hour).toISOString(), now)).toBe(
    "less than an hour ago",
  );
});
test.each([
  [0, "just now"],
  [59 * 1000, "just now"],
  [60 * 1000, "1 minute ago"],
  [2 * 60 * 1000, "2 minutes ago"],
  [59 * 60 * 1000, "59 minutes ago"],
  [hour, "1 hour ago"],
  [23 * hour, "23 hours ago"],
])("refresh age at minute resolution for %s ms", (elapsed, expected) =>
  expect(relativeRefreshedAt(ago(elapsed), now)).toBe(expected),
);
test("refresh age names yesterday, then falls back to the date", () => {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(9, 5, 0, 0);
  const current = new Date(yesterday);
  current.setDate(current.getDate() + 1);
  current.setHours(10, 0, 0, 0); // 24h55m later, on the next calendar day
  expect(
    relativeRefreshedAt(yesterday.toISOString(), current.getTime()),
  ).toMatch(/^yesterday 9:05/);
  expect(relativeRefreshedAt(ago(3 * day), now)).toMatch(/2026/);
  expect(relativeRefreshedAt("invalid", now)).toBeNull();
  expect(relativeRefreshedAt(new Date(now + hour).toISOString(), now)).toBe(
    "just now",
  );
});

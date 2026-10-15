import { expect, test } from "vitest";
import { relativeUpdatedAt } from "../time";
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

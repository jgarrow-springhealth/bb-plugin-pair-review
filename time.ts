const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const plural = (count: number, unit: string) =>
  `${count} ${unit}${count === 1 ? "" : "s"} ago`;
export function relativeUpdatedAt(value: string, current = Date.now()) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "unknown";
  const elapsed = Math.max(0, current - timestamp);
  if (elapsed < HOUR) return "less than an hour ago";
  if (elapsed < 48 * HOUR) return plural(Math.floor(elapsed / HOUR), "hour");
  if (elapsed < 14 * DAY) return plural(Math.floor(elapsed / DAY), "day");
  if (elapsed < 9 * WEEK) return plural(Math.floor(elapsed / WEEK), "week");
  return new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  }).format(new Date(timestamp));
}

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
const MINUTE = 60 * 1000;
const clock = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
/**
 * How long ago something happened, at minute resolution: "just now",
 * "5 minutes ago", "3 hours ago", "yesterday 4:12 PM", then the date.
 */
export function relativeRefreshedAt(value: string, current = Date.now()) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const elapsed = Math.max(0, current - timestamp);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const date = new Date(timestamp);
  const yesterday = new Date(current);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString())
    return `yesterday ${clock(date)}`;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

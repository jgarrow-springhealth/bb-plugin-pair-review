// Are a review's findings still about the pull request's current code?
//
// A review is stale when GitHub's head commit differs from the commit that
// was reviewed. What Pair Review knows about GitHub's head is only as good as
// when it last looked, so every answer carries that time.
import { relativeRefreshedAt } from "./time";

/** A head checked this recently counts as verified. */
export const FRESH_FOR_MS = 30 * 60 * 1000;

export interface HeadSource {
  head: string;
  /** When this head was read from GitHub; null if unknown. */
  checkedAt: string | null;
  /** Known only from a live check; the saved queue lists open PRs. */
  state: "open" | "closed" | "merged" | null;
  source: "live" | "queue";
}

/** The most recently checked of the known heads. */
export function newestHead(
  ...sources: (HeadSource | null | undefined)[]
): HeadSource | null {
  const known = sources.filter((s): s is HeadSource => !!s);
  if (!known.length) return null;
  const time = (s: HeadSource) =>
    s.checkedAt && Number.isFinite(Date.parse(s.checkedAt))
      ? Date.parse(s.checkedAt)
      : -Infinity;
  return known.reduce((best, s) => (time(s) > time(best) ? s : best));
}

export type FreshnessStatus =
  | "stale"
  | "current"
  | "unverified"
  | "merged"
  | "closed"
  | "local"
  | "unknown";

export interface Freshness {
  status: FreshnessStatus;
  /** The reviewed commit is no longer GitHub's head. */
  stale: boolean;
  /** GitHub's head was confirmed within FRESH_FOR_MS. */
  verified: boolean;
  head: string | null;
  /** "just now", "12 minutes ago", or null when never checked. */
  checked: string | null;
  value: string;
  note: string;
  tone: "neutral" | "good" | "warn";
}

/** Matches how the rest of the page shortens commits. */
const short = (sha: string) => sha.slice(0, 10);

export function reviewFreshness({
  reviewedHead,
  source,
  local,
  checkError,
  nowMs = Date.now(),
}: {
  reviewedHead: string;
  source: HeadSource | null;
  /** A local-branch review: GitHub has nothing to compare. */
  local: boolean;
  /** Why the live check failed, if it did. */
  checkError?: string | null;
  nowMs?: number;
}): Freshness {
  if (local)
    return {
      status: "local",
      stale: false,
      verified: false,
      head: null,
      checked: null,
      value: "Local branch",
      note: "Not tracked on GitHub",
      tone: "neutral",
    };
  if (!source)
    return {
      status: "unknown",
      stale: false,
      verified: false,
      head: null,
      checked: null,
      value: "Unknown",
      note: checkError
        ? "Couldn't reach GitHub to check"
        : "Not in your saved queue · refresh to check",
      tone: "neutral",
    };
  const at = source.checkedAt ? Date.parse(source.checkedAt) : Number.NaN;
  const checked = Number.isFinite(at)
    ? relativeRefreshedAt(source.checkedAt!, nowMs)
    : null;
  const verified = Number.isFinite(at) && nowMs - at < FRESH_FOR_MS;
  const stale = source.head !== reviewedHead;
  const when = checked ? `checked ${checked}` : "never checked";
  const base = { stale, verified, head: source.head, checked };
  if (source.state === "merged" || source.state === "closed")
    return {
      ...base,
      status: source.state,
      value: source.state === "merged" ? "Merged" : "Closed",
      note: stale
        ? `New commits landed after this review · ${when}`
        : `No commits after this review · ${when}`,
      tone: stale ? "warn" : "neutral",
    };
  if (stale)
    return {
      ...base,
      status: "stale",
      value: "New commits",
      note: `GitHub head is now ${short(source.head)} · ${when}`,
      tone: "warn",
    };
  if (verified)
    return {
      ...base,
      status: "current",
      value: "Current",
      note: `Head unchanged · ${when}`,
      tone: "good",
    };
  return {
    ...base,
    status: "unverified",
    value: "Not confirmed",
    note: checkError
      ? `Unchanged as of ${checked ?? "an unknown time"} · couldn't reach GitHub`
      : `Unchanged as of ${checked ?? "an unknown time"} · refresh to check`,
    tone: "neutral",
  };
}

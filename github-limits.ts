// Recognize GitHub rate limiting and say when it lifts.
//
// GitHub has separate budgets: "core" (REST, 5,000/hour), "search" (30/minute),
// and "graphql". Pair Review spends core on pull-request lookups and diffs,
// search on queue discovery, and graphql on human feedback.

export interface LimitBucket {
  limit: number;
  remaining: number;
  /** When the bucket refills, as an ISO timestamp. */
  resetAt: string;
}
export interface GitHubLimits {
  core: LimitBucket | null;
  search: LimitBucket | null;
  graphql: LimitBucket | null;
}

/** Whether an error came from GitHub refusing a request for rate limiting. */
export function isRateLimitError(error: unknown) {
  const text = String(error);
  return /\b(?:api )?rate limit (?:exceeded|reached)|secondary rate limit|abuse detection|too many requests|\bHTTP 429\b/i.test(
    text,
  );
}

/**
 * When Pair Review can talk to GitHub again. `resetAt` is the latest refill
 * among the budgets that are used up; `secondary` means none is used up, so
 * GitHub's undocumented short-term ("secondary") limit applied instead.
 */
export function limitStatus(
  limits: GitHubLimits | null,
  nowMs = Date.now(),
): { resetAt: string | null; secondary: boolean } {
  const exhausted = [limits?.core, limits?.search, limits?.graphql].filter(
    (bucket): bucket is LimitBucket =>
      !!bucket && bucket.remaining <= 0 && Date.parse(bucket.resetAt) > nowMs,
  );
  if (!exhausted.length) return { resetAt: null, secondary: true };
  const resetAt = exhausted
    .map((bucket) => bucket.resetAt)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0]!;
  return { resetAt, secondary: false };
}

/** "3:53 PM (in 9 minutes)", or "3:53 PM (in under a minute)". */
export function describeReset(resetAt: string, nowMs = Date.now()) {
  const at = new Date(resetAt);
  const clock = at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const minutes = Math.ceil((at.getTime() - nowMs) / 60_000);
  const wait =
    minutes <= 1
      ? "in under a minute"
      : minutes < 60
        ? `in ${minutes} minutes`
        : `in about ${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? "" : "s"}`;
  return `${clock} (${wait})`;
}

/** Turn `gh api rate_limit` output into the buckets Pair Review cares about. */
export function parseRateLimit(raw: unknown): GitHubLimits {
  const resources = (raw as { resources?: Record<string, unknown> })?.resources;
  const bucket = (value: unknown): LimitBucket | null => {
    const b = value as {
      limit?: unknown;
      remaining?: unknown;
      reset?: unknown;
    };
    if (
      !b ||
      typeof b.limit !== "number" ||
      typeof b.remaining !== "number" ||
      typeof b.reset !== "number"
    )
      return null;
    return {
      limit: b.limit,
      remaining: b.remaining,
      resetAt: new Date(b.reset * 1000).toISOString(),
    };
  };
  return {
    core: bucket(resources?.core),
    search: bucket(resources?.search),
    graphql: bucket(resources?.graphql),
  };
}

// Small on-disk caches that spare GitHub's rate limit.
//
// Every BB request runs in a fresh `node bridge.mjs` process, so anything kept
// only in memory is gone before the next request. These survive on disk.
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Coordinate, PR, type PullRequest } from "./engine/types.ts";
import type { KnownPullRequests } from "./engine/data.ts";
import { atomicJson, hash, json } from "./engine/status.ts";

/** How long a remembered GitHub login is trusted. */
export const LOGIN_TTL_MS = 60 * 60 * 1000;
/** How many compare diffs to keep on disk. */
export const PATCH_CACHE_LIMIT = 40;
/**
 * The longest a saved pull-request lookup is reused, even when GitHub still
 * lists it as unchanged. A safety net, not the main freshness check.
 */
export const KNOWN_PR_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The signed-in GitHub login, remembered per host so queue discovery and
 * display flags do not spend an API call on `gh api user` every request.
 *
 * Never use this for an authorization gate. Resolver, validation, and
 * publication checks must ask GitHub every time, so a switched `gh` account
 * can never act on a stale identity.
 */
export async function cachedLogin(
  github: { login(): Promise<string> },
  dir: string,
  host: string,
  nowMs = Date.now(),
): Promise<string> {
  const path = join(dir, `login-${hash(host).slice(0, 16)}.json`);
  try {
    const saved = json(path);
    const age = nowMs - saved.at;
    if (typeof saved.at === "number" && age >= 0 && age < LOGIN_TTL_MS)
      return Coordinate.parse(saved.login);
  } catch {
    // Missing, unreadable, or invalid: ask GitHub.
  }
  const login = await github.login();
  try {
    atomicJson(path, { at: nowMs, login });
  } catch {
    // A cache that cannot be written must not fail the request.
  }
  return login;
}

/**
 * A compare diff, kept on disk. The key names the exact base and head
 * commits, so the content is immutable and never needs to expire.
 */
export async function cachedPatch(
  dir: string,
  key: string,
  load: () => Promise<string>,
): Promise<string> {
  const path = join(dir, `patch-${hash(key).slice(0, 32)}.json`);
  try {
    const saved = json(path);
    if (typeof saved.patch === "string") return saved.patch;
  } catch {
    // Missing or unreadable: fetch it.
  }
  const patch = await load();
  try {
    atomicJson(path, { patch });
    prunePatches(dir);
  } catch {
    // Best effort only.
  }
  return patch;
}

function prunePatches(dir: string) {
  const files = readdirSync(dir)
    .filter((name) => /^patch-[0-9a-f]+\.json$/.test(name))
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const file of files.slice(PATCH_CACHE_LIMIT)) {
    try {
      unlinkSync(join(dir, file.name));
    } catch {
      // Already gone.
    }
  }
}

/**
 * Pull-request lookups from earlier queue refreshes. Call `save()` after a
 * successful refresh: it keeps only the pull requests that refresh listed, so
 * closed or no-longer-requested ones drop out.
 */
export function knownPullRequests(
  dir: string,
  host: string,
  nowMs = Date.now(),
): KnownPullRequests & { save(): void; hits: number; misses: number } {
  const path = join(dir, `known-prs-${hash(host).slice(0, 16)}.json`);
  type Entry = { listed: string; at: number; target: PullRequest };
  const saved = new Map<string, Entry>();
  try {
    const file = json(path);
    if (file?.version === 1 && file.entries && typeof file.entries === "object")
      for (const [url, value] of Object.entries(file.entries as object)) {
        const entry = value as Partial<Entry>;
        const target = PR.safeParse(entry?.target);
        const age = nowMs - (entry?.at ?? Number.NaN);
        if (
          typeof entry?.listed === "string" &&
          target.success &&
          target.data.url === url &&
          age >= 0 &&
          age < KNOWN_PR_TTL_MS
        )
          saved.set(url, {
            listed: entry.listed,
            at: entry.at!,
            target: target.data,
          });
      }
  } catch {
    // Missing or unreadable: every pull request is looked up.
  }
  const used = new Map<string, Entry>();
  const store = {
    hits: 0,
    misses: 0,
    get(url: string, listedUpdatedAt: string) {
      const entry = saved.get(url);
      if (!entry || entry.listed !== listedUpdatedAt) return undefined;
      used.set(url, entry);
      store.hits += 1;
      // A history entry (previous review) is recomputed by every refresh.
      const { previous: _previous, ...target } = entry.target;
      return target;
    },
    remember(url: string, listedUpdatedAt: string, target: PullRequest) {
      store.misses += 1;
      const { previous: _previous, ...plain } = target;
      used.set(url, { listed: listedUpdatedAt, at: nowMs, target: plain });
    },
    save() {
      try {
        atomicJson(path, { version: 1, entries: Object.fromEntries(used) });
      } catch {
        // Best effort: the next refresh simply looks everything up again.
      }
    },
  };
  return store;
}

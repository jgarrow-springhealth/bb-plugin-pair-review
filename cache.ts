// Small on-disk caches that spare GitHub's rate limit.
//
// Every BB request runs in a fresh `node bridge.mjs` process, so anything kept
// only in memory is gone before the next request. These survive on disk.
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Coordinate } from "./engine/types.ts";
import { atomicJson, hash, json } from "./engine/status.ts";

/** How long a remembered GitHub login is trusted. */
export const LOGIN_TTL_MS = 60 * 60 * 1000;
/** How many compare diffs to keep on disk. */
export const PATCH_CACHE_LIMIT = 40;

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

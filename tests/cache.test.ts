import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOGIN_TTL_MS,
  PATCH_CACHE_LIMIT,
  cachedLogin,
  cachedPatch,
} from "../cache";

let dir = "";
beforeEach(() => {
  // The engine rejects symlinked paths, and macOS temp folders sit behind one.
  dir = mkdtempSync(join(realpathSync(tmpdir()), "pair-review-cache-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const github = (login = "octo-dev") => ({
  login: vi.fn(async () => login),
});

test("a remembered login spares the GitHub call until it expires", async () => {
  const gh = github();
  const start = 1_000_000;
  expect(await cachedLogin(gh, dir, "github.com", start)).toBe("octo-dev");
  expect(await cachedLogin(gh, dir, "github.com", start + 60_000)).toBe(
    "octo-dev",
  );
  expect(gh.login).toHaveBeenCalledTimes(1);
  // Past the TTL it asks GitHub again, and a changed account is picked up.
  const switched = github("someone-else");
  expect(
    await cachedLogin(switched, dir, "github.com", start + LOGIN_TTL_MS + 1),
  ).toBe("someone-else");
  expect(switched.login).toHaveBeenCalledTimes(1);
});

test("logins are remembered per host, and a clock that went backwards is not trusted", async () => {
  const gh = github();
  await cachedLogin(gh, dir, "github.com", 5_000_000);
  await cachedLogin(gh, dir, "github.example.com", 5_000_000);
  expect(gh.login).toHaveBeenCalledTimes(2);
  await cachedLogin(gh, dir, "github.com", 1_000);
  expect(gh.login).toHaveBeenCalledTimes(3);
});

test("a corrupt or tampered login file is ignored, never trusted", async () => {
  const gh = github();
  await cachedLogin(gh, dir, "github.com", 1_000_000);
  const file = readdirSync(dir).find((name) => name.startsWith("login-"))!;
  writeFileSync(join(dir, file), "{not json");
  expect(await cachedLogin(gh, dir, "github.com", 1_000_100)).toBe("octo-dev");
  expect(gh.login).toHaveBeenCalledTimes(2);
  writeFileSync(
    join(dir, file),
    JSON.stringify({ at: 1_000_200, login: "../../etc/passwd" }),
  );
  expect(await cachedLogin(gh, dir, "github.com", 1_000_300)).toBe("octo-dev");
  expect(gh.login).toHaveBeenCalledTimes(3);
});

test("a failing GitHub login is not cached", async () => {
  const failing = {
    login: vi.fn(async () => {
      throw Error("gh: API rate limit exceeded");
    }),
  };
  await expect(cachedLogin(failing, dir, "github.com")).rejects.toThrow(
    "rate limit",
  );
  expect(readdirSync(dir).filter((name) => name.startsWith("login-"))).toEqual(
    [],
  );
});

test("a diff for the same commits is fetched once", async () => {
  const load = vi.fn(async () => "diff --git a/x b/x\n");
  const key = "github.com/acme/app/base111/head222";
  expect(await cachedPatch(dir, key, load)).toBe("diff --git a/x b/x\n");
  expect(await cachedPatch(dir, key, load)).toBe("diff --git a/x b/x\n");
  expect(load).toHaveBeenCalledTimes(1);
  // New commits are a new key, so they are fetched.
  await cachedPatch(dir, "github.com/acme/app/base111/head333", load);
  expect(load).toHaveBeenCalledTimes(2);
});

test("a failed or unreadable diff fetch is retried, not remembered", async () => {
  const key = "github.com/acme/app/b/h";
  const failing = vi.fn(async () => {
    throw Error("Diff exceeds the 4 MiB page limit");
  });
  await expect(cachedPatch(dir, key, failing)).rejects.toThrow("4 MiB");
  expect(readdirSync(dir).filter((name) => name.startsWith("patch-"))).toEqual(
    [],
  );
  const load = vi.fn(async () => "patch");
  await cachedPatch(dir, key, load);
  const file = readdirSync(dir).find((name) => name.startsWith("patch-"))!;
  writeFileSync(join(dir, file), "garbage");
  expect(await cachedPatch(dir, key, load)).toBe("patch");
  expect(load).toHaveBeenCalledTimes(2);
});

test("only the newest diffs are kept on disk", async () => {
  const total = PATCH_CACHE_LIMIT + 5;
  const aged = new Set<string>();
  for (let i = 0; i < total; i++) {
    await cachedPatch(dir, `key-${i}`, async () => `patch ${i}`);
    // Give each new file a distinct, increasing age so "newest" is well defined.
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("patch-") || aged.has(name)) continue;
      aged.add(name);
      const at = new Date(2026, 0, 1, 0, 0, i);
      utimesSync(join(dir, name), at, at);
    }
  }
  const kept = readdirSync(dir).filter((name) => name.startsWith("patch-"));
  expect(kept.length).toBeLessThanOrEqual(PATCH_CACHE_LIMIT);
  // The newest survives and is served without a fetch; the oldest is gone.
  const load = vi.fn(async () => "refetched");
  expect(await cachedPatch(dir, `key-${total - 1}`, load)).toBe(
    `patch ${total - 1}`,
  );
  expect(load).not.toHaveBeenCalled();
  expect(await cachedPatch(dir, "key-0", load)).toBe("refetched");
  expect(load).toHaveBeenCalledTimes(1);
});

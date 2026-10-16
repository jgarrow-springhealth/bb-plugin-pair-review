import { afterEach, beforeEach, expect, test } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub } from "../engine/data";
import { KNOWN_PR_TTL_MS, knownPullRequests } from "../cache";

let dir = "";
beforeEach(() => {
  // The engine rejects symlinked paths, and macOS temp folders sit behind one.
  dir = mkdtempSync(join(realpathSync(tmpdir()), "pair-review-known-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const prUrl = (n: number) => `https://github.com/acme/app/pull/${n}`;
const repo = { full_name: "acme/app", html_url: "https://github.com/acme/app" };
/** A fake `gh` that answers searches and pull-request lookups, counting them. */
function fakeGitHub(listing: Record<string, { n: number; updated: string }[]>) {
  const lookups: number[] = [];
  const exec = async (_command: string, args: string[]) => {
    const path = args[args.length - 1]!;
    const search = path.match(/^search\/issues\?q=([^&]+)/);
    if (search) {
      const query = decodeURIComponent(search[1]!);
      const items = (listing[query] ?? []).map(({ n, updated }) => ({
        html_url: prUrl(n),
        updated_at: updated,
      }));
      return JSON.stringify({
        total_count: items.length,
        incomplete_results: false,
        items,
      });
    }
    const pull = path.match(/^repos\/acme\/app\/pulls\/(\d+)$/);
    if (pull) {
      const n = Number(pull[1]);
      lookups.push(n);
      return JSON.stringify({
        number: n,
        html_url: prUrl(n),
        title: `Change ${n}`,
        updated_at: "2026-10-01T00:00:00Z",
        state: "open",
        draft: false,
        user: { login: "alice-dev" },
        base: { sha: "a".repeat(40), ref: "main", repo },
        head: { sha: String(n % 10).repeat(40), ref: `topic-${n}`, repo },
      });
    }
    throw Error(`Unexpected gh call: ${path}`);
  };
  return { exec, lookups };
}

const requested = "is:pr is:open review-requested:mona-dev";
const authored = "is:pr is:open author:mona-dev";
/** One queue refresh: the same two searches the plugin runs. */
async function refresh(
  listing: Record<string, { n: number; updated: string }[]>,
  nowMs: number,
) {
  const gh = fakeGitHub(listing);
  const github = new GitHub("github.com", gh.exec);
  const known = knownPullRequests(dir, "github.com", nowMs);
  github.known = known;
  const found = [
    ...(await github.discover(0, "mona-dev")),
    ...(await github.discover(2, "mona-dev")),
  ];
  known.save();
  return { found, lookups: gh.lookups, known };
}

const T0 = Date.parse("2026-10-16T12:00:00Z");

test("a refresh with nothing changed looks no pull request up again", async () => {
  const listing = {
    [requested]: [
      { n: 1, updated: "2026-10-16T09:00:00Z" },
      { n: 2, updated: "2026-10-16T10:00:00Z" },
    ],
    [authored]: [{ n: 3, updated: "2026-10-15T08:00:00Z" }],
  };
  const first = await refresh(listing, T0);
  expect(first.lookups.sort()).toEqual([1, 2, 3]);
  const second = await refresh(listing, T0 + 60_000);
  expect(second.lookups).toEqual([]);
  expect(second.known.hits).toBe(3);
  // The reused records are the same pull requests, heads and all.
  expect(second.found.map((t) => [t.number, t.headSha])).toEqual(
    first.found.map((t) => [t.number, t.headSha]),
  );
});

test("only pull requests GitHub lists as updated are looked up", async () => {
  await refresh(
    {
      [requested]: [
        { n: 1, updated: "2026-10-16T09:00:00Z" },
        { n: 2, updated: "2026-10-16T10:00:00Z" },
      ],
    },
    T0,
  );
  const next = await refresh(
    {
      [requested]: [
        { n: 1, updated: "2026-10-16T09:00:00Z" },
        { n: 2, updated: "2026-10-16T11:30:00Z" }, // new commits or comments
        { n: 4, updated: "2026-10-16T11:45:00Z" }, // newly requested
      ],
    },
    T0 + 60_000,
  );
  expect(next.lookups.sort()).toEqual([2, 4]);
});

test("a pull request found by two searches is looked up once", async () => {
  const both = { n: 7, updated: "2026-10-16T09:00:00Z" };
  const result = await refresh({ [requested]: [both], [authored]: [both] }, T0);
  expect(result.lookups).toEqual([7]);
  expect(result.found).toHaveLength(2);
});

test("saved lookups expire after a day even if GitHub lists them unchanged", async () => {
  const listing = {
    [requested]: [{ n: 1, updated: "2026-10-16T09:00:00Z" }],
  };
  await refresh(listing, T0);
  expect((await refresh(listing, T0 + KNOWN_PR_TTL_MS - 1)).lookups).toEqual(
    [],
  );
  expect((await refresh(listing, T0 + KNOWN_PR_TTL_MS + 1)).lookups).toEqual([
    1,
  ]);
});

test("closed or dropped pull requests are pruned from the saved lookups", async () => {
  await refresh(
    {
      [requested]: [
        { n: 1, updated: "2026-10-16T09:00:00Z" },
        { n: 2, updated: "2026-10-16T10:00:00Z" },
      ],
    },
    T0,
  );
  await refresh(
    { [requested]: [{ n: 1, updated: "2026-10-16T09:00:00Z" }] },
    T0 + 60_000,
  );
  const file = readdirSync(dir).find((name) => name.startsWith("known-prs-"))!;
  const saved = JSON.parse(readFileSync(join(dir, file), "utf8"));
  expect(Object.keys(saved.entries)).toEqual([prUrl(1)]);
});

test("tampered or invalid saved lookups are ignored and looked up again", async () => {
  const listing = {
    [requested]: [
      { n: 1, updated: "2026-10-16T09:00:00Z" },
      { n: 2, updated: "2026-10-16T10:00:00Z" },
    ],
  };
  await refresh(listing, T0);
  const file = join(
    dir,
    readdirSync(dir).find((name) => name.startsWith("known-prs-"))!,
  );
  const saved = JSON.parse(readFileSync(file, "utf8"));
  saved.entries[prUrl(1)].target.headSha = "not-a-sha";
  saved.entries[prUrl(2)].target.url = prUrl(99); // record moved to another key
  writeFileSync(file, JSON.stringify(saved));
  expect((await refresh(listing, T0 + 1000)).lookups.sort()).toEqual([1, 2]);
  writeFileSync(file, "{not json");
  expect((await refresh(listing, T0 + 2000)).lookups.sort()).toEqual([1, 2]);
});

test("a refresh that fails part-way saves nothing", async () => {
  const listing = {
    [requested]: [{ n: 1, updated: "2026-10-16T09:00:00Z" }],
  };
  await refresh(listing, T0);
  const gh = fakeGitHub({
    [requested]: [{ n: 2, updated: "2026-10-16T10:00:00Z" }],
  });
  const github = new GitHub("github.com", async (command, args) => {
    if (
      args[args.length - 1]!.startsWith(
        "search/issues?q=is%3Apr%20is%3Aopen%20author",
      )
    )
      throw Error("gh: API rate limit exceeded");
    return gh.exec(command, args);
  });
  const known = knownPullRequests(dir, "github.com", T0 + 1000);
  github.known = known;
  await github.discover(0, "mona-dev");
  await expect(github.discover(2, "mona-dev")).rejects.toThrow("rate limit");
  // The caller never reaches save(): the earlier lookups survive untouched.
  expect((await refresh(listing, T0 + 2000)).lookups).toEqual([]);
});

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub } from "../engine/data";
import {
  claimWindow,
  externalBatchId,
  externalFindings,
  externalRow,
  externalRunId,
  findingCounts,
  listExternalRuns,
  loadExternalRun,
  newestFor,
  parseDbTime,
  probeLive,
  STALE_RUNNING_MS,
  type ExternalRun,
} from "../external-runs";

const NOW = Date.parse("2026-10-20T20:00:00Z");
const ago = (minutes: number) =>
  new Date(NOW - minutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

let dir = "";
let database = "";

function seed() {
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE reviews (id INTEGER PRIMARY KEY, pr_number INTEGER, repository TEXT NOT NULL,
      review_type TEXT DEFAULT 'pr', local_path TEXT, local_head_sha TEXT, local_head_branch TEXT, name TEXT);
    CREATE TABLE pr_metadata (id INTEGER PRIMARY KEY, pr_number INTEGER NOT NULL, repository TEXT NOT NULL,
      title TEXT, author TEXT, base_branch TEXT, head_branch TEXT, pr_data TEXT, host TEXT);
    CREATE TABLE analysis_runs (id TEXT PRIMARY KEY, review_id INTEGER NOT NULL, provider TEXT, model TEXT,
      head_sha TEXT, diff TEXT, summary TEXT, status TEXT NOT NULL, total_suggestions INTEGER DEFAULT 0,
      started_at TIMESTAMP, completed_at TIMESTAMP, parent_run_id TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, source TEXT, ai_run_id TEXT, ai_level INTEGER, is_raw INTEGER DEFAULT 0,
      file TEXT, line_start INTEGER, type TEXT, severity TEXT, title TEXT, body TEXT, suggestion_text TEXT, status TEXT);
  `);
  const review = db.prepare(
    "INSERT INTO reviews (id, pr_number, repository, review_type, local_path, local_head_branch, name) VALUES (?,?,?,?,?,?,?)",
  );
  review.run(1, 10, "Acme/App", "pr", null, null, null);
  review.run(2, 11, "Acme/App", "pr", null, null, null);
  review.run(3, 12, "Acme/App", "pr", null, null, null);
  review.run(4, null, "Acme/App", "local", "/work/app", "my-branch", "Try it");
  review.run(
    5,
    null,
    "Acme/App",
    "local",
    "/home/x/.pair-review/pi-batches/b/analysis",
    "HEAD",
    null,
  );
  db.prepare(
    "INSERT INTO pr_metadata (pr_number, repository, title, author, base_branch, head_branch, pr_data) VALUES (?,?,?,?,?,?,?)",
  ).run(
    10,
    "acme/app",
    "Add widget",
    "dev",
    "main",
    "widget",
    JSON.stringify({
      base: { sha: BASE },
      head: { sha: HEAD },
      changed_files: 3,
      additions: 20,
      deletions: 4,
    }),
  );
  const run = db.prepare(
    `INSERT INTO analysis_runs (id, review_id, provider, model, head_sha, diff, status, total_suggestions, started_at, completed_at, parent_run_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  // review 1: an older finished run, then a newer run still going
  run.run(
    "done-1111",
    1,
    "claude",
    "opus",
    HEAD,
    "diff --git a/x b/x",
    "completed",
    2,
    ago(300),
    ago(290),
    null,
  );
  run.run(
    "live-2222",
    1,
    "claude",
    "opus",
    HEAD,
    null,
    "running",
    0,
    ago(4),
    null,
    null,
  );
  // review 2: BB's own run (claimed by id)
  run.run(
    "bbrun-3333",
    2,
    "pi",
    "gpt",
    HEAD,
    null,
    "completed",
    1,
    ago(100),
    ago(95),
    null,
  );
  // review 2 also has a failed run; review 3 has a run that never finished
  run.run(
    "fail-4444",
    2,
    "pi",
    "gpt",
    HEAD,
    null,
    "failed",
    0,
    ago(200),
    ago(199),
    null,
  );
  run.run(
    "stuck-5555",
    3,
    "pi",
    "gpt",
    HEAD,
    null,
    "running",
    0,
    ago(120),
    null,
    null,
  );
  // a child voice run must never be listed
  run.run(
    "child-6666",
    1,
    "pi",
    "gpt",
    HEAD,
    null,
    "completed",
    0,
    ago(5),
    ago(4),
    "live-2222",
  );
  // local reviews: a user checkout, and one of BB's isolated checkouts
  run.run(
    "local-7777",
    4,
    "pi",
    "gpt",
    HEAD,
    null,
    "completed",
    1,
    ago(50),
    ago(45),
    null,
  );
  run.run(
    "own-8888",
    5,
    "pi",
    "gpt",
    HEAD,
    null,
    "completed",
    1,
    ago(50),
    ago(45),
    null,
  );
  // too old to list
  run.run(
    "old-9999",
    2,
    "pi",
    "gpt",
    HEAD,
    null,
    "completed",
    0,
    ago(60 * 24 * 30),
    ago(60 * 24 * 30 - 5),
    null,
  );
  const comment = db.prepare(
    `INSERT INTO comments (source, ai_run_id, ai_level, is_raw, file, line_start, type, severity, title, body, suggestion_text, status)
     VALUES ('ai', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  comment.run(
    "done-1111",
    1,
    0,
    "raw.ts",
    1,
    "bug",
    "high",
    "raw",
    "raw",
    null,
    "active",
  );
  comment.run(
    "done-1111",
    null,
    0,
    "a.ts",
    7,
    "bug",
    "high",
    "Null deref",
    "Boom",
    "fix it",
    "adopted",
  );
  comment.run(
    "done-1111",
    null,
    0,
    "b.ts",
    null,
    "praise",
    null,
    "Nice",
    "Good",
    null,
    "active",
  );
  db.close();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "external-runs-"));
  database = join(dir, "database.db");
  seed();
});
afterAll(() => undefined);

const options = (over: Record<string, unknown> = {}) => ({
  database,
  hostname: "github.com",
  nowMs: NOW,
  claimed: { runIds: new Set<string>(["bbrun-3333"]), windows: [] },
  ownRoots: ["/home/x/.pair-review"],
  ...over,
});

describe("identifiers and times", () => {
  test("round-trips run ids through the batch id and rejects BB batches", () => {
    expect(externalRunId(externalBatchId("done-1111"))).toBe("done-1111");
    expect(externalRunId("20261019T174123916Z-a3f15c")).toBeNull();
    expect(externalRunId("ext_../../etc")).toBeNull();
  });

  test("reads SQLite's zone-less timestamps as UTC", () => {
    expect(parseDbTime("2026-10-20 20:00:00")).toBe(NOW);
    expect(parseDbTime("2026-10-20T20:00:00.000Z")).toBe(NOW);
    expect(parseDbTime(null)).toBeNull();
    expect(parseDbTime("nonsense")).toBeNull();
  });
});

describe("listExternalRuns", () => {
  test("lists runs BB did not start, with the latest run and latest finished run per review", () => {
    const ids = listExternalRuns(options()).map((r) => r.runId);
    expect(ids).toEqual(
      expect.arrayContaining([
        "live-2222",
        "done-1111",
        "fail-4444",
        "local-7777",
      ]),
    );
    // BB's own run, child voice runs, BB's isolated checkout and stale history stay out.
    for (const hidden of ["bbrun-3333", "child-6666", "own-8888", "old-9999"])
      expect(ids).not.toContain(hidden);
  });

  test("keeps a still-running review beside the earlier run that has findings", () => {
    const runs = listExternalRuns(options());
    expect(runs.filter((r) => r.reviewId === 1).map((r) => r.status)).toEqual([
      "running",
      "completed",
    ]);
  });

  test("hides a run inside the time span of a BB batch for the same PR", () => {
    const key = "github.com/acme/app#12";
    const from = NOW - 130 * 60_000,
      to = NOW - 100 * 60_000;
    const ids = listExternalRuns(
      options({
        claimed: { runIds: new Set(), windows: [claimWindow(key, from, to)] },
      }),
    ).map((r) => r.runId);
    expect(ids).not.toContain("stuck-5555");
    expect(ids).toContain("live-2222");
  });

  test("returns nothing when Pair Review has no database yet", () => {
    expect(
      listExternalRuns(options({ database: join(dir, "missing.db") })),
    ).toEqual([]);
  });

  test("carries PR details and the base commit and size GitHub reported", () => {
    const run = listExternalRuns(options()).find(
      (r) => r.runId === "live-2222",
    )!;
    expect(run).toMatchObject({
      title: "Add widget",
      author: "dev",
      baseSha: BASE,
      changes: { files: 3, additions: 20, deletions: 4 },
    });
  });
});

describe("rows", () => {
  const context = (over: Record<string, unknown> = {}) => ({
    hostname: "github.com",
    nowMs: NOW,
    live: null,
    count: 0,
    dismissed: false,
    submitted: false,
    finalReview: () => false,
    clean: (v: unknown) => String(v ?? ""),
    ...over,
  });
  const find = (id: string) =>
    listExternalRuns(options()).find((r) => r.runId === id) as ExternalRun;

  test("a recent running run is in progress", () => {
    const row = externalRow(find("live-2222"), context());
    expect(row).toMatchObject({
      origin: "external",
      running: true,
      reviewState: "reviewing",
      attention: null,
      subject: "Acme/App #10",
      url: "https://github.com/Acme/App/pull/10",
      key: "github.com/acme/app#10",
      provider: "claude",
    });
    expect(row.id).toBe("ext_live-2222/0");
  });

  test("a run that never finished is flagged unless Pair Review reports it live", () => {
    const stale = find("stuck-5555");
    expect(NOW - stale.startedMs).toBeGreaterThan(STALE_RUNNING_MS);
    const abandoned = externalRow(stale, context());
    expect(abandoned).toMatchObject({
      running: false,
      reviewState: "interrupted",
    });
    expect(abandoned.attention).toMatch(/interrupted/);
    const live = externalRow(
      stale,
      context({ live: [{ analysisId: "a", reviewId: stale.reviewId }] }),
    );
    expect(live).toMatchObject({ running: true, reviewState: "reviewing" });
  });

  test("a finished run reports its findings and whether it is ready for final review", () => {
    const row = externalRow(
      find("done-1111"),
      context({
        count: 2,
        finalReview: (state: string) => state === "findings",
      }),
    );
    expect(row).toMatchObject({
      running: false,
      reviewState: "findings",
      count: 2,
      finalReview: true,
      canResolve: false,
    });
    expect(
      externalRow(find("done-1111"), context({ count: 0 })).reviewState,
    ).toBe("zero_findings");
  });

  test("a failed run needs attention", () => {
    const row = externalRow(find("fail-4444"), context());
    expect(row).toMatchObject({ reviewState: "failed", running: false });
    expect(row.attention).toMatch(/failed/);
  });

  test("a local review gets a branch subject and no PR link", () => {
    const row = externalRow(find("local-7777"), context());
    expect(row).toMatchObject({
      url: null,
      subject: "local branch my-branch",
      title: "Try it",
      key: "branch:/work/app:my-branch",
    });
  });

  test("a dismissed run is not running", () => {
    expect(
      externalRow(find("live-2222"), context({ dismissed: true })).running,
    ).toBe(false);
  });

  test("the PR page prefers the running run, then the newest", () => {
    const rows = [
      externalRow(find("done-1111"), context({ count: 2 })),
      externalRow(find("live-2222"), context()),
    ];
    expect(newestFor(rows, "github.com/acme/app#10")?.id).toBe(
      "ext_live-2222/0",
    );
    expect(newestFor(rows, "github.com/acme/app#99")).toBeUndefined();
  });
});

describe("findings and single runs", () => {
  test("counts and lists only the final findings of a run", () => {
    expect(
      findingCounts(database, ["done-1111", "live-2222"]).get("done-1111"),
    ).toBe(2);
    const found = externalFindings(database, "done-1111");
    expect(found.map((f) => f.title)).toEqual(["Null deref", "Nice"]);
    expect(found[0]).toMatchObject({
      file: "a.ts",
      line: 7,
      suggestion: "fix it",
      status: "adopted",
    });
  });

  test("loads one run with its analyzed diff, and refuses a missing one", () => {
    expect(loadExternalRun(database, "done-1111")?.diff).toContain(
      "diff --git",
    );
    expect(loadExternalRun(database, "missing-run-id")).toBeNull();
  });
});

describe("probeLive", () => {
  const respond = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  test("lists what the Pair Review app is analyzing", async () => {
    await expect(
      probeLive(
        7247,
        respond({
          active: [{ analysisId: "a1", reviewId: 7, repository: "x" }],
        }),
      ),
    ).resolves.toEqual([{ analysisId: "a1", reviewId: 7 }]);
  });

  test("is null when the app is unreachable or answers oddly", async () => {
    await expect(
      probeLive(7247, (async () => {
        throw new Error("refused");
      }) as unknown as typeof fetch),
    ).resolves.toBeNull();
    await expect(probeLive(7247, respond({}, true))).resolves.toBeNull();
    await expect(
      probeLive(7247, respond({ active: [] }, false)),
    ).resolves.toBeNull();
  });
});

describe("queue freshness", () => {
  const pr = (headSha: string) =>
    ({
      kind: "pr",
      host: "github.com",
      owner: "Acme",
      repo: "App",
      number: 10,
      headSha,
    }) as any;

  test("a review finished outside BB marks the PR as reviewed", () => {
    const github = new GitHub("github.com");
    github.external = () =>
      new Map([
        [
          "github.com/acme/app#10",
          { headSha: HEAD, at: "2026-10-20T19:00:00.000Z", model: "opus" },
        ],
      ]);
    const [reviewed] = github.history([pr(HEAD)], join(dir, "no-batches"));
    expect(reviewed.previous).toMatchObject({ headSha: HEAD, model: "opus" });
    expect(
      new GitHub("github.com").history([pr(HEAD)], join(dir, "no-batches"))[0]
        .previous,
    ).toBeUndefined();
  });
});

// Reviews started outside BB: from the Pair Review app in a browser, or from
// `pair-review` in a terminal or Pi session.
//
// Pair Review records every analysis in its shared SQLite database whoever
// started it. This module reads that database, drops the runs BB itself
// started (BB keeps its own batch records for those), and turns the rest into
// the same rows the Pair Review page already renders. It is read-only: it
// never writes to the database and never starts, stops, or changes a review.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ChangeStats, ReviewRow } from "./contract";

export const EXTERNAL_PREFIX = "ext_";
/** Only recent finished runs are listed; running ones are always listed. */
export const EXTERNAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Pair Review marks a run failed after this long without finishing. */
export const STALE_RUNNING_MS = 30 * 60 * 1000;
/** Allowance around a BB batch when deciding that a run was BB's own. */
const CLAIM_SLACK_MS = 60 * 1000;
const MAX_ROWS = 60;
const ZERO_SHA = "0".repeat(40);

export const externalBatchId = (runId: string) => `${EXTERNAL_PREFIX}${runId}`;

/** The Pair Review run id behind a row's batchId, or null for BB's own batches. */
export function externalRunId(batchId: string) {
  if (!batchId.startsWith(EXTERNAL_PREFIX)) return null;
  const runId = batchId.slice(EXTERNAL_PREFIX.length);
  return /^[A-Za-z0-9-]{8,64}$/.test(runId) ? runId : null;
}

/** SQLite's CURRENT_TIMESTAMP is UTC without a zone; ISO strings pass through. */
export function parseDbTime(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const text = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export interface ExternalRun {
  runId: string;
  reviewId: number;
  kind: "pr" | "local";
  provider: string;
  model: string;
  status: "running" | "completed" | "failed" | "cancelled";
  headSha: string | null;
  startedMs: number;
  completedMs: number | null;
  total: number;
  repository: string;
  prNumber: number | null;
  localPath: string | null;
  localBranch: string | null;
  reviewName: string | null;
  title: string | null;
  author: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  host: string | null;
  baseSha: string | null;
  changes: ChangeStats | null;
}

export interface LiveAnalysis {
  analysisId: string;
  reviewId: number | null;
}

/** Runs BB started itself, so they are not "external". */
export interface Claimed {
  /** Run ids recorded by BB batches. */
  runIds: Set<string>;
  /** Time spans in which a BB batch was working on a subject. */
  windows: { key: string; from: number; to: number }[];
}

export interface ExternalOptions {
  database: string;
  hostname: string;
  nowMs: number;
  claimed: Claimed;
  /** Local reviews inside these folders are BB's isolated checkouts. */
  ownRoots: string[];
  windowMs?: number;
}

const inside = (root: string, path: string) => {
  const r = resolve(root),
    p = resolve(path);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
};

export function externalKey(
  run: Pick<
    ExternalRun,
    "kind" | "repository" | "prNumber" | "localPath" | "localBranch"
  >,
  hostname: string,
) {
  return run.kind === "pr"
    ? `${hostname}/${run.repository}#${run.prNumber}`.toLowerCase()
    : `branch:${run.localPath}:${run.localBranch ?? ""}`;
}

const LIGHT_COLUMNS = `
  ar.id AS run_id, ar.review_id, ar.provider, ar.model, ar.status,
  ar.head_sha, ar.total_suggestions, ar.started_at, ar.completed_at,
  r.review_type, r.pr_number, r.repository, r.local_path,
  r.local_head_branch, r.local_head_sha, r.name AS review_name,
  m.title, m.author, m.base_branch, m.head_branch, m.host`;
const FROM = `
  FROM analysis_runs ar
  JOIN reviews r ON r.id = ar.review_id
  LEFT JOIN pr_metadata m
    ON r.review_type = 'pr'
   AND m.pr_number = r.pr_number
   AND m.repository = r.repository COLLATE NOCASE`;

function open(database: string) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 1000");
  } catch {}
  return db;
}

function fromRow(row: any): ExternalRun | null {
  const startedMs = parseDbTime(row.started_at);
  if (startedMs === null || typeof row.run_id !== "string") return null;
  const status = ["running", "completed", "failed", "cancelled"].includes(
    row.status,
  )
    ? (row.status as ExternalRun["status"])
    : null;
  if (!status) return null;
  const kind = row.review_type === "local" ? "local" : "pr";
  if (kind === "pr" && !Number.isInteger(Number(row.pr_number))) return null;
  const head =
    typeof row.head_sha === "string" && /^[a-f0-9]{40}$/.test(row.head_sha)
      ? row.head_sha
      : typeof row.local_head_sha === "string" &&
          /^[a-f0-9]{40}$/.test(row.local_head_sha)
        ? row.local_head_sha
        : null;
  return {
    runId: row.run_id,
    reviewId: Number(row.review_id),
    kind,
    provider: String(row.provider ?? "unknown"),
    model: String(row.model ?? "unknown"),
    status,
    headSha: head,
    startedMs,
    completedMs: parseDbTime(row.completed_at),
    total: Number(row.total_suggestions) || 0,
    repository: String(row.repository ?? ""),
    prNumber: kind === "pr" ? Number(row.pr_number) : null,
    localPath: typeof row.local_path === "string" ? row.local_path : null,
    localBranch:
      typeof row.local_head_branch === "string" ? row.local_head_branch : null,
    reviewName: typeof row.review_name === "string" ? row.review_name : null,
    title: typeof row.title === "string" ? row.title : null,
    author: typeof row.author === "string" ? row.author : null,
    baseBranch: typeof row.base_branch === "string" ? row.base_branch : null,
    headBranch: typeof row.head_branch === "string" ? row.head_branch : null,
    host: typeof row.host === "string" && row.host ? row.host : null,
    baseSha: null,
    changes: null,
  };
}

/** Base commit and size of a PR as GitHub reported them when it was fetched. */
function enrich(db: DatabaseSync, runs: ExternalRun[]) {
  const stmt = db.prepare(
    "SELECT pr_data FROM pr_metadata WHERE repository = ? COLLATE NOCASE AND pr_number = ?",
  );
  for (const run of runs) {
    if (run.kind !== "pr") continue;
    try {
      const data = JSON.parse(
        (stmt.get(run.repository, run.prNumber!) as any)?.pr_data ?? "null",
      );
      if (
        typeof data?.base?.sha === "string" &&
        /^[a-f0-9]{40}$/.test(data.base.sha)
      )
        run.baseSha = data.base.sha;
      if (
        !run.headSha &&
        typeof data?.head?.sha === "string" &&
        /^[a-f0-9]{40}$/.test(data.head.sha)
      )
        run.headSha = data.head.sha;
      if (
        Number.isInteger(data?.changed_files) &&
        Number.isInteger(data?.additions) &&
        Number.isInteger(data?.deletions)
      )
        run.changes = {
          files: data.changed_files,
          additions: data.additions,
          deletions: data.deletions,
        };
    } catch {}
  }
}

export function isClaimed(run: ExternalRun, key: string, claimed: Claimed) {
  return (
    claimed.runIds.has(run.runId) ||
    claimed.windows.some(
      (w) => w.key === key && run.startedMs >= w.from && run.startedMs <= w.to,
    )
  );
}

/** Build claim windows from BB batches: a window per subject, padded a bit. */
export function claimWindow(
  key: string,
  startMs: number,
  endMs: number,
): Claimed["windows"][number] {
  return { key, from: startMs - CLAIM_SLACK_MS, to: endMs + CLAIM_SLACK_MS };
}

/**
 * Runs started outside BB, newest first. Each review contributes its latest
 * run, plus its latest finished run when the latest one did not finish, so a
 * re-review that is still running (or was cancelled) does not hide findings.
 */
export function listExternalRuns(options: ExternalOptions): ExternalRun[] {
  if (!existsSync(options.database)) return [];
  const windowMs = options.windowMs ?? EXTERNAL_WINDOW_MS;
  const db = open(options.database);
  try {
    const rows = db
      .prepare(
        `SELECT ${LIGHT_COLUMNS} ${FROM}
         WHERE ar.parent_run_id IS NULL
         ORDER BY datetime(ar.started_at) DESC, ar.rowid DESC
         LIMIT 500`,
      )
      .all();
    const chosen: ExternalRun[] = [];
    const latest = new Set<number>(),
      finished = new Set<number>();
    for (const raw of rows) {
      const run = fromRow(raw);
      if (!run) continue;
      if (run.host && run.host.toLowerCase() !== options.hostname) continue;
      if (run.status !== "running" && options.nowMs - run.startedMs > windowMs)
        continue;
      if (
        run.kind === "local" &&
        (!run.localPath ||
          options.ownRoots.some((root) => inside(root, run.localPath!)))
      )
        continue;
      if (isClaimed(run, externalKey(run, options.hostname), options.claimed))
        continue;
      const isLatest = !latest.has(run.reviewId);
      const isLatestFinished =
        run.status === "completed" && !finished.has(run.reviewId);
      if (isLatest) latest.add(run.reviewId);
      if (run.status === "completed") finished.add(run.reviewId);
      if (isLatest || isLatestFinished) chosen.push(run);
      if (chosen.length >= MAX_ROWS) break;
    }
    enrich(db, chosen);
    return chosen;
  } finally {
    db.close();
  }
}

/** One run by id, whether or not it would be listed. Null if BB owns it. */
export function loadExternalRun(
  database: string,
  runId: string,
): { run: ExternalRun; summary: string | null; diff: string | null } | null {
  if (!existsSync(database)) return null;
  const db = open(database);
  try {
    const raw = db
      .prepare(
        `SELECT ${LIGHT_COLUMNS}, ar.summary AS run_summary, ar.diff AS run_diff
         ${FROM} WHERE ar.id = ? AND ar.parent_run_id IS NULL`,
      )
      .get(runId) as any;
    const run = raw && fromRow(raw);
    if (!run) return null;
    enrich(db, [run]);
    return {
      run,
      summary: typeof raw.run_summary === "string" ? raw.run_summary : null,
      diff: typeof raw.run_diff === "string" ? raw.run_diff : null,
    };
  } finally {
    db.close();
  }
}

/** Final (consolidated) findings Pair Review recorded for runs. */
export function findingCounts(database: string, runIds: string[]) {
  const counts = new Map<string, number>();
  if (!runIds.length || !existsSync(database)) return counts;
  const db = open(database);
  try {
    const marks = runIds.map(() => "?").join(",");
    for (const row of db
      .prepare(
        `SELECT ai_run_id, COUNT(*) AS n FROM comments
         WHERE source = 'ai' AND ai_level IS NULL AND COALESCE(is_raw, 0) = 0
           AND ai_run_id IN (${marks})
         GROUP BY ai_run_id`,
      )
      .all(...runIds) as any[])
      counts.set(String(row.ai_run_id), Number(row.n));
    return counts;
  } finally {
    db.close();
  }
}

export interface ExternalFinding {
  id: number;
  file: string;
  line: number | null;
  type: string | null;
  severity: string | null;
  title: string | null;
  body: string | null;
  suggestion: string | null;
  status: string | null;
}

export function externalFindings(database: string, runId: string) {
  const db = open(database);
  try {
    return (
      db
        .prepare(
          `SELECT id, file, line_start, type, severity, title, body,
                  suggestion_text, status
           FROM comments
           WHERE source = 'ai' AND ai_run_id = ?
             AND ai_level IS NULL AND COALESCE(is_raw, 0) = 0
           ORDER BY id`,
        )
        .all(runId) as any[]
    ).map((row): ExternalFinding => ({
      id: Number(row.id),
      file: String(row.file ?? ""),
      line: Number.isInteger(row.line_start) ? row.line_start : null,
      type: typeof row.type === "string" ? row.type : null,
      severity: typeof row.severity === "string" ? row.severity : null,
      title: typeof row.title === "string" ? row.title : null,
      body: typeof row.body === "string" ? row.body : null,
      suggestion:
        typeof row.suggestion_text === "string" && row.suggestion_text.trim()
          ? row.suggestion_text
          : null,
      status: typeof row.status === "string" ? row.status : null,
    }));
  } finally {
    db.close();
  }
}

/** The Pair Review app's own list of running analyses. Null if unreachable. */
export async function probeLive(
  port: number,
  fetcher: typeof fetch = fetch,
): Promise<LiveAnalysis[] | null> {
  try {
    const response = await fetcher(
      `http://127.0.0.1:${port}/api/analyses/active`,
      { signal: AbortSignal.timeout(800) },
    );
    if (!response.ok) return null;
    const body: any = await response.json();
    if (!Array.isArray(body?.active)) return null;
    return body.active.flatMap((entry: any) =>
      typeof entry?.analysisId === "string"
        ? [
            {
              analysisId: entry.analysisId,
              reviewId: Number.isInteger(entry.reviewId)
                ? entry.reviewId
                : null,
            },
          ]
        : [],
    );
  } catch {
    return null;
  }
}

/** Progress lines for a run the Pair Review app is analyzing right now. */
export async function liveProgress(
  port: number,
  analysisId: string,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const response = await fetcher(
      `http://127.0.0.1:${port}/api/analyses/${encodeURIComponent(analysisId)}/status`,
      { signal: AbortSignal.timeout(800) },
    );
    if (!response.ok) return [];
    const status: any = await response.json();
    const lines: string[] = [];
    if (typeof status?.progress === "string" && status.progress)
      lines.push(status.progress);
    for (const [level, value] of Object.entries<any>(status?.levels ?? {}))
      if (value && typeof value.progress === "string")
        lines.push(
          `${level === "4" ? "Consolidation" : `Level ${level}`}: ${value.progress}`,
        );
    return lines.slice(0, 12);
  } catch {
    return [];
  }
}

export const isLive = (
  run: Pick<ExternalRun, "reviewId">,
  live: LiveAnalysis[] | null,
) => !!live?.some((entry) => entry.reviewId === run.reviewId);

export interface RowContext {
  hostname: string;
  nowMs: number;
  live: LiveAnalysis[] | null;
  /** Final findings Pair Review recorded for this run. */
  count: number;
  dismissed: boolean;
  submitted: boolean;
  finalReview: (state: string, count: number) => boolean;
  clean: (value: unknown) => string;
}

/** Where the run stands: finished, or still going, or probably abandoned. */
export function runPhase(
  run: ExternalRun,
  ctx: Pick<RowContext, "nowMs" | "live">,
) {
  if (run.status === "running") {
    const age = ctx.nowMs - run.startedMs;
    if (age <= STALE_RUNNING_MS || isLive(run, ctx.live))
      return { state: "reviewing", running: true, attention: null };
    return {
      state: "interrupted",
      running: false,
      attention: `Pair Review started this run ${Math.floor(age / 60000)} minutes ago and has not reported it finished. It was probably interrupted.`,
    };
  }
  if (run.status === "failed")
    return {
      state: "failed",
      running: false,
      attention: "Pair Review recorded this run as failed.",
    };
  if (run.status === "cancelled")
    return { state: "cancelled", running: false, attention: null };
  return { state: "completed", running: false, attention: null };
}

export function externalRow(run: ExternalRun, ctx: RowContext): ReviewRow {
  const phase = runPhase(run, ctx);
  const finished = phase.state === "completed";
  const count = finished ? ctx.count : 0;
  const state = finished ? (count ? "findings" : "zero_findings") : phase.state;
  const key = externalKey(run, ctx.hostname);
  const [owner = "", repo = ""] = run.repository.split("/");
  const pr = run.kind === "pr";
  const batchId = externalBatchId(run.runId);
  const updatedMs = run.completedMs ?? run.startedMs;
  return {
    id: `${batchId}/0`,
    batchId,
    index: 0,
    key,
    title: ctx.clean(
      pr
        ? (run.title ?? `${run.repository} #${run.prNumber}`)
        : (run.reviewName ?? run.localBranch ?? "Local review"),
    ),
    subject: ctx.clean(
      pr
        ? `${run.repository} #${run.prNumber}`
        : `local branch ${run.localBranch ?? ""}`.trim(),
    ),
    url: pr
      ? `https://${ctx.hostname}/${owner}/${repo}/pull/${run.prNumber}`
      : null,
    author: ctx.clean(pr ? (run.author ?? "unknown") : "local"),
    head: run.headSha ?? ZERO_SHA,
    base: run.baseSha ?? ZERO_SHA,
    branch: ctx.clean(pr ? (run.headBranch ?? "") : (run.localBranch ?? "")),
    model: ctx.clean(run.model),
    provider: ctx.clean(run.provider),
    origin: "external",
    updatedAt: new Date(updatedMs).toISOString(),
    attempt: 1,
    reviewState: state,
    resolverState: "not_started",
    count,
    attention: phase.attention,
    resolverError: null,
    path: null,
    owned: false,
    superseded: false,
    dismissed: ctx.dismissed,
    running: !ctx.dismissed && phase.running,
    canRetry: false,
    canAttempt: false,
    canResolve: false,
    canValidate: false,
    publish: false,
    changes: run.changes,
    submitted: ctx.submitted,
    finalReview: ctx.finalReview(state, count),
  };
}

/** The most recent run for a subject, for the PR page. Running beats finished. */
export function newestFor(rows: ReviewRow[], key: string) {
  return rows
    .filter((row) => row.key === key && !row.dismissed)
    .sort(
      (a, b) =>
        Number(b.running) - Number(a.running) ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    )[0];
}

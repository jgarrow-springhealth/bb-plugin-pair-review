import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  accessSync,
  constants as fsConstants,
} from "node:fs";
import { dirname, delimiter, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import {
  Preferences,
  rpcContract,
  type Request,
  type ReviewRow,
  type Snapshot,
  type Details,
  type QueueItem,
  type ChangeStats,
} from "./contract.ts";
import {
  Input,
  Settings,
  Feedback,
  Target,
  keyFor,
  subject,
  type Entry,
  type PullRequest,
} from "./engine/types.ts";
import {
  ROOT,
  privateDir,
  safePath,
  inside,
  atomicJson,
  json,
  hash,
  now,
  recent,
  directory,
  initial,
  readStatus,
  loadInput,
  reviewComplete,
  isSuperseded,
  warnings,
  withLock,
  dismissalId,
  dismissalDirectory,
  loadDismissals,
  setDismissed,
} from "./engine/status.ts";
import {
  GitHub,
  localTarget,
  mapConcurrent,
  parseURL,
  owned,
  unchanged,
} from "./engine/data.ts";
import { run, launch, cancel, cleanEnv } from "./engine/process.ts";
import {
  Envelope,
  verifySaved,
  capabilities,
  inspectPairReviewCapabilities,
  sharedPairReviewRuntime,
} from "./engine/review.ts";
import { recoverInterrupted, health } from "./engine/recovery.ts";
import { Guard } from "./engine/resolver-guard.ts";
import { loginShellOpenAIKey } from "./engine/model-auth.ts";
import { git } from "./engine/git.ts";
import { repositoryLink } from "./repository.ts";
import { latestReviewSelection } from "./pr-details.ts";
import { parseTeams, parseTeammates, requestTag } from "./queue.ts";
export const clean = (s: unknown) =>
  String(s ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
const shortIdentity = (value: unknown) =>
  typeof value === "string" && value ? value.slice(0, 12) : "missing";
type PairReviewExpectedIdentity = {
  version: string | null;
  dbId: string;
  adapterProtocol?: number;
  databaseSchema?: number;
  databaseSnapshot?: number;
  headlessEnvelope?: number;
  healthIdentity?: number;
  buildId?: string;
};
type PairReviewObservedIdentity = {
  service?: unknown;
  version?: unknown;
  dbId?: unknown;
  adapterProtocol?: unknown;
  databaseSchema?: unknown;
  databaseSnapshot?: unknown;
  headlessEnvelope?: unknown;
  healthIdentity?: unknown;
  buildId?: unknown;
};

export function viewerIdentityError(
  port: number,
  expected: PairReviewExpectedIdentity,
  observed: PairReviewObservedIdentity | null,
) {
  if (!observed)
    return `Port ${port} did not return a readable Pair Review identity`;
  const differences: string[] = [];
  if (observed.service !== "pair-review")
    differences.push(`service is ${clean(observed.service) || "unknown"}`);
  if (observed.version !== expected.version)
    differences.push(
      `version is ${clean(observed.version) || "unknown"}, expected ${expected.version ?? "unknown"}`,
    );
  if (observed.dbId !== expected.dbId)
    differences.push(
      `database is ${shortIdentity(observed.dbId)}, expected ${shortIdentity(expected.dbId)}`,
    );
  if (
    expected.adapterProtocol !== undefined &&
    observed.adapterProtocol !== expected.adapterProtocol
  )
    differences.push(
      `adapter protocol is ${clean(observed.adapterProtocol) || "missing"}, expected ${expected.adapterProtocol}`,
    );
  for (const [label, field] of [
    ["database schema", "databaseSchema"],
    ["database snapshot", "databaseSnapshot"],
    ["headless envelope", "headlessEnvelope"],
  ] as const)
    if (
      expected[field] !== undefined &&
      observed[field] !== expected[field]
    )
      differences.push(
        `${label} is ${clean(observed[field]) || "missing"}, expected ${expected[field]}`,
      );
  if (
    expected.healthIdentity !== undefined &&
    observed.healthIdentity !== expected.healthIdentity
  )
    differences.push(
      `health identity is ${clean(observed.healthIdentity) || "missing"}, expected ${expected.healthIdentity}`,
    );
  if (expected.buildId && observed.buildId !== expected.buildId)
    differences.push(
      `build is ${shortIdentity(observed.buildId)}, expected ${shortIdentity(expected.buildId)}`,
    );
  return differences.length
    ? `Port ${port} is already serving a conflicting Pair Review app: ${differences.join("; ")}`
    : null;
}
export function pairReviewGitHubConfigDir(
  runtimeHome: string,
  source: NodeJS.ProcessEnv = process.env,
  authHome = runtimeHome,
) {
  return source.GH_CONFIG_DIR ?? join(authHome, ".config", "gh");
}

export function pairReviewGitCredentialEnv(
  hostname: string,
  token: string,
): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString(
    "base64",
  );
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${hostname.toLowerCase()}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

export async function githubTokenForPairReviewViewer(
  authHome: string,
  hostname: string,
  source: NodeJS.ProcessEnv = process.env,
  exec = run,
) {
  try {
    const token = (
      await exec("gh", ["auth", "token", "--hostname", hostname], {
        env: {
          ...cleanEnv(source),
          HOME: authHome,
          GH_CONFIG_DIR: pairReviewGitHubConfigDir(authHome, source, authHome),
        },
        timeout: 15_000,
      })
    ).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export function pairReviewAppEnv(
  runtime: {
    home: string;
    reviewProvider: string;
    reviewModel: string;
    port: number;
  },
  source: NodeJS.ProcessEnv = process.env,
  loadOpenAIKey = loginShellOpenAIKey,
) {
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(source),
    PAIR_REVIEW_NO_OPEN: "1",
    HOME: runtime.home,
    PORT: String(runtime.port),
    GH_CONFIG_DIR: pairReviewGitHubConfigDir(runtime.home, source),
  };
  if (
    runtime.reviewProvider === "pi" &&
    runtime.reviewModel.startsWith("openai/") &&
    !env.OPENAI_API_KEY
  ) {
    const key = loadOpenAIKey({
      ...source,
      PAIR_BATCH_AUTH_HOME: runtime.home,
    });
    if (key) env.OPENAI_API_KEY = key;
  }
  return env;
}

type PairReviewProbe = {
  ready: boolean;
  observed: PairReviewObservedIdentity | null;
  error: string | null;
};
async function probePairReviewApp(
  port: number,
  expected: PairReviewExpectedIdentity,
): Promise<PairReviewProbe> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
      redirect: "error",
    });
    if (!response.ok)
      return {
        ready: false,
        observed: null,
        error: `health returned HTTP ${response.status}`,
      };
    const value: any = await response.json();
    const observed = {
      service: value.service,
      version: value.version,
      dbId: value.dbId,
      adapterProtocol: value.adapterProtocol,
      databaseSchema: value.databaseSchema,
      databaseSnapshot: value.databaseSnapshot,
      headlessEnvelope: value.headlessEnvelope,
      healthIdentity: value.healthIdentity,
      buildId: value.buildId,
    };
    return {
      ready:
        value.service === "pair-review" &&
        value.version === expected.version &&
        value.dbId === expected.dbId &&
        (expected.adapterProtocol === undefined ||
          value.adapterProtocol === expected.adapterProtocol) &&
        (expected.databaseSchema === undefined ||
          value.databaseSchema === expected.databaseSchema) &&
        (expected.databaseSnapshot === undefined ||
          value.databaseSnapshot === expected.databaseSnapshot) &&
        (expected.headlessEnvelope === undefined ||
          value.headlessEnvelope === expected.headlessEnvelope) &&
        (expected.healthIdentity === undefined ||
          value.healthIdentity === expected.healthIdentity) &&
        (!expected.buildId || value.buildId === expected.buildId),
      observed,
      error: null,
    };
  } catch (error) {
    return { ready: false, observed: null, error: clean(error) };
  }
}
async function portIsFree(port: number) {
  const net = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}
async function ensurePairReviewApp(
  runtime: {
    home: string;
    port: number;
    dbId: string;
    reviewProvider: string;
    reviewModel: string;
  },
  version: string | null,
  executable: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const adapter = await inspectPairReviewCapabilities(executable);
  const expected: PairReviewExpectedIdentity = {
    version,
    dbId: runtime.dbId,
    ...(adapter.contract
      ? {
          adapterProtocol: adapter.contract.adapterProtocol,
          databaseSchema: adapter.contract.databaseSchema,
          databaseSnapshot: adapter.contract.databaseSnapshot,
          headlessEnvelope: adapter.contract.headlessEnvelope,
          healthIdentity: adapter.contract.healthIdentity,
          buildId: adapter.contract.buildId,
        }
      : {}),
  };
  let result = await probePairReviewApp(runtime.port, expected);
  if (result.ready) return;
  if (!(await portIsFree(runtime.port)))
    throw Error(
      viewerIdentityError(runtime.port, expected, result.observed) ??
        `Port ${runtime.port} is unavailable`,
    );
  const child = spawn(process.execPath, [executable], {
    cwd: runtime.home,
    env: { ...pairReviewAppEnv(runtime), ...extraEnv },
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    result = await probePairReviewApp(runtime.port, expected);
    if (result.ready) return;
  }
  throw Error(
    viewerIdentityError(runtime.port, expected, result.observed) ??
      `Pair Review app did not become ready on port ${runtime.port}${result.error ? `: ${result.error}` : ""}`,
  );
}

const LEGACY_VIEWER_PORTS = 20;
export async function selectLegacyPairReviewPort(
  start: number,
  expected: PairReviewExpectedIdentity,
  deps: {
    probe?: typeof probePairReviewApp;
    isFree?: typeof portIsFree;
  } = {},
) {
  const probe = deps.probe ?? probePairReviewApp;
  const isFree = deps.isFree ?? portIsFree;
  for (let offset = 0; offset < LEGACY_VIEWER_PORTS; offset++) {
    const port = start + offset;
    const result = await probe(port, expected);
    if (result.ready) return { port, running: true } as const;
    if (result.observed || !(await isFree(port))) continue;
    return { port, running: false } as const;
  }
  throw Error(
    `No available port was found for the retained Pair Review viewer (${start}-${start + LEGACY_VIEWER_PORTS - 1})`,
  );
}

async function ensureLegacyPairReviewApp(
  preferences: z.infer<typeof Preferences>,
  home: string,
  sharedHome: string,
  sharedPort: number,
  version: string | null,
  executable: string,
) {
  const legacy = sharedPairReviewRuntime(preferences, home);
  if (!inside(join(legacy.home, ".pair-review"), legacy.database))
    throw Error("Retained Pair Review database is outside its legacy home");
  if (!existsSync(legacy.database))
    throw Error("The retained Pair Review database is no longer available");
  const start =
    sharedPort + LEGACY_VIEWER_PORTS < 65536 ? sharedPort + 1 : 7248;
  const adapter = await inspectPairReviewCapabilities(executable);
  const selected = await selectLegacyPairReviewPort(start, {
    version,
    dbId: legacy.dbId,
    ...(adapter.contract
      ? {
          adapterProtocol: adapter.contract.adapterProtocol,
          databaseSchema: adapter.contract.databaseSchema,
          databaseSnapshot: adapter.contract.databaseSnapshot,
          headlessEnvelope: adapter.contract.headlessEnvelope,
          healthIdentity: adapter.contract.healthIdentity,
          buildId: adapter.contract.buildId,
        }
      : {}),
  });
  if (selected.running) return selected.port;
  const githubConfigDir = pairReviewGitHubConfigDir(
    legacy.home,
    process.env,
    sharedHome,
  );
  const githubToken = await githubTokenForPairReviewViewer(
    sharedHome,
    preferences.hostname,
    { ...process.env, GH_CONFIG_DIR: githubConfigDir },
  );
  await ensurePairReviewApp(
    { ...legacy, port: selected.port },
    version,
    executable,
    {
      PORT: String(selected.port),
      GH_CONFIG_DIR: githubConfigDir,
      ...(githubToken
        ? {
            GITHUB_TOKEN: githubToken,
            ...pairReviewGitCredentialEnv(preferences.hostname, githubToken),
          }
        : {}),
    },
  );
  return selected.port;
}

export function retainedPairReviewViewer(
  entry: Pick<Entry, "target" | "review">,
  saved: z.infer<typeof Envelope>,
  runtime: { home: string; dbId: string },
) {
  const uiPath =
    entry.target.kind === "pr"
      ? `${pairReviewPrPath(entry.target)}?runId=${encodeURIComponent(saved.run.id)}`
      : `/local/${saved.run.review_id}?runId=${encodeURIComponent(saved.run.id)}`;
  if (entry.review.uiPath && entry.review.uiPath !== uiPath)
    throw Error("Retained app route does not match the verified review");
  if (!entry.review.home || !entry.review.uiPath)
    throw Error(
      "This legacy review does not retain enough Pair Review metadata to open its native viewer.",
    );
  const retainedHome = realpathSync(safePath(entry.review.home));
  if (!entry.review.dbId)
    return { kind: "legacy" as const, home: retainedHome, uiPath };
  if (retainedHome !== runtime.home || entry.review.dbId !== runtime.dbId)
    throw Error(
      "This review does not belong to the Pair Review database currently configured for BB.",
    );
  return { kind: "shared" as const, uiPath };
}

export function splitPatch(patch: string) {
  return patch
    .split(/(?=^diff --git )/m)
    .filter(Boolean)
    .map((p, i) => {
      const m =
        p.match(/^\+\+\+ b\/(.+)$/m) ?? p.match(/^diff --git a\/(.*?) b\//m);
      return { path: m?.[1] ?? `Change ${i + 1}`, patch: p };
    });
}
export function patchStats(patch: string): ChangeStats {
  let additions = 0,
    deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { files: splitPatch(patch).length, additions, deletions };
}
const MAX_PAGE_PATCH_BYTES = 4 * 1024 * 1024;
const pullRequestPatchCache = new Map<string, string>();
const pullRequestTargetCache = new Map<
  string,
  { target: PullRequest; loadedAt: number }
>();
function boundCache<T>(cache: Map<string, T>) {
  while (cache.size > 20) cache.delete(cache.keys().next().value!);
}
async function currentPullRequest(
  github: GitHub,
  url: string,
  observedHead?: string,
) {
  const cached = pullRequestTargetCache.get(url);
  if (
    cached &&
    Date.now() - cached.loadedAt < 60_000 &&
    (!observedHead || observedHead === cached.target.headSha)
  )
    return cached.target;
  const target = await github.hydrate(url);
  pullRequestTargetCache.set(url, { target, loadedAt: Date.now() });
  boundCache(pullRequestTargetCache);
  return target;
}
async function pullRequestPatch(github: GitHub, target: PullRequest) {
  const key = `${target.host}/${target.owner}/${target.repo}/${target.baseSha}/${target.headSha}`;
  const cached = pullRequestPatchCache.get(key);
  if (cached !== undefined) return cached;
  const patch = await github.diff(target);
  if (Buffer.byteLength(patch, "utf8") > MAX_PAGE_PATCH_BYTES)
    throw Error("Diff exceeds the 4 MiB page limit");
  pullRequestPatchCache.set(key, patch);
  boundCache(pullRequestPatchCache);
  return patch;
}
export function pairReviewPrPath(input: {
  owner: string;
  repo: string;
  number: number;
}) {
  return `/pr/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/${input.number}`;
}
function targetStats(target: Entry["target"]): ChangeStats | null {
  return target.kind === "pr" &&
    Number.isInteger(target.changedFiles) &&
    Number.isInteger(target.additions) &&
    Number.isInteger(target.deletions)
    ? {
        files: target.changedFiles!,
        additions: target.additions!,
        deletions: target.deletions!,
      }
    : null;
}
function commandOnPath(command: string, env: NodeJS.ProcessEnv = process.env) {
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [""];
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        accessSync(
          candidate,
          process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
        );
        return realpathSync(candidate);
      } catch {}
    }
  }
  throw Error(
    `The ${command} command was not found on the BB server PATH. Install @in-the-loop-labs/pair-review or configure a local fork directory.`,
  );
}

export function pairReviewInstallation(
  source: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  let root: string;
  if (source === "pair-review") {
    const executable = commandOnPath(source, env);
    root = dirname(dirname(executable));
  } else {
    root = source.startsWith("~/") ? join(homedir(), source.slice(2)) : source;
    if (!isAbsolute(root))
      throw Error("Use pair-review or an absolute fork directory or ~/ path");
  }
  safePath(root);
  root = realpathSync(root);
  const pkg = json(join(root, "package.json"));
  if (pkg.name !== "@in-the-loop-labs/pair-review")
    throw Error("Selected installation is not @in-the-loop-labs/pair-review");
  const executable = realpathSync(
    safePath(join(root, "bin", "pair-review.js")),
  );
  return {
    root,
    executable,
    version: typeof pkg.version === "string" && pkg.version ? pkg.version : null,
  };
}

export async function forkInfo(source: string) {
  let root =
    source === "pair-review"
      ? source
      : source.startsWith("~/")
        ? join(homedir(), source.slice(2))
        : source;
  let executable =
    source === "pair-review" ? source : join(root, "bin", "pair-review.js");
  let version: string | null = null;
  let repository: ReturnType<typeof repositoryLink> = null;
  try {
    const installation = pairReviewInstallation(source);
    root = installation.root;
    executable = installation.executable;
    version = installation.version;
    try {
      repository = repositoryLink(
        (await git(root, ["remote", "get-url", "origin"])).trim(),
      );
    } catch {}
    const adapter = await inspectPairReviewCapabilities(executable);
    import.meta.resolve("@earendil-works/pi-coding-agent");
    if (Number(process.versions.node.split(".")[0]) < 24)
      throw Error("Node 24+ is required for the retained worker runtime");
    return {
      forkPath: root,
      executable,
      version,
      nodeVersion: process.version,
      ready: true,
      error: null,
      repository,
      adapterProtocol: adapter.contract?.adapterProtocol ?? null,
      databaseSchema: adapter.contract?.databaseSchema ?? null,
      databaseSnapshot: adapter.contract?.databaseSnapshot ?? null,
      headlessEnvelope: adapter.contract?.headlessEnvelope ?? null,
      healthIdentity: adapter.contract?.healthIdentity ?? null,
      capabilities: adapter.contract?.capabilities ?? [],
      buildId: adapter.contract?.buildId ?? null,
      buildCommit: adapter.contract?.buildCommit ?? null,
      dirty: adapter.contract?.dirty ?? null,
      legacyContract: adapter.legacyContract,
    };
  } catch (error) {
    return {
      forkPath: root,
      executable,
      version,
      nodeVersion: process.version,
      ready: false,
      error: clean(error),
      repository,
    };
  }
}
export async function invoke(request: Request) {
  const p = Preferences.parse(request.preferences),
    fork = await forkInfo(p.forkPath),
    runtime = sharedPairReviewRuntime(p),
    effectiveTeams = parseTeams(runtime.teams.join(",")),
    effectiveTeammates = parseTeammates(runtime.teammates.join(",")),
    f = {
      ...fork,
      provider: runtime.reviewProvider,
      reviewModel: runtime.reviewModel,
      resolverProvider: runtime.fixProvider,
      fixModel: runtime.fixModel,
      teams: effectiveTeams,
      teammates: effectiveTeammates,
      port: runtime.port,
      database: "shared" as const,
    };
  const bin = f.executable;
  const settings = Settings.parse({
    ...p,
    executable: bin,
    reviewProvider: runtime.reviewProvider,
    reviewModel: runtime.reviewModel,
    fixProvider: runtime.fixProvider,
    fixModel: runtime.fixModel,
  });
  const github = new GitHub(p.hostname);
  const root = privateDir(ROOT);
  const cachedFeedback = async (target: PullRequest) => {
    const path = join(
      dismissalDirectory(root),
      `feedback-${hash(`${keyFor(target)}:${target.headSha}`).slice(0, 24)}.json`,
    );
    try {
      const cached = json(path);
      if (typeof cached.at === "number" && Date.now() - cached.at < 60_000)
        return Feedback.parse(cached.feedback);
    } catch {}
    const feedback = Feedback.parse(await github.feedback(target));
    atomicJson(path, { at: Date.now(), feedback });
    return feedback;
  };
  let submittedRunCache: Set<string> | null = null;
  const submittedRuns = () => {
    if (submittedRunCache) return submittedRunCache;
    const db = new DatabaseSync(runtime.database, { readOnly: true });
    try {
      submittedRunCache = new Set(
        db
          .prepare(
            `SELECT ar.id
             FROM analysis_runs ar
             JOIN reviews r ON r.id = ar.review_id
             WHERE r.status = 'submitted'
               AND r.submitted_at IS NOT NULL
               AND datetime(ar.completed_at) <= datetime(r.submitted_at)`,
          )
          .all()
          .map((row: any) => String(row.id)),
      );
      return submittedRunCache;
    } finally {
      db.close();
    }
  };
  const nativeSuggestions = (runId: string | undefined) => {
    const byId = new Map<number, string>();
    if (!runId) return byId;
    const db = new DatabaseSync(runtime.database, { readOnly: true });
    try {
      for (const row of db
        .prepare(
          `SELECT id, suggestion_text
           FROM comments
           WHERE ai_run_id = ? AND source = 'ai'`,
        )
        .all(runId) as any[])
        if (
          Number.isInteger(Number(row.id)) &&
          typeof row.suggestion_text === "string" &&
          row.suggestion_text.trim()
        )
          byId.set(Number(row.id), clean(row.suggestion_text));
      return byId;
    } finally {
      db.close();
    }
  };
  const requireFork = () => {
    if (!f.ready) throw Error(f.error ?? "Pair Review installation unavailable");
  };
  const selected = (input: any) => {
    const dir = directory(input.batchId, root),
      s = readStatus(dir),
      e = s.entries[input.index];
    if (!e) throw Error("Review no longer exists");
    return { dir, s, e, input: loadInput(dir) };
  };
  const bound = (input: Input) => {
    requireFork();
    if (input.settings.executable !== bin)
      throw Error(
        "This batch was started with another executable. Start a new review using the configured Pair Review installation.",
      );
  };
  const changesFor = (
    s: ReturnType<typeof readStatus>,
    e: Entry,
  ): ChangeStats | null => {
    let changes = targetStats(e.target);
    try {
      const dir = directory(s.batchId, root);
      if (
        typeof e.review.path === "string" &&
        inside(join(dir, "reviews"), safePath(e.review.path))
      ) {
        const patchFile = safePath(join(e.review.path, "diff.patch"));
        if (
          inside(join(dir, "reviews"), patchFile) &&
          statSync(patchFile).size <= 4 * 1024 * 1024
        )
          changes = patchStats(readFileSync(patchFile, "utf8"));
      }
    } catch {}
    return changes;
  };
  const row = (
    s: ReturnType<typeof readStatus>,
    e: Entry,
    index: number,
    input: Input,
    dismissed = false,
  ): ReviewRow => {
    const same = input.settings.executable === bin,
      superseded = isSuperseded(e, s);
    const resultPath =
      typeof e.resolver.result === "string"
        ? e.resolver.result
        : e.resolver.path
          ? join(e.resolver.path, "..", "result.json")
          : "";
    let resolverResult: any = null;
    try {
      resolverResult = resultPath ? json(resultPath) : null;
    } catch {}
    let hasFeedback = false;
    try {
      hasFeedback =
        !!e.feedbackFile &&
        Feedback.parse(json(e.feedbackFile)).comments.length > 0;
    } catch {}
    return {
      id: `${s.batchId}/${index}`,
      batchId: s.batchId,
      index,
      key: e.key,
      title: clean(e.target.title),
      subject: subject(e.target) + (s.name ? ` · ${clean(s.name)}` : ""),
      url: e.target.kind === "pr" ? e.target.url : null,
      author: e.target.kind === "pr" ? e.target.author : "local",
      head: e.target.headSha,
      base: e.target.baseSha,
      branch: e.target.kind === "pr" ? e.target.headBranch : e.target.branch,
      model: String(e.review.model ?? input.settings.reviewModel),
      updatedAt: s.updatedAt,
      attempt: e.attempt,
      reviewState: e.review.state,
      resolverState: e.resolver.state,
      count:
        e.review.count ??
        [...(resolverResult?.rounds ?? [])]
          .reverse()
          .find((round: any) => round.review)?.review?.count ??
        0,
      attention:
        (e.attention?.reason ?? e.review.error)
          ? clean(e.attention?.reason ?? e.review.error)
          : null,
      resolverError: e.resolver.error ? clean(e.resolver.error) : null,
      path:
        e.resolver.path ??
        (typeof e.review.checkout === "string"
          ? e.review.checkout
          : e.review.path) ??
        null,
      owned: e.target.kind === "branch" || owned(e.target, input.login),
      superseded,
      dismissed,
      running:
        !dismissed &&
        !superseded &&
        (s.state === "running" || s.state === "queued"),
      canRetry: false,
      canAttempt: same && !superseded && !!e.attention,
      canResolve:
        same &&
        !superseded &&
        owned(e.target, input.login) &&
        !["running", "queued"].includes(s.state) &&
        !(
          Array.isArray(resolverResult?.changed) &&
          resolverResult.changed.length > 0
        ) &&
        ((reviewComplete(e) && (e.review.count ?? 0) > 0) || hasFeedback),
      canValidate:
        same &&
        !superseded &&
        !!e.attention &&
        resolverResult?.converged === true &&
        Array.isArray(resolverResult?.changed) &&
        resolverResult.changed.length > 0 &&
        !!resultPath &&
        existsSync(safePath(resultPath)),
      publish: input.settings.publish && e.target.kind === "pr",
      changes: changesFor(s, e),
      submitted:
        typeof e.review.runId === "string" &&
        submittedRuns().has(e.review.runId),
    };
  };
  const snapshot = async (): Promise<Snapshot> => {
    const rows: ReviewRow[] = [],
      notes: string[] = [],
      dismissed = loadDismissals(root).entries;
    for (const s of recent(root).slice(0, 100)) {
      try {
        const input = loadInput(directory(s.batchId, root));
        notes.push(...warnings(s));
        if (["running", "queued"].includes(s.state))
          notes.push(...(await health(directory(s.batchId, root))));
        for (let i = s.entries.length - 1; i >= 0 && rows.length < 300; i--)
          rows.push(
            row(
              s,
              s.entries[i],
              i,
              input,
              dismissalId(s.batchId, i) in dismissed,
            ),
          );
      } catch (e) {
        notes.push(clean(e));
      }
    }
    let queue: QueueItem[] = [];
    try {
      const cache = json(join(root, "bb-queue.json"));
      if (
        cache.hostname === p.hostname &&
        JSON.stringify(cache.teams ?? []) === JSON.stringify(effectiveTeams) &&
        JSON.stringify(cache.teammates ?? []) ===
          JSON.stringify(effectiveTeammates)
      )
        queue = cache.items.map((item: any) => ({
          ...item,
          branch: typeof item.branch === "string" ? item.branch : "",
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
          changes:
            Number.isInteger(item.changes?.files) &&
            Number.isInteger(item.changes?.additions) &&
            Number.isInteger(item.changes?.deletions)
              ? item.changes
              : null,
        }));
    } catch {}
    return { rows, queue, warnings: notes, updatedAt: now(), health: f };
  };
  const payload = request.payload ?? {};
  switch (request.operation) {
    case "snapshot":
      return snapshot();
    case "refresh": {
      const login = await github.login();
      const tags = new Map<string, Set<string>>(),
        targets = new Map<string, any>();
      const add = (t: any, tag: string) => {
        const key = keyFor(t);
        targets.set(key, t);
        if (!tags.has(key)) tags.set(key, new Set());
        tags.get(key)!.add(tag);
        if (t.draft) tags.get(key)!.add("Draft");
      };
      const direct = await github.discover(0, login, root);
      const teamRequests = (
        await Promise.all(
          effectiveTeams.map((team) => github.discoverTeam(team, root)),
        )
      ).flat();
      const teamKeys = new Set(teamRequests.map((t) => keyFor(t)));
      // Team provenance wins when GitHub's review-requested search also returns
      // a request inherited through one of the user's configured teams.
      for (const t of teamRequests)
        add(t, requestTag(t.author, effectiveTeammates, true));
      for (const t of direct)
        if (!teamKeys.has(keyFor(t)))
          add(t, requestTag(t.author, effectiveTeammates));
      for (const t of await github.discover(2, login, root)) add(t, "Authored");
      const assigned: any = await github.api(
        `search/issues?q=${encodeURIComponent(`is:pr is:open assignee:${login}`)}&per_page=100`,
      );
      if (assigned.incomplete_results || assigned.total_count > 100)
        throw Error(
          "Assigned PR discovery is incomplete; no partial queue was saved",
        );
      for (const t of await mapConcurrent(assigned.items, 4, (x: any) =>
        github.hydrate(x.html_url),
      ))
        add(t, "Assigned");
      const items = github.history([...targets.values()], root).map((t) => ({
        key: keyFor(t),
        url: t.url,
        title: clean(t.title),
        subject: subject(t),
        author: t.author,
        head: t.headSha,
        branch: t.headBranch,
        updatedAt: t.updatedAt ?? null,
        tags: [...tags.get(keyFor(t))!],
        freshness: !t.previous
          ? "not_reviewed"
          : !t.previous.headSha
            ? "unknown"
            : t.previous.headSha === t.headSha
              ? "current"
              : "stale",
        previousAt: t.previous?.at ?? null,
        previousModel: t.previous?.model ?? null,
        changes: targetStats(t),
      }));
      atomicJson(join(root, "bb-queue.json"), {
        hostname: p.hostname,
        teams: effectiveTeams,
        teammates: effectiveTeammates,
        items,
        at: now(),
      });
      return snapshot();
    }
    case "preview": {
      const q = rpcContract.preview.input.parse(payload);
      if (!q.local) throw Error("Local checkout required");
      if (!isAbsolute(q.local.path))
        throw Error("Use an absolute local checkout path");
      const t = await localTarget(q.local.path, q.local.branch, q.local.base);
      return { base: t.base, head: t.headSha, baseSha: t.baseSha };
    }
    case "start": {
      requireFork();
      const q = rpcContract.start.input.parse(payload);
      await ensurePairReviewApp(runtime, f.version, bin);
      let targets: Input["targets"];
      let login = "local-user";
      if (q.local) {
        if (!isAbsolute(q.local.path))
          throw Error("Use an absolute local checkout path");
        if (q.urls.length)
          throw Error("Choose URLs or a local checkout, not both");
        const t = await localTarget(q.local.path, q.local.branch, q.local.base);
        if (
          q.local.expectedHead !== t.headSha ||
          q.local.expectedBase !== t.baseSha
        )
          throw Error(
            "Local refs changed or resolved base has not been confirmed",
          );
        targets = [t];
      } else {
        if (!q.urls.length) throw Error("Choose at least one PR");
        login = await github.login();
        targets = await mapConcurrent(
          [...new Set(q.urls)],
          p.preparationConcurrency,
          (u) => github.hydrate(u),
        );
        targets = [...new Map(targets.map((t) => [keyFor(t), t])).values()];
      }
      return withLock(root, async () => {
        for (const s of recent(root))
          if (
            ["running", "queued"].includes(s.state) &&
            s.entries.some((e) => targets.some((t) => keyFor(t) === e.key))
          )
            throw Error("A live batch already contains this review subject");
        const batchId =
            now().replace(/[-:.]/g, "") + "-" + randomBytes(3).toString("hex"),
          dir = directory(batchId, root);
        for (const sub of [
          "logs",
          "reviews",
          "resolvers",
          "feedback",
          "actions",
          "checkouts",
        ])
          privateDir(join(dir, sub));
        const input = Input.parse({
          version: 1,
          batchId,
          name: q.name?.trim() || undefined,
          createdAt: now(),
          login,
          settings: {
            ...settings,
            publish: q.local ? false : settings.publish,
          },
          targets,
          origin: "BB Pair Review page",
        });
        atomicJson(join(dir, "input.json"), input);
        atomicJson(join(dir, "status.json"), initial(input));
        await launch(dir);
        return { batchId };
      });
    }
    case "prDetails": {
      const q = rpcContract.prDetails.input.parse(payload);
      const coordinate = parseURL(q.url, p.hostname);
      const key =
        `${coordinate.host}/${coordinate.owner}/${coordinate.repo}#${coordinate.number}`.toLowerCase();
      let tags: string[] = [],
        observedHead: string | undefined;
      try {
        const cache = json(join(root, "bb-queue.json"));
        if (cache.hostname === p.hostname) {
          const item = (cache.items as any[]).find((x) => x.key === key);
          if (Array.isArray(item?.tags))
            tags = item.tags.filter((tag: unknown) => typeof tag === "string");
          if (typeof item?.head === "string") observedHead = item.head;
        }
      } catch {}
      const target = github.history(
        [await currentPullRequest(github, q.url, observedHead)],
        root,
      )[0];
      const pr: QueueItem = {
        key: keyFor(target),
        url: target.url,
        title: clean(target.title),
        subject: subject(target),
        author: target.author,
        head: target.headSha,
        branch: target.headBranch,
        updatedAt: target.updatedAt ?? null,
        tags,
        freshness: !target.previous
          ? "not_reviewed"
          : !target.previous.headSha
            ? "unknown"
            : target.previous.headSha === target.headSha
              ? "current"
              : "stale",
        previousAt: target.previous?.at ?? null,
        previousModel: target.previous?.model ?? null,
        changes: targetStats(target),
      };
      let patches: Details["patches"] = [],
        patchError: string | null = null;
      try {
        patches = splitPatch(await pullRequestPatch(github, target));
      } catch (error) {
        patchError = clean(error);
      }
      let feedback: Details["feedback"] = {
        complete: false,
        error: "Human feedback could not be loaded",
        comments: [],
      };
      let canResolve = false;
      try {
        const value = await cachedFeedback(target);
        feedback = {
          complete: true,
          error: null,
          comments: value.comments.map((comment) => ({
            author: clean(comment.author),
            body: clean(comment.body),
            location: clean(comment.location),
            disposition: null,
            reason: null,
          })),
        };
        const login = await github.login();
        canResolve = owned(target, login) && value.comments.length > 0;
      } catch (error) {
        feedback.error = clean(error);
      }
      // Resolve saved/running work only. Viewing a PR must never invoke launch().
      return {
        pr,
        review: latestReviewSelection(
          recent(root),
          key,
          new Set(Object.keys(loadDismissals(root).entries)),
        ),
        patches,
        patchError,
        feedback,
        canResolve,
      };
    }
    case "details": {
      const q = rpcContract.details.input.parse(payload),
        v = selected(q);
      const { e, s, input, dir } = v;
      let suggestions: any[] = [],
        patches: Details["patches"] = [],
        capturedPatch: string | null = null,
        retainedPatch = false,
        changes = changesFor(s, e);
      let summary = "Analysis has not produced a verified result yet.";
      try {
        if (
          typeof e.review.path === "string" &&
          inside(join(dir, "reviews"), safePath(e.review.path))
        ) {
          const patchFile = safePath(join(e.review.path, "diff.patch"));
          if (!inside(join(dir, "reviews"), patchFile))
            throw Error("Diff outside batch");
          if (statSync(patchFile).size > 4 * 1024 * 1024)
            throw Error("Diff exceeds the 4 MiB page limit");
          capturedPatch = readFileSync(patchFile, "utf8");
          retainedPatch = true;
          changes = patchStats(capturedPatch);
        }
      } catch {}
      if (capturedPatch === null && e.target.kind === "pr")
        try {
          capturedPatch = await pullRequestPatch(github, e.target);
          changes = patchStats(capturedPatch);
        } catch {}
      if (capturedPatch !== null) patches = splitPatch(capturedPatch);
      if (reviewComplete(e)) {
        const out = verifySaved(
          e.review.path!,
          e.target,
          e.review.file!,
          e.review.digest!,
        );
        suggestions = out.suggestions;
        if (!retainedPatch)
          throw Error(
            "The exact captured diff is unavailable; inspect the retained review directory",
          );
        const submitted =
          typeof e.review.runId === "string" &&
          submittedRuns().has(e.review.runId);
        summary = out.count
          ? submitted
            ? `${out.count} finding${out.count === 1 ? "" : "s"} in the exact reviewed changes. Pair Review records this review as submitted to GitHub.`
            : `${out.count} finding${out.count === 1 ? "" : "s"} in the exact reviewed changes. These results are local; nothing has been submitted to GitHub.`
          : submitted
            ? "No findings were reported for the exact reviewed changes. Pair Review records this review as submitted to GitHub."
            : "No findings were reported for the exact reviewed changes.";
      }
      let result: any = null;
      if (e.resolver.path)
        try {
          if (!inside(join(dir, "resolvers"), safePath(e.resolver.path)))
            throw Error("Resolver outside batch");
          result = json(join(e.resolver.path, "..", "result.json"));
        } catch {}
      if (!reviewComplete(e) && result?.rounds?.length) {
        const latest = [...result.rounds]
          .reverse()
          .find((round: any) => round.review)?.review;
        if (latest) {
          const target = Target.parse(latest.target);
          const out = verifySaved(
            latest.path,
            target,
            latest.file,
            latest.digest,
          );
          suggestions = out.suggestions;
          summary = result.converged
            ? `The manually started resolver loop converged after ${result.roundsCompleted} round${result.roundsCompleted === 1 ? "" : "s"}. No initial Pair Review analysis was required.`
            : `The manually started resolver loop stopped after ${result.roundsCompleted} round${result.roundsCompleted === 1 ? "" : "s"} with ${out.count} outstanding finding${out.count === 1 ? "" : "s"}.`;
        }
      }
      let guard: Guard | undefined;
      try {
        if (
          typeof e.review.checkout === "string" &&
          inside(dir, e.review.checkout)
        )
          guard = new Guard(e.review.checkout);
      } catch {}
      const savedSuggestions = new Map<number, string>();
      try {
        const snapshot = json(join(e.review.path!, "run-snapshot.json"));
        for (const comment of snapshot.comments ?? [])
          if (
            Number.isInteger(Number(comment.id)) &&
            typeof comment.suggestion_text === "string" &&
            comment.suggestion_text.trim()
          )
            savedSuggestions.set(
              Number(comment.id),
              clean(comment.suggestion_text),
            );
      } catch {}
      const liveSuggestions = nativeSuggestions(e.review.runId);
      const findings = suggestions.map((x, i) => {
        let sourcePath: string | null = null;
        try {
          sourcePath = guard?.path(x.file) ?? null;
        } catch {}
        const disposition = [...(result?.dispositions ?? [])]
          .reverse()
          .find(
            (d: any) =>
              d.task?.source === "pair_review" &&
              d.task?.originalFindingIndex === i,
          );
        return {
          id: i,
          file: clean(x.file),
          title: clean(x.title ?? "Finding"),
          body: clean(x.description ?? x.body ?? x.message ?? x.title ?? ""),
          line: Number.isInteger(x.line_start)
            ? x.line_start
            : Number.isInteger(x.line)
              ? x.line
              : null,
          sourcePath,
          kind: typeof x.type === "string" ? clean(x.type) : null,
          severity: typeof x.severity === "string" ? clean(x.severity) : null,
          suggestion:
            typeof x.suggestion === "string" && x.suggestion.trim()
              ? clean(x.suggestion)
              : (savedSuggestions.get(Number(x.id)) ??
                liveSuggestions.get(Number(x.id)) ??
                null),
          disposition: disposition?.state ?? null,
          reason: disposition?.reason ?? null,
        };
      });
      let activity: string[] = [];
      if (e.resolver.transcript)
        try {
          if (!inside(join(dir, "resolvers"), safePath(e.resolver.transcript)))
            throw Error("Transcript outside batch");
          activity = tail(e.resolver.transcript);
        } catch (error) {
          activity = [clean(error)];
        }
      if (
        !e.feedbackFile &&
        !["running", "queued"].includes(s.state) &&
        e.target.kind === "pr"
      )
        try {
          const snapshot = await cachedFeedback(e.target);
          e.feedbackFile = join(
            dir,
            "feedback",
            `${hash(e.key).slice(0, 16)}-${e.attempt}.json`,
          );
          atomicJson(e.feedbackFile, snapshot);
          delete e.feedbackError;
          const latest = readStatus(dir);
          if (latest.entries[q.index]) {
            latest.entries[q.index].feedbackFile = e.feedbackFile;
            delete latest.entries[q.index].feedbackError;
            atomicJson(join(dir, "status.json"), latest);
          }
        } catch (error) {
          e.feedbackError = clean(error);
        }
      let feedback: Details["feedback"] = {
        complete: false,
        error: e.feedbackError ?? "No complete feedback snapshot was captured",
        comments: [],
      };
      if (e.feedbackFile)
        try {
          const path = safePath(e.feedbackFile);
          if (!inside(join(dir, "feedback"), path))
            throw Error("Feedback outside batch");
          const value = json(path);
          feedback = {
            complete: value.complete === true,
            error: null,
            comments: value.comments.map((c: any, feedbackIndex: number) => {
              const disposition = [...(result?.dispositions ?? [])]
                .reverse()
                .find(
                  (d: any) =>
                    d.task?.source === "human_feedback" &&
                    d.task?.feedbackIndex === feedbackIndex,
                );
              return {
                author: clean(c.author),
                body: clean(c.body),
                location: clean(c.location),
                disposition: disposition?.state ?? null,
                reason: disposition?.reason ?? null,
              };
            }),
          };
        } catch (error) {
          feedback.error = clean(error);
        }
      return {
        row: row(
          s,
          e,
          q.index,
          input,
          dismissalId(s.batchId, q.index) in loadDismissals(root).entries,
        ),
        summary,
        changes,
        findings,
        patches,
        briefing: {
          available: false,
          state: "unavailable",
          head: null,
          file: null,
          hostId: null,
          stale: false,
          error: null,
          updatedAt: null,
        },
        activity,
        feedback,
      };
    }
    case "resolverStart": {
      requireFork();
      const q = rpcContract.resolverStart.input.parse(payload);
      const maxRounds = q.maxRounds ?? p.resolverMaxRounds;
      const prepareAction = (dir: string, index: number) =>
        atomicJson(join(dir, "actions", "resolver-loop.json"), {
          confirmed: true,
          index,
          maxRounds,
          at: now(),
        });

      if ("url" in q) {
        const login = await github.login();
        const target = await github.hydrate(q.url);
        if (!owned(target, login))
          throw Error("Resolver loops are available only for PRs you authored");
        const feedback = Feedback.parse(await github.feedback(target));
        if (!feedback.comments.length)
          throw Error("This PR has no human feedback to resolve");
        return withLock(root, async () => {
          for (const live of recent(root))
            if (
              ["running", "queued"].includes(live.state) &&
              live.entries.some((entry) => entry.key === keyFor(target))
            )
              throw Error("A live batch already contains this pull request");
          const batchId =
              now().replace(/[-:.]/g, "") +
              "-" +
              randomBytes(3).toString("hex"),
            dir = directory(batchId, root);
          for (const sub of [
            "logs",
            "reviews",
            "resolvers",
            "feedback",
            "actions",
            "checkouts",
          ])
            privateDir(join(dir, sub));
          const resolverInput = Input.parse({
            version: 1,
            batchId,
            createdAt: now(),
            login,
            settings,
            targets: [target],
            origin: "BB manual resolver loop",
          });
          const status = initial(resolverInput);
          status.state = "complete";
          status.entries[0].review = { state: "not_run" };
          status.entries[0].resolver = { state: "not_started" };
          status.entries[0].feedbackFile = join(
            dir,
            "feedback",
            `${hash(status.entries[0].key).slice(0, 16)}-1.json`,
          );
          atomicJson(status.entries[0].feedbackFile, feedback);
          atomicJson(join(dir, "input.json"), resolverInput);
          atomicJson(join(dir, "status.json"), status);
          prepareAction(dir, 0);
          await launch(dir, "resolve-loop", 0);
          return { batchId, index: 0 };
        });
      }

      const v = selected(q);
      bound(v.input);
      if (["running", "queued"].includes(v.s.state))
        await recoverInterrupted(v.dir);
      const latest = readStatus(v.dir);
      if (["running", "queued"].includes(latest.state))
        throw Error("Batch is still running");
      const entry = latest.entries[q.index];
      if (!entry || isSuperseded(entry, latest))
        throw Error("Review is no longer eligible");
      const login =
        entry.target.kind === "pr" ? await github.login() : v.input.login;
      if (!owned(entry.target, login))
        throw Error(
          "Resolver loops are limited to local branches and PRs you authored",
        );
      if (entry.target.kind === "pr") {
        unchanged(entry.target, await github.hydrate(entry.target.url));
        const feedback = Feedback.parse(await github.feedback(entry.target));
        entry.feedbackFile = join(
          v.dir,
          "feedback",
          `${hash(entry.key).slice(0, 16)}-${entry.attempt}.json`,
        );
        atomicJson(entry.feedbackFile, feedback);
        delete entry.feedbackError;
        if (!feedback.comments.length && (entry.review.count ?? 0) === 0)
          throw Error(
            "There are no Pair Review findings or human comments to resolve",
          );
      } else if ((entry.review.count ?? 0) === 0) {
        throw Error("There are no Pair Review findings to resolve");
      }
      atomicJson(join(v.dir, "status.json"), latest);
      prepareAction(v.dir, q.index);
      await launch(v.dir, "resolve-loop", q.index);
      return { batchId: v.s.batchId, index: q.index };
    }
    case "action": {
      const q = rpcContract.action.input.parse(payload),
        v = selected(q);
      if (["cancel", "validate", "dismiss"].includes(q.action) && !q.confirmed)
        throw Error("Explicit confirmation is required");
      if (["dismiss", "restore"].includes(q.action)) {
        const lock = dismissalDirectory(root);
        await withLock(lock, async () => {
          const latest = readStatus(v.dir),
            entry = latest.entries[q.index];
          if (!entry) throw Error("Review no longer exists");
          if (
            !isSuperseded(entry, latest) &&
            ["running", "queued"].includes(latest.state)
          )
            throw Error("A running review cannot be dismissed");
          setDismissed(
            root,
            latest.batchId,
            q.index,
            entry,
            q.action === "dismiss",
          );
        });
        return { accepted: true };
      }
      if (q.action === "cancel") {
        await cancel(v.dir);
        return { accepted: true };
      }
      if (q.action === "recover") {
        await recoverInterrupted(v.dir);
        return { accepted: true };
      }
      bound(v.input);
      if (["running", "queued"].includes(v.s.state))
        await recoverInterrupted(v.dir);
      const latest = readStatus(v.dir);
      if (["running", "queued"].includes(latest.state))
        throw Error("Batch is still running");
      if (q.action === "validate") {
        const e = latest.entries[q.index];
        if (!e?.resolver.path || !e.attention)
          throw Error("No retained fixes awaiting validation");
        safePath(e.resolver.path);
        if (!inside(join(v.dir, "resolvers"), e.resolver.path))
          throw Error("Resolver outside batch");
        const result = json(join(e.resolver.path, "..", "result.json"));
        atomicJson(join(v.dir, "actions", "validation.json"), {
          key: e.key,
          attempt: e.attempt,
          head: e.target.headSha,
          resultDigest: hash(JSON.stringify(result)),
          confirmed: true,
          at: now(),
        });
      }
      await launch(
        v.dir,
        q.action === "validate" ? "validated" : q.action,
        q.index,
      );
      return { accepted: true };
    }
    case "openFork": {
      requireFork();
      const q = rpcContract.openFork.input.parse(payload);
      if ("url" in q) {
        const coordinate = parseURL(q.url, p.hostname);
        await ensurePairReviewApp(runtime, f.version, bin);
        return {
          url: `http://localhost:${runtime.port}${pairReviewPrPath(coordinate)}`,
        };
      }
      const { e } = selected(q);
      if (!reviewComplete(e)) {
        await ensurePairReviewApp(runtime, f.version, bin);
        const path = e.target.kind === "pr" ? pairReviewPrPath(e.target) : "/";
        return { url: `http://localhost:${runtime.port}${path}` };
      }
      const saved = verifySaved(
        e.review.path!,
        e.target,
        e.review.file!,
        e.review.digest!,
      );
      const viewer = retainedPairReviewViewer(e, saved, runtime);
      if (viewer.kind === "legacy") {
        if (!inside(e.review.path!, viewer.home))
          throw Error(
            "Retained Pair Review home is outside its review directory",
          );
        const port = await ensureLegacyPairReviewApp(
          p,
          viewer.home,
          runtime.home,
          runtime.port,
          f.version,
          bin,
        );
        return { url: `http://localhost:${port}${viewer.uiPath}` };
      }
      await ensurePairReviewApp(runtime, f.version, bin);
      return { url: `http://localhost:${runtime.port}${viewer.uiPath}` };
    }
  }
}
function tail(path: string) {
  const fd = openSync(safePath(path), "r");
  try {
    const size = fstatSync(fd).size,
      start = Math.max(0, size - 256 * 1024),
      b = Buffer.alloc(size - start);
    readSync(fd, b, 0, b.length, start);
    const lines = b.toString("utf8").split("\n");
    if (start) lines.shift();
    lines.pop();
    const result: string[] = [];
    for (const line of lines)
      try {
        const e = JSON.parse(line),
          m = e.message;
        if (e.type === "message_end" && m?.role === "assistant") {
          const text = (m.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join(" ");
          if (text) result.push("Assistant: " + clean(text).slice(0, 1000));
        } else if (e.type === "tool_execution_start")
          result.push("Tool: " + clean(e.toolName));
        else if (e.type === "tool_execution_end")
          result.push(
            clean(e.toolName) +
              ": " +
              clean(
                (e.result?.content ?? [])
                  .map((c: any) => c.text ?? "")
                  .join(" "),
              ).slice(0, 600),
          );
      } catch {}
    return result.slice(-12);
  } finally {
    closeSync(fd);
  }
}

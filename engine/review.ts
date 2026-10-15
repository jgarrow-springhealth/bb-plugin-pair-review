import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { run, cleanEnv, type Run } from "./process.ts";
import { git } from "./git.ts";
import {
  atomicJson,
  privateDir,
  json,
  hash,
  text,
  safePath,
} from "./status.ts";
import { Sha, type Target, type Settings } from "./types.ts";
export const Envelope = z.object({
  ok: z.literal(true),
  mode: z.enum(["pr", "local"]),
  consolidation: z.enum(["success", "skipped", "failed"]).nullable(),
  run: z
    .object({
      id: z.string().min(1),
      review_id: z.number().int().positive(),
      head_sha: Sha,
      status: z.literal("completed"),
      repository: z.string().optional(),
      provider: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      model: z.string().min(1),
      level_outcomes: z.record(z.string(), z.string()),
    })
    .passthrough(),
  suggestions: z.array(
    z.object({ file: z.string(), title: z.string().optional() }).passthrough(),
  ),
  count: z.number().int().nonnegative(),
});
export const PairReviewAdapterContract = z
  .object({
    service: z.literal("pair-review"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    buildId: z.string().regex(/^[0-9a-f]{64}$/),
    buildCommit: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
    dirty: z.boolean().nullable(),
    adapterProtocol: z.literal(1),
    databaseSchema: z.number().int().min(55).max(56),
    databaseSnapshot: z.literal(1),
    headlessEnvelope: z.literal(1),
    healthIdentity: z.literal(1),
    capabilities: z.array(z.string()),
  })
  .passthrough();
export type PairReviewAdapterContract = z.infer<
  typeof PairReviewAdapterContract
>;
export const REQUIRED_PAIR_REVIEW_CAPABILITIES = [
  "delegated-headless",
  "headless-json",
  "local-mode",
  "port-override",
  "pr-mode",
  "run-id-routes",
] as const;

// Pair Review versions released before the machine-readable contract are kept
// on a narrow, exact-build fallback. Their adapter-boundary file hash must match
// the published build below; a version string alone is never sufficient. Any
// newer build must satisfy the protocol/schema/capability contract.
export const VERIFIED_PAIR_REVIEW_VERSIONS = ["5.2.3", "5.3.4"] as const;
const verifiedPairReviewVersions = new Set<string>(
  VERIFIED_PAIR_REVIEW_VERSIONS,
);
const LEGACY_BUILD_FILES = [
  "package.json",
  "bin/pair-review.js",
  "src/database.js",
  "src/headless/delegate.js",
  "src/main.js",
  "src/server.js",
  "src/routes/analyses.js",
  "src/routes/local.js",
  "src/routes/pr.js",
  "src/routes/reviews.js",
  "src/routes/setup.js",
] as const;
export const VERIFIED_LEGACY_PAIR_REVIEW_BUILDS: Record<string, string> = {
  "5.2.3": "ff42dd0002f8706ff2f84bd9584c4e412821b2551f8fab9c693ed05ca3c1d9f6",
  "5.3.4": "63669903fe000cafd4dce7d729470431b302fdfd6896ae67a44495d7e1814d78",
};
function legacyPairReviewBuildId(executable: string) {
  const root = dirname(dirname(realpathSync(executable)));
  const digest = createHash("sha256");
  for (const relativePath of LEGACY_BUILD_FILES) {
    digest.update(relativePath);
    digest.update("\0");
    digest.update(readFileSync(join(root, relativePath)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

export async function inspectPairReviewCapabilities(
  executable: string,
  exec: Run = run,
  deps: { legacyBuildId?: (executable: string) => string } = {},
) {
  const versionLabel = (await exec(executable, ["--version"])).trim();
  const version = versionLabel.match(/^pair-review v(\d+\.\d+\.\d+)$/)?.[1];
  if (!version) throw Error(`Unsupported Pair Review version output: ${versionLabel}`);

  let contract: PairReviewAdapterContract | null = null;
  let rawContract: string | null = null;
  try {
    rawContract = await exec(executable, ["--adapter-contract", "--json"]);
  } catch (error) {
    if (!verifiedPairReviewVersions.has(version))
      throw Error(
        `Pair Review ${version} did not provide an adapter protocol: ${error instanceof Error ? error.message : String(error)}`,
      );
    let buildId: string;
    try {
      buildId = (deps.legacyBuildId ?? legacyPairReviewBuildId)(executable);
    } catch (identityError) {
      throw Error(
        `Pair Review ${version} has no adapter protocol and its legacy build identity could not be verified: ${identityError instanceof Error ? identityError.message : String(identityError)}`,
      );
    }
    if (buildId !== VERIFIED_LEGACY_PAIR_REVIEW_BUILDS[version])
      throw Error(
        `Pair Review ${version} has no adapter protocol and build ${buildId} is not the audited legacy build.`,
      );
  }
  if (rawContract !== null) {
    let parsed: any;
    try {
      parsed = JSON.parse(rawContract);
    } catch (error) {
      throw Error(
        `Pair Review ${version} returned malformed adapter JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (parsed?.adapterProtocol !== 1)
      throw Error(
        `Pair Review adapter protocol ${parsed?.adapterProtocol ?? "missing"} is unsupported; expected 1.`,
      );
    if (parsed?.databaseSchema > 56)
      throw Error(
        `Pair Review database schema ${parsed.databaseSchema} is newer than the adapter's verified maximum 56.`,
      );
    if (parsed?.databaseSchema < 55)
      throw Error(
        `Pair Review database schema ${parsed.databaseSchema} is older than the adapter's verified minimum 55.`,
      );
    for (const [field, expected] of [
      ["databaseSnapshot", 1],
      ["headlessEnvelope", 1],
      ["healthIdentity", 1],
    ] as const)
      if (parsed?.[field] !== expected)
        throw Error(
          `Pair Review ${field} ${parsed?.[field] ?? "missing"} is unsupported; expected ${expected}.`,
        );
    try {
      contract = PairReviewAdapterContract.parse(parsed);
    } catch (error) {
      throw Error(
        `Pair Review ${version} returned an invalid adapter protocol: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (contract) {
    if (contract.version !== version)
      throw Error(
        `Pair Review adapter contract version ${contract.version} does not match executable version ${version}`,
      );
    const missing = REQUIRED_PAIR_REVIEW_CAPABILITIES.filter(
      (capability) => !contract!.capabilities.includes(capability),
    );
    if (missing.length)
      throw Error(
        `Pair Review adapter contract is missing capabilities: ${missing.join(", ")}`,
      );
  }

  const help = await exec(executable, ["--help"]);
  for (const flag of ["--headless", "--json", "--scope", "--provider"])
    if (!help.includes(flag)) throw Error(`Pair Review missing ${flag}`);
  return {
    version,
    versionLabel,
    contract,
    legacyContract: contract === null,
  };
}

export async function capabilities(
  executable: string,
  exec: Run = run,
  deps: { legacyBuildId?: (executable: string) => string } = {},
) {
  return (await inspectPairReviewCapabilities(executable, exec, deps)).versionLabel;
}
export function argumentsFor(
  t: Target,
  settings: Settings,
  checkout: string,
  instructions?: string,
) {
  return [
    ...(t.kind === "pr"
      ? [t.url]
      : [
          "--local",
          checkout,
          "--scope",
          "branch..unstaged",
          "--base",
          t.baseSha,
        ]),
    "--headless",
    "--json",
    "--provider",
    settings.reviewProvider,
    "--model",
    settings.reviewModel,
    ...(instructions ? ["--instructions", instructions] : []),
  ];
}
export function verifyOutput(
  raw: unknown,
  t: Target,
  diff: string,
  stored: any,
  review: any,
  prData?: any,
) {
  const out = Envelope.parse(raw);
  if (
    out.mode !== (t.kind === "pr" ? "pr" : "local") ||
    out.run.head_sha !== t.headSha ||
    out.count !== out.suggestions.length ||
    !["success", "skipped"].includes(out.consolidation ?? "") ||
    Object.entries(out.run.level_outcomes).some(
      ([k, v]) => k.startsWith("level") && !["success", "skipped"].includes(v),
    )
  )
    throw Error("Degraded or unverifiable analysis mode/head/count");
  if (
    stored?.id !== out.run.id ||
    stored.review_id !== out.run.review_id ||
    stored.head_sha !== t.headSha ||
    stored.status !== "completed" ||
    stored.provider !== out.run.provider ||
    stored.model !== out.run.model ||
    stored.diff !== diff ||
    review?.id !== out.run.review_id ||
    review.review_type !== (t.kind === "pr" ? "pr" : "local")
  )
    throw Error("Stored run identity, mode, head, or exact diff mismatch");
  if (
    t.kind === "pr" &&
    (review.repository?.toLowerCase() !==
      `${t.owner}/${t.repo}`.toLowerCase() ||
      review.pr_number !== t.number ||
      prData?.head_sha !== t.headSha ||
      prData?.base_sha !== t.baseSha)
  )
    throw Error("Stored remote identity mismatch");
  if (t.kind === "branch" && review.local_head_sha !== t.headSha)
    throw Error("Stored local head mismatch");
  return out;
}
const PairReviewPiSettings = z
  .object({
    reviewModel: z.string().optional(),
    fixModel: z.string().optional(),
    teams: z.array(z.string()).max(20).default([]),
    teammates: z.array(z.string()).max(100).default([]),
  })
  .passthrough();
const configuredList = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(/[\s,]+/).filter(Boolean)
      : [];

export function sharedPairReviewRuntime(
  fallback: Pick<
    Settings,
    "reviewProvider" | "reviewModel" | "fixProvider" | "fixModel"
  > & {
    teams?: string | string[];
    teammates?: string | string[];
  },
  home = homedir(),
) {
  const configDir = join(home, ".pair-review");
  let config: Record<string, unknown> = {};
  for (const name of ["config.json", "config.local.json"]) {
    const path = join(configDir, name);
    if (existsSync(path)) config = { ...config, ...json(path) };
  }
  const nativeSettings = {
    reviewProvider: fallback.reviewProvider,
    reviewModel: fallback.reviewModel,
    fixProvider: fallback.fixProvider,
    fixModel: fallback.fixModel,
    teams: configuredList(fallback.teams),
    teammates: configuredList(fallback.teammates),
  };
  const piSettingsPath = join(configDir, "pi-settings.json");
  if (existsSync(piSettingsPath)) {
    const parsed = PairReviewPiSettings.parse(json(piSettingsPath));
    nativeSettings.teams = parsed.teams;
    nativeSettings.teammates = parsed.teammates;
  }
  const port = z
    .number()
    .int()
    .min(1)
    .max(65535)
    .catch(7247)
    .parse(config.port);
  const dbName =
    typeof config.db_name === "string" && config.db_name
      ? config.db_name
      : "database.db";
  const database = safePath(join(configDir, dbName));
  return {
    home: realpathSync(home),
    configDir,
    database,
    dbId: hash(database),
    port,
    ...nativeSettings,
  };
}

export function databaseSnapshot(database: string, runId: string) {
  const db = new DatabaseSync(safePath(database), { readOnly: true });
  try {
    const stored = db
      .prepare("SELECT * FROM analysis_runs WHERE id = ?")
      .get(runId);
    if (!stored) throw Error("Stored run missing");
    const review = db
      .prepare("SELECT * FROM reviews WHERE id = ?")
      .get(stored.review_id as number);
    const metadata =
      review &&
      db
        .prepare(
          "SELECT * FROM pr_metadata WHERE repository = ? COLLATE NOCASE AND pr_number = ?",
        )
        .get(review.repository as string, review.pr_number as number);
    let comments: any[] = [];
    try {
      comments = db
        .prepare(
          `SELECT id, ai_run_id, file, title, body, suggestion_text, type, severity
           FROM comments
           WHERE ai_run_id = ? AND source = 'ai'`,
        )
        .all(runId) as any[];
    } catch {}
    return {
      stored,
      review,
      comments,
      prData: metadata ? JSON.parse(metadata.pr_data as string) : undefined,
    };
  } finally {
    db.close();
  }
}
export async function analyze(
  dir: string,
  t: Target,
  settings: Settings,
  prep: { bare: string; checkout: string; diff: string },
  exec: Run = run,
  signal?: AbortSignal,
  instructions?: string,
) {
  await capabilities(settings.executable, exec);
  const runtime = sharedPairReviewRuntime(
    settings,
    settings.pairReviewHome ?? homedir(),
  );
  const effectiveSettings = {
    ...settings,
    reviewProvider: runtime.reviewProvider,
    reviewModel: runtime.reviewModel,
    fixProvider: runtime.fixProvider,
    fixModel: runtime.fixModel,
  };
  const cwd = privateDir(join(dir, "trusted"));
  // Use Pair Review's normal HOME, configuration, provider, and database. With
  // --no-server omitted, a compatible running app executes the analysis and
  // exposes its live progress; the CLI falls back to the same shared database.
  const env = { ...cleanEnv(), HOME: runtime.home };
  const output = await exec(
    settings.executable,
    argumentsFor(t, effectiveSettings, prep.checkout, instructions),
    {
      cwd,
      env,
      signal,
      timeout: 1800000,
      log: join(dir, "stderr.log"),
      stdoutFile: join(dir, "stdout.json"),
    },
  );
  text(join(dir, "stdout.json"), output);
  const raw = JSON.parse(output);
  const out = Envelope.parse(raw);
  const snapshot = databaseSnapshot(runtime.database, out.run.id);
  const comments = new Map(
    snapshot.comments.map((comment: any) => [Number(comment.id), comment]),
  );
  raw.suggestions = raw.suggestions.map((suggestion: any) => {
    const comment = comments.get(Number(suggestion.id));
    if (
      !comment ||
      comment.ai_run_id !== out.run.id ||
      comment.file !== suggestion.file ||
      comment.title !== suggestion.title
    )
      return suggestion;
    return {
      ...suggestion,
      suggestion:
        typeof comment.suggestion_text === "string"
          ? comment.suggestion_text
          : null,
    };
  });
  atomicJson(join(dir, "run-snapshot.json"), snapshot);
  const verified = verifyOutput(
    raw,
    t,
    prep.diff,
    snapshot.stored,
    snapshot.review,
    snapshot.prData,
  );
  if (
    verified.run.provider !== runtime.reviewProvider ||
    (runtime.reviewProvider === "pi" &&
      verified.run.model !== runtime.reviewModel)
  )
    throw Error("Pair Review used an unexpected provider or model");
  atomicJson(join(dir, "review.json"), verified);
  return {
    state: verified.count ? ("findings" as const) : ("zero_findings" as const),
    count: verified.count,
    runId: verified.run.id,
    file: join(dir, "review.json"),
    digest: hash(JSON.stringify(verified)),
    home: runtime.home,
    database: runtime.database,
    dbId: runtime.dbId,
    port: runtime.port,
    uiPath:
      t.kind === "pr"
        ? `/pr/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/${t.number}?runId=${encodeURIComponent(verified.run.id)}`
        : `/local/${verified.run.review_id}?runId=${encodeURIComponent(verified.run.id)}`,
    model: verified.run.model,
  };
}
export async function analyzeResolverRound(
  dir: string,
  original: Target,
  settings: Settings,
  checkout: string,
  exec: Run = run,
  signal?: AbortSignal,
  instructions?: string,
) {
  const headSha = Sha.parse(
    (await git(checkout, ["rev-parse", "HEAD"], exec)).trim(),
  );
  const mergeBase = Sha.parse(
    (
      await git(checkout, ["merge-base", original.baseSha, "HEAD"], exec)
    ).trim(),
  );
  // Pair Review's branch..unstaged local scope uses these exact flags and 25
  // context lines. The independently captured value is checked against its DB
  // snapshot by analyze().
  const diff = await git(
    checkout,
    [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--no-relative",
      "--full-index",
      "--unified=25",
      mergeBase,
    ],
    exec,
  );
  if (!diff.trim()) throw Error("Resolver loop has no changes to review");
  text(join(dir, "diff.patch"), diff);
  const target: Target = {
    kind: "branch",
    repoRoot: checkout,
    branch: "HEAD",
    base: original.baseSha,
    baseSha: original.baseSha,
    headSha,
    title: `resolver loop for ${original.title}`,
  };
  const result = await analyze(
    dir,
    target,
    settings,
    { bare: "", checkout, diff },
    exec,
    signal,
    instructions,
  );
  return { ...result, target, diff };
}

export function verifySaved(
  dir: string,
  t: Target,
  file: string,
  digest: string,
) {
  if (realpathSync(file) !== safePath(join(dir, "review.json")))
    throw Error("Review artifact path mismatch");
  const raw = json(file);
  if (hash(JSON.stringify(raw)) !== digest)
    throw Error("Review artifact digest mismatch");
  const snap = json(join(dir, "run-snapshot.json"));
  return verifyOutput(
    raw,
    t,
    readFileSync(safePath(join(dir, "diff.patch")), "utf8"),
    snap.stored,
    snap.review,
    snap.prData,
  );
}

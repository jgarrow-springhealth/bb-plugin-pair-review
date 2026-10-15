import { z } from "zod";
export const Sha = z.string().regex(/^[a-f0-9]{40}$/);
export const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
export const Branch = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (s) =>
      !s.startsWith("-") &&
      !/[\s~^:?*\[\\\x00-\x1f]/.test(s) &&
      !s.includes("..") &&
      !s.includes("@{") &&
      !s.endsWith(".lock") &&
      !s.endsWith("/") &&
      !s.includes("//"),
    "Invalid branch",
  );
export const Host = z
  .string()
  .regex(/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z0-9]+$/)
  .refine((s) => !s.endsWith("."));
export const Coordinate = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/)
  .refine((s) => s !== "." && s !== "..");
// GitHub App authors use a literal [bot] suffix, unlike repository coordinates.
export const Actor = Coordinate.or(
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\[bot\]$/),
);
export const PR = z.object({
  kind: z.literal("pr"),
  host: Host,
  owner: Coordinate,
  repo: Coordinate,
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string().max(10000),
  author: Actor,
  baseBranch: Branch,
  baseSha: Sha,
  headBranch: Branch,
  headSha: Sha,
  headRepo: z.string(),
  updatedAt: z.string().datetime().optional(),
  draft: z.boolean().optional(),
  changedFiles: z.number().int().nonnegative().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  previous: z
    .object({ headSha: Sha.optional(), at: z.string(), model: z.string() })
    .optional(),
});
export const Local = z.object({
  kind: z.literal("branch"),
  branch: Branch,
  base: Branch,
  baseSha: Sha,
  headSha: Sha,
  repoRoot: z.string(),
  title: z.string(),
});
export const Target = z.discriminatedUnion("kind", [PR, Local]);
export type Target = z.infer<typeof Target>;
export type PullRequest = z.infer<typeof PR>;
export const Settings = z.object({
  version: z.literal(1).default(1),
  reviewProvider: z
    .enum([
      "pi",
      "claude",
      "codex",
      "copilot",
      "opencode",
      "cursor-agent",
      "antigravity",
      "omp",
      "muse",
    ])
    .default("pi"),
  reviewModel: z
    .string()
    .regex(/^[\w./:+-]+$/)
    .default("openai/gpt-5"),
  fixProvider: z.enum(["pi", "claude", "codex"]).default("pi"),
  fixModel: z
    .string()
    .regex(/^[\w./:+-]+$/)
    .default("openai/gpt-5"),
  reviewThinking: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
    .default("medium"),
  fixThinking: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
    .default("medium"),
  // Kept in retained input compatibility only. Resolution is always a
  // separately confirmed manual action.
  resolve: z.boolean().default(false),
  resolverMaxRounds: z.number().int().min(1).max(5).default(3),
  publish: z.boolean().default(false),
  feedback: z.boolean().default(true),
  hideReviewed: z.boolean().default(true),
  preparationConcurrency: z.number().int().min(1).max(16).default(4),
  resolverConcurrency: z.number().int().min(1).max(8).default(2),
  executable: z
    .string()
    .min(1)
    .refine((s) => !/[\x00-\x1f]/.test(s))
    .default("pair-review"),
  // Internal test seam. The BB preferences contract never exposes this path.
  pairReviewHome: z.string().min(1).optional(),
  hostname: Host.default("github.com"),
});
export type Settings = z.infer<typeof Settings>;
export const Phase = z.enum([
  "queued",
  "preparing",
  "reviewing",
  "findings",
  "zero_findings",
  "failed",
  "interrupted",
  "cancelled",
  "needs_attention",
  "pending",
  "disabled",
  "not_started",
  "not_run",
  "resolving",
  "publishing",
  "resolved_local",
  "published",
  "no_changes",
  "skipped_not_authored_by_user",
  "skipped",
]);
export const Work = z
  .object({
    state: Phase,
    error: z.string().optional(),
    pid: z.number().int().positive().optional(),
    path: z.string().optional(),
    runId: z.string().optional(),
    file: z.string().optional(),
    digest: z.string().optional(),
    count: z.number().int().nonnegative().optional(),
    uiPath: z.string().optional(),
    home: z.string().optional(),
    transcript: z.string().optional(),
    session: z.string().optional(),
  })
  .passthrough();
export const Attention = z.object({
  reason: z.string(),
  reviewedSha: Sha,
  remoteSha: Sha.optional(),
  branch: z.string(),
  path: z.string().optional(),
  at: z.string(),
});
export const Entry = z
  .object({
    key: z.string(),
    target: Target,
    attempt: z.number().int().positive().default(1),
    review: Work,
    resolver: Work,
    attention: Attention.optional(),
    feedbackFile: z.string().optional(),
    feedbackError: z.string().optional(),
  })
  .passthrough();
export type Entry = z.infer<typeof Entry>;
export const Status = z
  .object({
    version: z.number().int().min(1),
    batchId: Id,
    name: z.string().optional(),
    state: z.enum([
      "queued",
      "running",
      "complete",
      "failed",
      "cancelled",
      "needs_attention",
    ]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    heartbeatAt: z.string().datetime().optional(),
    coordinatorPid: z.number().int().positive().optional(),
    entries: z.array(Entry),
  })
  .passthrough();
export type Status = z.infer<typeof Status>;
export const Input = z.object({
  version: z.literal(1),
  batchId: Id,
  name: z.string().max(160).optional(),
  createdAt: z.string().datetime(),
  login: Coordinate,
  settings: Settings,
  targets: z.array(Target).min(1),
  origin: z.string(),
});
export type Input = z.infer<typeof Input>;
export const Feedback = z.object({
  complete: z.literal(true),
  comments: z
    .array(
      z.object({
        author: z.string(),
        body: z.string().max(100000),
        location: z.string(),
        url: z.string().url().optional(),
      }),
    )
    .max(1000),
});
export type Feedback = z.infer<typeof Feedback>;
export const terminal = (s: string) =>
  !["queued", "preparing", "reviewing", "resolving", "publishing"].includes(s);
export const keyFor = (t: Target) =>
  t.kind === "pr"
    ? `${t.host}/${t.owner}/${t.repo}#${t.number}`.toLowerCase()
    : `branch:${t.repoRoot}:${t.branch}`;
export const subject = (t: Target) =>
  t.kind === "pr"
    ? `${t.owner}/${t.repo} #${t.number}`
    : `local branch ${t.branch} (base ${t.base})`;

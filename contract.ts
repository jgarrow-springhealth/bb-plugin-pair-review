import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseTeams, parseTeammates } from "./queue.ts";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const thinking = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const forkPath = z
  .string()
  .min(1, "Enter pair-review or a Pair Review fork directory")
  .max(2048, "Pair Review installation must be at most 2048 characters")
  .refine(
    (value) => !/[\x00-\x1f\x7f]/.test(value),
    "Pair Review installation cannot contain control characters",
  )
  .refine(
    (value) =>
      value === "pair-review" ||
      value.startsWith("~/") ||
      value.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      /^\\\\[^\\]/.test(value),
    "Use pair-review for the installed app, or an absolute fork directory or ~/ path",
  );
const hostname = z
  .string()
  .regex(
    /^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z0-9]+$/,
    "Use a lowercase hostname such as github.com (without https://)",
  );
const reviewProvider = z.enum([
  "pi",
  "claude",
  "codex",
  "copilot",
  "opencode",
  "cursor-agent",
  "antigravity",
  "omp",
  "muse",
]);
const resolverProvider = z.enum(["pi", "claude", "codex"]);
const model = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w./:+-]+$/, "Use a model identifier supported by the selected provider");
export const Preferences = z
  .object({
    forkPath,
    hostname,
    reviewProvider,
    reviewModel: model,
    fixProvider: resolverProvider,
    fixModel: model,
    reviewThinking: thinking,
    fixThinking: thinking,
    resolverMaxRounds: z.number().int().min(1).max(5),
    publish: z.boolean(),
    feedback: z.boolean(),
    hideReviewed: z.boolean(),
    teams: z
      .string()
      .max(4096)
      .refine((s) => {
        try {
          parseTeams(s);
          return true;
        } catch {
          return false;
        }
      }, "Teams must be OWNER/TEAM, at most 20"),
    teammates: z
      .string()
      .max(4096)
      .refine((s) => {
        try {
          parseTeammates(s);
          return true;
        } catch {
          return false;
        }
      }, "Use valid GitHub handles, at most 100"),
    preparationConcurrency: z.number().int().min(1).max(16),
  })
  .strict();
export type Preferences = z.infer<typeof Preferences>;
export const DEFAULT_PREFERENCES: Preferences = {
  forkPath: "pair-review",
  hostname: "github.com",
  reviewProvider: "pi",
  reviewModel: "openai/gpt-5",
  fixProvider: "pi",
  fixModel: "openai/gpt-5",
  reviewThinking: "medium",
  fixThinking: "medium",
  resolverMaxRounds: 3,
  publish: false,
  feedback: true,
  hideReviewed: true,
  teams: "",
  teammates: "",
  preparationConcurrency: 4,
};
const selection = z
  .object({ batchId: id, index: z.number().int().nonnegative() })
  .strict();
const reviewInput = z
  .object({
    urls: z.array(z.string().max(2048)).max(200).default([]),
    name: z
      .string()
      .max(160)
      .refine(
        (s) => [...s].length <= 80,
        "Batch name is limited to 80 Unicode characters",
      )
      .refine(
        (s) => !/[\x00-\x1f\x7f-\x9f]/.test(s),
        "Batch name cannot contain controls",
      )
      .optional(),
    local: z
      .object({
        path: z.string().max(2048),
        branch: z.string().max(255),
        base: z.string().max(255).optional(),
        expectedBase: sha.optional(),
        expectedHead: sha.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export interface ReviewRow {
  id: string;
  batchId: string;
  index: number;
  key: string;
  title: string;
  subject: string;
  url: string | null;
  author: string;
  head: string;
  base: string;
  branch: string;
  model: string;
  /** Pair Review provider that ran an external review; BB's own use settings. */
  provider?: string;
  /** "external" for a run started outside BB (Pair Review app or terminal). */
  origin?: "bb" | "external";
  updatedAt: string;
  attempt: number;
  reviewState: string;
  resolverState: string;
  count: number;
  attention: string | null;
  resolverError?: string | null;
  path: string | null;
  owned: boolean;
  superseded: boolean;
  dismissed: boolean;
  running: boolean;
  canRetry: boolean;
  canAttempt: boolean;
  canResolve: boolean;
  canValidate: boolean;
  publish: boolean;
  changes: ChangeStats | null;
  submitted: boolean;
  finalReview: boolean;
}
export interface ChangeStats {
  files: number;
  additions: number;
  deletions: number;
}
export interface QueueItem {
  key: string;
  url: string;
  title: string;
  subject: string;
  author: string;
  head: string;
  branch: string;
  updatedAt: string | null;
  tags: string[];
  freshness: "not_reviewed" | "current" | "stale" | "unknown";
  previousAt: string | null;
  previousModel: string | null;
  changes: ChangeStats | null;
}
export interface Snapshot {
  rows: ReviewRow[];
  queue: QueueItem[];
  warnings: string[];
  updatedAt: string;
  /** When the PR queue was last discovered from GitHub; null until it has been. */
  queueRefreshedAt?: string | null;
  health: {
    forkPath: string;
    version: string | null;
    nodeVersion: string;
    ready: boolean;
    error: string | null;
    repository?: { name: string; url: string } | null;
    provider: Preferences["reviewProvider"];
    reviewModel: string;
    resolverProvider: Preferences["fixProvider"];
    fixModel: string;
    teams: string[];
    teammates: string[];
    port: number;
    database: "shared";
    adapterProtocol?: number | null;
    databaseSchema?: number | null;
    databaseSnapshot?: number | null;
    headlessEnvelope?: number | null;
    healthIdentity?: number | null;
    capabilities?: string[];
    buildId?: string | null;
    buildCommit?: string | null;
    dirty?: boolean | null;
    legacyContract?: boolean;
  };
}
/** What the Stack Control plugin knows about stacks for a PR; `available` is false when it isn't installed. */
export const prStacksSchema = z.object({
  available: z.boolean(),
  stacks: z.array(
    z.object({
      namespace: z.string(),
      name: z.string(),
      status: z.string(),
      health: z.string().nullable(),
      expiresAt: z.string().nullable(),
      path: z.string(),
      why: z.string(),
      tone: z.enum(["neutral", "good", "warn", "bad", "info"]).optional(),
      healthShort: z.string().optional(),
      services: z.array(z.object({ name: z.string(), color: z.string() })).optional(),
      headline: z.object({ text: z.string(), tone: z.enum(["neutral", "good", "warn", "bad", "info"]), detail: z.string() }).optional(),
    }),
  ),
  launchPath: z.string().nullable(),
});
export type PrStacks = z.infer<typeof prStacksSchema>;

export interface Details {
  row: ReviewRow;
  summary: string;
  changes: ChangeStats | null;
  findings: {
    id: number;
    file: string;
    title: string;
    body: string;
    line: number | null;
    sourcePath: string | null;
    kind: string | null;
    severity: string | null;
    suggestion: string | null;
    disposition: string | null;
    reason: string | null;
  }[];
  patches: { path: string; patch: string }[];
  briefing: {
    available: boolean;
    state: string;
    head: string | null;
    file: string | null;
    hostId: string | null;
    stale: boolean;
    error: string | null;
    updatedAt: number | null;
    threadId: string | null;
  };
  /** Stack Control stacks running this PR, from the Stack Control plugin when it is installed. */
  stacks?: PrStacks;
  activity: string[];
  feedback: {
    complete: boolean;
    error: string | null;
    comments: {
      author: string;
      body: string;
      location: string;
      disposition: string | null;
      reason: string | null;
    }[];
  };
}
const changeStatsSchema = z
  .object({
    files: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict();
const rowSchema = z.object({
  id: z.string(),
  batchId: id,
  index: z.number().int(),
  key: z.string(),
  title: z.string(),
  subject: z.string(),
  url: z.string().nullable(),
  author: z.string(),
  head: sha,
  base: sha,
  branch: z.string(),
  model: z.string(),
  provider: z.string().optional(),
  origin: z.enum(["bb", "external"]).optional(),
  updatedAt: z.string(),
  attempt: z.number().int(),
  reviewState: z.string(),
  resolverState: z.string(),
  count: z.number(),
  attention: z.string().nullable(),
  resolverError: z.string().nullable().optional(),
  path: z.string().nullable(),
  owned: z.boolean(),
  superseded: z.boolean(),
  dismissed: z.boolean(),
  running: z.boolean(),
  canRetry: z.boolean(),
  canAttempt: z.boolean(),
  canResolve: z.boolean(),
  canValidate: z.boolean(),
  publish: z.boolean(),
  changes: changeStatsSchema.nullable(),
  submitted: z.boolean(),
  finalReview: z.boolean(),
});
const queueSchema = z.object({
  key: z.string(),
  url: z.string(),
  title: z.string(),
  subject: z.string(),
  author: z.string(),
  head: sha,
  branch: z.string(),
  updatedAt: z.string().nullable(),
  tags: z.array(z.string()),
  freshness: z.enum(["not_reviewed", "current", "stale", "unknown"]),
  previousAt: z.string().nullable(),
  previousModel: z.string().nullable(),
  changes: changeStatsSchema.nullable(),
});
export const snapshotSchema = z.object({
  rows: z.array(rowSchema).max(300),
  queue: z.array(queueSchema).max(1000),
  warnings: z.array(z.string()),
  updatedAt: z.string(),
  queueRefreshedAt: z.string().nullable().optional(),
  health: z.object({
    forkPath: z.string(),
    version: z.string().nullable(),
    nodeVersion: z.string(),
    ready: z.boolean(),
    error: z.string().nullable(),
    repository: z
      .object({ name: z.string(), url: z.string().url() })
      .nullable()
      .optional(),
    provider: reviewProvider,
    reviewModel: z.string(),
    resolverProvider,
    fixModel: z.string(),
    teams: z.array(z.string()),
    teammates: z.array(z.string()),
    port: z.number().int().min(1).max(65535),
    database: z.literal("shared"),
    adapterProtocol: z.number().int().nullable().optional(),
    databaseSchema: z.number().int().nullable().optional(),
    databaseSnapshot: z.number().int().nullable().optional(),
    headlessEnvelope: z.number().int().nullable().optional(),
    healthIdentity: z.number().int().nullable().optional(),
    capabilities: z.array(z.string()).optional(),
    buildId: z.string().nullable().optional(),
    buildCommit: z.string().nullable().optional(),
    dirty: z.boolean().nullable().optional(),
    legacyContract: z.boolean().optional(),
  }),
});
const detailsSchema = z.object({
  row: rowSchema,
  summary: z.string(),
  changes: changeStatsSchema.nullable(),
  findings: z.array(
    z.object({
      id: z.number(),
      file: z.string(),
      title: z.string(),
      body: z.string(),
      line: z.number().nullable(),
      sourcePath: z.string().nullable(),
      kind: z.string().nullable(),
      severity: z.string().nullable(),
      suggestion: z.string().nullable(),
      disposition: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
  patches: z.array(z.object({ path: z.string(), patch: z.string() })),
  briefing: z.object({
    available: z.boolean(),
    state: z.string(),
    head: z.string().nullable(),
    file: z.string().nullable(),
    hostId: z.string().nullable(),
    stale: z.boolean(),
    error: z.string().nullable(),
    updatedAt: z.number().int().nonnegative().nullable(),
    threadId: z.string().nullable(),
  }),
  stacks: prStacksSchema.optional(),
  activity: z.array(z.string()),
  feedback: z.object({
    complete: z.boolean(),
    error: z.string().nullable(),
    comments: z.array(
      z.object({
        author: z.string(),
        body: z.string(),
        location: z.string(),
        disposition: z.string().nullable(),
        reason: z.string().nullable(),
      }),
    ),
  }),
});
export const actionSchema = selection.extend({
  action: z.enum([
    "retry",
    "attempt",
    "validate",
    "cancel",
    "recover",
    "dismiss",
    "restore",
  ]),
  confirmed: z.boolean().default(false),
});
const limitBucket = z.object({
  limit: z.number().int().nonnegative(),
  remaining: z.number().int(),
  resetAt: z.string(),
});
export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.null(),
    output: snapshotSchema.extend({
      hostId: z.string(),
      preferences: Preferences,
    }),
  },
  refresh: { input: z.null(), output: snapshotSchema },
  preview: {
    input: reviewInput,
    output: z.object({ base: z.string(), head: sha, baseSha: sha }),
  },
  start: { input: reviewInput, output: z.object({ batchId: id }) },
  details: { input: selection, output: detailsSchema },
  prDetails: {
    input: z.object({ url: z.string().url().max(2048) }).strict(),
    output: z.object({
      pr: queueSchema,
      review: selection.nullable(),
      patches: z.array(z.object({ path: z.string(), patch: z.string() })),
      patchError: z.string().nullable(),
      feedback: detailsSchema.shape.feedback,
      canResolve: z.boolean(),
      briefing: detailsSchema.shape.briefing,
      stacks: detailsSchema.shape.stacks,
    }),
  },
  resolverStart: {
    input: z
      .union([
        selection.extend({
          maxRounds: z.number().int().min(1).max(5).optional(),
          confirmed: z.literal(true),
        }),
        z
          .object({
            url: z.string().url().max(2048),
            maxRounds: z.number().int().min(1).max(5).optional(),
            confirmed: z.literal(true),
          })
          .strict(),
      ]),
    output: selection,
  },
  action: {
    input: actionSchema,
    output: z.object({ accepted: z.literal(true) }),
  },
  briefingGenerate: {
    input: z.object({ url: z.string().url().max(2048) }).strict(),
    output: detailsSchema.shape.briefing,
  },
  settings: { input: Preferences, output: Preferences },
  prStatus: {
    input: z.object({ url: z.string().url().max(2048) }).strict(),
    output: z.object({
      head: sha,
      state: z.enum(["open", "closed", "merged"]),
      checkedAt: z.string(),
    }),
  },
  rateLimit: {
    input: z.null(),
    output: z.object({
      core: limitBucket.nullable(),
      search: limitBucket.nullable(),
      graphql: limitBucket.nullable(),
    }),
  },
  resetSettings: { input: z.null(), output: Preferences },
  openFork: {
    input: z.union([
      selection,
      z.object({ url: z.string().url().max(2048) }).strict(),
    ]),
    output: z.object({ url: z.string() }),
  },
});
export const hostContract = defineRpcContract({
  invoke: {
    input: z
      .object({
        sourceRoot: z.string(),
        preferences: Preferences,
        operation: z.enum([
          "snapshot",
          "refresh",
          "preview",
          "start",
          "details",
          "prDetails",
          "resolverStart",
          "action",
          "openFork",
          "rateLimit",
          "prStatus",
        ]),
        payload: z.unknown().optional(),
      })
      .strict(),
    output: z.unknown(),
  },
});
export type Request = z.infer<typeof hostContract.invoke.input>;

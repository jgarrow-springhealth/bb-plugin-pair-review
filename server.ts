import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  rpcContract,
  hostContract,
  Preferences,
  DEFAULT_PREFERENCES,
  type Request,
  type Snapshot,
} from "./contract";
import { pairReviewProjectRows } from "./sidebar-rows";
export { rpcContract } from "./contract";
export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    forkPath: {
      type: "string",
      label: "Pair Review installation",
      description:
        "Use pair-review for the original @in-the-loop-labs/pair-review command on PATH, or enter an absolute path or ~/ path to a compatible local fork.",
      experimental_schema: Preferences.shape.forkPath,
      default: DEFAULT_PREFERENCES.forkPath,
    },
    hostname: {
      type: "string",
      label: "GitHub hostname",
      description:
        "Lowercase hostname used for GitHub CLI reads and PR URLs, without https://.",
      experimental_schema: Preferences.shape.hostname,
      default: DEFAULT_PREFERENCES.hostname,
    },
    reviewProvider: {
      type: "select",
      label: "Review provider",
      description:
        "Native Pair Review provider used for analysis. The matching CLI must be installed and authenticated on the BB server machine.",
      options: [
        "pi",
        "claude",
        "codex",
        "copilot",
        "opencode",
        "cursor-agent",
        "antigravity",
        "omp",
        "muse",
      ],
      experimental_schema: Preferences.shape.reviewProvider,
      default: DEFAULT_PREFERENCES.reviewProvider,
    },
    reviewModel: {
      type: "string",
      label: "Review model",
      description:
        "Model identifier understood by the selected Pair Review provider, such as openai/gpt-5 for Pi, opus for Claude, or a Codex model ID.",
      experimental_schema: Preferences.shape.reviewModel,
      default: DEFAULT_PREFERENCES.reviewModel,
    },
    fixProvider: {
      type: "select",
      label: "Resolver provider",
      description:
        "Agent used inside the separately confirmed guarded resolver: Pi SDK, Claude Code CLI, or Codex CLI.",
      options: ["pi", "claude", "codex"],
      experimental_schema: Preferences.shape.fixProvider,
      default: DEFAULT_PREFERENCES.fixProvider,
    },
    fixModel: {
      type: "string",
      label: "Resolver model",
      description:
        "Model identifier understood by the resolver provider. Claude and Codex run only against an isolated source copy before guarded edits are applied.",
      experimental_schema: Preferences.shape.fixModel,
      default: DEFAULT_PREFERENCES.fixModel,
    },
    reviewThinking: {
      type: "select",
      label: "Review reasoning",
      description: "Reasoning level passed to native Pair Review analysis.",
      options: ["off", "minimal", "low", "medium", "high", "xhigh"],
      experimental_schema: Preferences.shape.reviewThinking,
      default: DEFAULT_PREFERENCES.reviewThinking,
    },
    fixThinking: {
      type: "select",
      label: "Resolver reasoning",
      description: "Reasoning level used by the separately confirmed resolver loop.",
      options: ["off", "minimal", "low", "medium", "high", "xhigh"],
      experimental_schema: Preferences.shape.fixThinking,
      default: DEFAULT_PREFERENCES.fixThinking,
    },
    resolverMaxRounds: {
      type: "number",
      label: "Default resolver loop rounds",
      description:
        "Maximum rounds proposed in the confirmation dialog. Clean loops stop earlier (1–5).",
      experimental_schema: Preferences.shape.resolverMaxRounds,
      default: DEFAULT_PREFERENCES.resolverMaxRounds,
    },
    publish: {
      type: "boolean",
      label: "Publish after explicit human validation",
      description:
        "Off keeps fixes local. On permits an exact-SHA push only after the separate validation attestation.",
      experimental_schema: Preferences.shape.publish,
      default: DEFAULT_PREFERENCES.publish,
    },
    feedback: {
      type: "boolean",
      label: "Capture human feedback during reviews",
      description:
        "Capture unresolved review threads, review summaries, and PR conversation. Manual resolver loops always refresh feedback.",
      experimental_schema: Preferences.shape.feedback,
      default: DEFAULT_PREFERENCES.feedback,
    },
    hideReviewed: {
      type: "boolean",
      label: "Hide current reviews in the queue",
      description:
        "Hide PRs whose current head was already reviewed; stale reviews remain visible.",
      experimental_schema: Preferences.shape.hideReviewed,
      default: DEFAULT_PREFERENCES.hideReviewed,
    },
    teams: {
      type: "string",
      label: "Review teams",
      description:
        "Comma-separated OWNER/TEAM values used for team-request discovery (maximum 20).",
      experimental_schema: Preferences.shape.teams,
      default: DEFAULT_PREFERENCES.teams,
    },
    teammates: {
      type: "string",
      label: "Teammate GitHub handles",
      description:
        "Comma-separated handles used to classify direct requests (maximum 100).",
      experimental_schema: Preferences.shape.teammates,
      default: DEFAULT_PREFERENCES.teammates,
    },
    preparationConcurrency: {
      type: "number",
      label: "Preparation concurrency",
      description: "Maximum PR checkouts prepared concurrently (1–16).",
      experimental_schema: Preferences.shape.preparationConcurrency,
      default: DEFAULT_PREFERENCES.preparationConcurrency,
    },
  });
  settings.onChange(() => bb.realtime.publish("changed", {}));
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const dir = dirname(fileURLToPath(import.meta.url)),
    sourceRoot = basename(dir) === "dist" ? resolve(dir, "..") : dir;
  const externalRowsOutput = z.object({ changed: z.boolean() });
  const briefingOutput = z
    .object({
      available: z.boolean(),
      state: z.string(),
      head: z.string().nullable(),
      file: z.string().nullable(),
      hostId: z.string().nullable(),
      stale: z.boolean(),
      error: z.string().nullable(),
      updatedAt: z.number().int().nonnegative().nullable(),
      threadId: z.string().nullable().optional(),
    })
    .strict();
  const unavailableBriefing = () => ({
    available: false,
    state: "unavailable",
    head: null,
    file: null,
    hostId: null,
    stale: false,
    error: null,
    updatedAt: null,
    threadId: null,
  });
  async function getBriefing(url: string | null, head?: string) {
    if (!url) return unavailableBriefing();
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "pr-briefings",
        method: "briefing_get",
        input: { url, ...(head ? { head } : {}) } as any,
        outputSchema: briefingOutput,
      });
      return { ...result, threadId: result.threadId ?? null };
    } catch {
      return unavailableBriefing();
    }
  }
  async function generateBriefing(url: string) {
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "pr-briefings",
        method: "briefing_generate",
        input: { url },
        outputSchema: briefingOutput,
      });
      return { ...result, threadId: result.threadId ?? null };
    } catch {
      throw Error(
        "Install and enable the PR Briefings plugin to generate this briefing.",
      );
    }
  }
  let sidebarSyncWarning = "";
  async function syncProjectRows(snapshot: Snapshot | null) {
    try {
      const rows = snapshot
        ? pairReviewProjectRows(snapshot, await bb.sdk.projects.list())
        : [];
      await bb.sdk.plugins.callRpc({
        pluginId: "project-folders",
        method: "external_rows_sync",
        input: { rows } as any,
        outputSchema: externalRowsOutput,
      });
      sidebarSyncWarning = "";
    } catch (error) {
      const warning = String(error);
      if (warning !== sidebarSyncWarning) {
        sidebarSyncWarning = warning;
        bb.log.warn(`Pair Review project-row sync: ${warning}`);
      }
    }
  }
  async function invoke(
    operation: Request["operation"],
    payload: unknown = null,
  ) {
    const hostId = (await bb.sdk.system.config()).primaryHostId;
    if (!hostId)
      throw Error(
        "The BB server machine is not enrolled. Pair Review needs that machine to access your Pair Review installation.",
      );
    const preferences = Preferences.parse(await settings.get());
    const result = await host.call(
      "invoke",
      { sourceRoot, preferences, operation, payload },
      {
        hostId,
        timeoutMs:
          operation === "refresh"
            ? 600000
            : operation === "action"
              ? 60000
              : 180000,
      },
    );
    return { result, hostId, preferences };
  }
  bb.rpc.register(rpcContract, {
    snapshot: async () => {
      const { result, hostId, preferences } = await invoke("snapshot");
      await syncProjectRows(result as Snapshot);
      return { ...(result as any), hostId, preferences };
    },
    refresh: async () => {
      const { result } = await invoke("refresh");
      bb.realtime.publish("changed", {});
      return result as any;
    },
    preview: async (input) => (await invoke("preview", input)).result as any,
    start: async (input) => {
      const { result } = await invoke("start", input);
      for (const url of input.urls) void generateBriefing(url).catch(() => {});
      bb.realtime.publish("changed", {});
      return result as any;
    },
    details: async (input) => {
      const { result } = await invoke("details", input);
      const details = result as any;
      details.briefing = await getBriefing(details.row.url, details.row.head);
      return details;
    },
    prDetails: async (input) => {
      const { result } = await invoke("prDetails", input);
      const details = result as any;
      details.briefing = await getBriefing(details.pr.url, details.pr.head);
      return details;
    },
    resolverStart: async (input) => {
      const { result } = await invoke("resolverStart", input);
      bb.realtime.publish("changed", {});
      return result as any;
    },
    action: async (input) => {
      const { result } = await invoke("action", input);
      bb.realtime.publish("changed", {});
      return result as any;
    },
    briefingGenerate: async ({ url }) => generateBriefing(url),
    settings: async (input) => {
      const value = Preferences.parse(input);
      await settings.experimental_set(value);
      return value;
    },
    resetSettings: async () => {
      const value = await settings.experimental_set({
        forkPath: null,
        hostname: null,
        reviewProvider: null,
        reviewModel: null,
        fixProvider: null,
        fixModel: null,
        reviewThinking: null,
        fixThinking: null,
        resolverMaxRounds: null,
        publish: null,
        feedback: null,
        hideReviewed: null,
        teams: null,
        teammates: null,
        preparationConcurrency: null,
      });
      return Preferences.parse(value);
    },
    openFork: async (input) => (await invoke("openFork", input)).result as any,
    rateLimit: async () => (await invoke("rateLimit")).result as any,
  });
  bb.onDispose(() => syncProjectRows(null));
  bb.cli.register({
    name: "pair-review",
    summary: "Inspect the dedicated Pair Review page",
    commands: [
      {
        name: "status",
        summary: "Read retained batches",
        usage: "bb pair-review status",
      },
    ],
    run: async (argv) => {
      if (argv.length && argv[0] !== "status")
        return { exitCode: 1, stderr: "Usage: bb pair-review status" };
      const { result } = await invoke("snapshot");
      return { exitCode: 0, stdout: JSON.stringify(result) };
    },
  });
}

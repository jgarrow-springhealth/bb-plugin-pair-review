import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export type CliAgentProvider = "claude" | "codex";
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;
const MAX_WORKSPACE_FILES = 10_000;
const protectedParts = new Set([
  ".git",
  "node_modules",
  ".pi",
  ".pair-review",
  ".ssh",
  ".aws",
  ".config",
  ".gnupg",
  ".docker",
]);

function allowedRelativePath(path: string) {
  const parts = path.split(/[\\/]/);
  return !parts.some((part) => {
    const lower = part.toLowerCase();
    return (
      !part ||
      part === "." ||
      part === ".." ||
      protectedParts.has(lower) ||
      lower === ".env" ||
      lower.startsWith(".env.") ||
      [".npmrc", ".pypirc", ".netrc", ".git-credentials"].includes(lower)
    );
  });
}

export type IsolatedWorkspace = {
  root: string;
  files: Map<string, Buffer>;
  cleanup(): void;
};

/** Copies only bounded, regular, non-linked source files into an agent-only workspace. */
export function createIsolatedWorkspace(sourceRoot: string): IsolatedWorkspace {
  const temporary = mkdtempSync(join(tmpdir(), "pair-review-resolver-"));
  chmodSync(temporary, 0o700);
  const workspace = join(temporary, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  const files = new Map<string, Buffer>();
  let total = 0;

  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const rel = relative(sourceRoot, absolute);
      if (!allowedRelativePath(rel) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = lstatSync(absolute);
      if (stat.nlink > 1 || stat.size > MAX_SOURCE_BYTES) continue;
      if (
        files.size >= MAX_WORKSPACE_FILES ||
        total + stat.size > MAX_WORKSPACE_BYTES
      )
        continue;
      const destination = resolve(workspace, rel);
      const destinationRelative = relative(workspace, destination);
      if (!destinationRelative || destinationRelative.startsWith("..")) continue;
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(absolute, destination);
      chmodSync(destination, 0o600);
      const content = readFileSync(absolute);
      files.set(rel, content);
      total += stat.size;
    }
  };
  visit(sourceRoot);
  return {
    root: workspace,
    files,
    cleanup: () => rmSync(temporary, { recursive: true, force: true }),
  };
}

export function changedWorkspaceFiles(workspace: IsolatedWorkspace) {
  const changed = new Map<string, { before: Buffer; after: Buffer }>();
  const seen = new Set<string>();
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const rel = relative(workspace.root, absolute);
      if (!allowedRelativePath(rel) || entry.isSymbolicLink())
        throw Error("Resolver created an unsafe workspace entry");
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile() || !workspace.files.has(rel))
        throw Error("Resolver may not create source files");
      const stat = lstatSync(absolute);
      if (stat.nlink > 1 || stat.size > MAX_SOURCE_BYTES)
        throw Error("Resolver produced an unsafe source file");
      seen.add(rel);
      const before = workspace.files.get(rel)!;
      const after = readFileSync(absolute);
      if (!before.equals(after)) changed.set(rel, { before, after });
    }
  };
  visit(workspace.root);
  if (seen.size !== workspace.files.size)
    throw Error("Resolver may not delete source files");
  return changed;
}

function agentEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const names = [
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "CODEX_HOME",
  ];
  return Object.fromEntries(
    names.flatMap((name) =>
      typeof source[name] === "string" ? [[name, source[name]!]] : [],
    ),
  );
}

export function structuredAgentInvocation(options: {
  provider: CliAgentProvider;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  workspace: string;
  schema: object;
  outputFile: string;
}) {
  if (options.provider === "claude") {
    const effort =
      options.thinking === "xhigh"
        ? "max"
        : ["off", "minimal"].includes(options.thinking)
          ? "low"
          : options.thinking;
    return {
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(options.schema),
        "--model",
        options.model,
        "--restricted",
        "--tools",
        "Read,Edit",
        "--permission-mode",
        "acceptEdits",
        "--permission-prompts",
        "none",
        "--strict-mcp-config",
        "--mcp-config",
        "{}",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--settings",
        '{"disableAllHooks":true}',
      ],
      env: { ...agentEnvironment(), CLAUDE_CODE_EFFORT_LEVEL: effort },
    };
  }
  const effort = options.thinking === "off" ? "minimal" : options.thinking;
  return {
    command: "codex",
    args: [
      "exec",
      "--sandbox",
      "workspace-write",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--output-schema",
      join(options.workspace, "..", "output-schema.json"),
      "--output-last-message",
      options.outputFile,
      "--model",
      options.model,
      "-c",
      `model_reasoning_effort=${JSON.stringify(effort)}`,
      "-C",
      options.workspace,
      "-",
    ],
    env: agentEnvironment(),
  };
}

function parseClaudeOutput(stdout: string) {
  const envelope = JSON.parse(stdout);
  if (envelope?.structured_output) return envelope.structured_output;
  if (typeof envelope?.result === "string") return JSON.parse(envelope.result);
  throw Error("Claude did not return structured output");
}

export async function runStructuredAgent<T>(options: {
  provider: CliAgentProvider;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  workspace: string;
  prompt: string;
  schema: object;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<T> {
  const outputFile = join(options.workspace, "..", "last-message.json");
  const schemaFile = join(options.workspace, "..", "output-schema.json");
  writeFileSync(schemaFile, JSON.stringify(options.schema), { mode: 0o600 });
  const invocation = structuredAgentInvocation({ ...options, outputFile });
  options.signal?.throwIfAborted();
  return new Promise<T>((resolveResult, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.workspace,
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let closed = false;
    const stop = () => {
      if (closed) return;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}
    };
    const timeout = setTimeout(stop, options.timeoutMs ?? 90 * 60_000);
    const abort = () => stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) stop();
      else stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-16_384);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      closed = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted)
        return reject(options.signal.reason ?? Error("Resolver cancelled"));
      if (bytes > MAX_OUTPUT_BYTES)
        return reject(Error("Resolver provider output exceeded 2 MiB"));
      if (code !== 0)
        return reject(Error(stderr.trim() || `${invocation.command} exited ${code}`));
      try {
        if (
          options.provider === "codex" &&
          lstatSync(outputFile).size > MAX_OUTPUT_BYTES
        )
          throw Error("Resolver provider output exceeded 2 MiB");
        const value =
          options.provider === "claude"
            ? parseClaudeOutput(stdout)
            : JSON.parse(readFileSync(outputFile, "utf8"));
        resolveResult(value as T);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(options.prompt);
  });
}

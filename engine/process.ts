import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute, delimiter } from "node:path";
import {
  writeFileSync,
  openSync,
  closeSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { atomicJson, json, safePath, now, readStatus } from "./status.ts";
export type Run = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeout?: number;
    log?: string;
    stdoutFile?: string;
  },
) => Promise<string>;
export const cleanEnv = (
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries({
      ...source,
      PATH: (source.PATH ?? "")
        .split(delimiter)
        .filter(isAbsolute)
        .join(delimiter),
    }).filter(
      ([k]) =>
        !/^(BASH_ENV|ENV|ZDOTDIR|NODE_OPTIONS|NODE_PATH|GIT_|PAIR_REVIEW_|PI_CMD|LD_|DYLD_)/.test(
          k,
        ),
    ),
  );
export function subprocessFailureDetail(stderr: string, stdout: string) {
  const error = stderr.trim();
  if (error) return error.slice(-4000);
  try {
    const parsed = JSON.parse(stdout);
    const message = parsed?.error?.message ?? parsed?.error;
    if (typeof message === "string" && message.trim())
      return message.trim().slice(-4000);
  } catch {}
  return stdout.trim().slice(-4000);
}

export const run: Run = async (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? cleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outDecoder = new StringDecoder("utf8"),
      errDecoder = new StringDecoder("utf8");
    let bytes = 0;
    let out = "",
      err = "",
      settled = false,
      stopping = false;
    let failure: Error | undefined;
    let kill: NodeJS.Timeout | undefined;
    const stop = (reason = Error("Subprocess aborted")) => {
      if (stopping || settled) return;
      stopping = true;
      failure = reason;
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), 10000);
    };
    const timer = setTimeout(
      () => stop(Error("Subprocess timed out")),
      options.timeout ?? 300000,
    );
    const abort = () => stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (b) => {
      if (stopping) return;
      if (bytes + b.length > 32 * 1024 * 1024)
        stop(Error("Subprocess output exceeds 32 MiB"));
      else {
        bytes += b.length;
        out += outDecoder.write(b);
      }
    });
    child.stderr.on("data", (b) => {
      err = (err + errDecoder.write(b)).slice(-32768);
    });
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      out += outDecoder.end();
      err = (err + errDecoder.end()).slice(-32768);
      clearTimeout(timer);
      clearTimeout(kill);
      options.signal?.removeEventListener("abort", abort);
      try {
        if (options.log)
          writeFileSync(safePath(options.log), err, { mode: 0o600 });
        if (options.stdoutFile)
          writeFileSync(safePath(options.stdoutFile), out, { mode: 0o600 });
      } catch (logError) {
        error = Error(String(logError));
      }
      error ? reject(error) : resolve(out);
    }
    child.on("error", finish);
    child.on("close", (code, signal) =>
      finish(
        failure ??
          (code === 0
            ? undefined
            : Error(
                `${command} exited ${code ?? signal}: ${subprocessFailureDetail(err, out)}`,
              )),
      ),
    );
  });
const Identity = z.object({
  pid: z.number().int().min(1),
  pgid: z.number().int().min(0),
  started: z.string().length(24),
  command: z.string().min(1),
});
const Coordinator = z.object({
  pid: z.number().int().min(2),
  pgid: z.number().int().min(2),
  token: z.string().regex(/^[a-f0-9]{48}$/),
  identity: Identity,
});
function parseProcess(raw: string) {
  const m = raw.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
  if (!m) throw Error("Process identity unavailable");
  return Identity.parse({
    pid: +m[1],
    pgid: +m[2],
    started: m[3],
    command: m[4],
  });
}
export async function processIdentity(pid: number, exec: Run = run) {
  if (!Number.isInteger(pid) || pid < 2) throw Error("Invalid PID");
  return parseProcess(
    await exec("ps", ["-p", String(pid), "-o", "pid=,pgid=,lstart=,command="]),
  );
}
async function group(pgid: number, exec: Run) {
  const raw = await exec("ps", ["-e", "-o", "pid=,pgid=,lstart=,command="]);
  return raw.trim()
    ? raw
        .trim()
        .split("\n")
        .map(parseProcess)
        .filter((p) => p.pgid === pgid)
    : [];
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export async function launch(dir: string, mode = "run", entry?: number) {
  if (process.platform === "win32")
    throw Error("Detached process-group safety requires macOS or Linux");
  const actions = join(dir, "actions");
  if (existsSync(actions)) {
    for (const name of readdirSync(actions)) {
      const match = name.match(/^cancel-entry-(\d+)\.json$/);
      if (match && (entry === undefined || Number(match[1]) === entry))
        rmSync(join(actions, name));
    }
  }
  const token = randomBytes(24).toString("hex");
  const args = [
    join(import.meta.dirname, "coordinator.mjs"),
    dir,
    mode,
    token,
    ...(entry === undefined ? [] : [String(entry)]),
  ];
  const f = openSync(
    safePath(join(dir, "logs", "coordinator.log")),
    "a",
    0o600,
  );
  const child = spawn(process.execPath, args, {
    cwd: import.meta.dirname,
    detached: true,
    env: cleanEnv(),
    stdio: ["ignore", f, f],
  });
  closeSync(f);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return token;
}
export function cancelEntry(dir: string, index: number) {
  if (!Number.isInteger(index) || index < 0) throw Error("Invalid review index");
  atomicJson(join(dir, "actions", `cancel-entry-${index}.json`), {
    index,
    at: now(),
  });
}
export async function cancel(
  dir: string,
  exec: Run = run,
  signal: (pgid: number, s: NodeJS.Signals) => unknown = (pgid, s) =>
    process.kill(-pgid, s),
  wait = (ms: number) => new Promise((r) => setTimeout(r, ms)),
) {
  const file = join(dir, "coordinator.json");
  const saved = Coordinator.parse(json(file));
  const live = await processIdentity(saved.pid, exec);
  if (
    saved.pid !== saved.pgid ||
    !same(live, saved.identity) ||
    !live.command.includes(saved.token) ||
    !live.command.includes("coordinator.mjs")
  )
    throw Error("Coordinator identity changed; refusing to signal any process");
  const members = await group(saved.pgid, exec);
  if (!members.some((p) => same(p, live)))
    throw Error("Coordinator group identity unavailable");
  atomicJson(join(dir, "actions", "cancel.json"), {
    token: saved.token,
    at: now(),
    members,
  });
  signal(saved.pgid, "SIGTERM");
  await wait(10000);
  let remaining = await group(saved.pgid, exec);
  if (remaining.length) {
    if (!remaining.some((p) => members.some((old) => same(p, old))))
      throw Error("Process group identity changed; refusing force termination");
    signal(saved.pgid, "SIGKILL");
    for (let i = 0; i < 10 && remaining.length; i++) {
      await wait(100);
      remaining = await group(saved.pgid, exec);
    }
  }
  if (
    !remaining.length &&
    Coordinator.parse(json(file)).token === saved.token
  ) {
    const s = readStatus(dir);
    if (["queued", "running"].includes(s.state)) {
      s.state = "cancelled";
      s.updatedAt = now();
      for (const e of s.entries)
        for (const w of [e.review, e.resolver])
          if (
            [
              "queued",
              "preparing",
              "reviewing",
              "resolving",
              "publishing",
              "pending",
            ].includes(w.state)
          )
            w.state = "cancelled";
      atomicJson(join(dir, "status.json"), s);
    }
    const lock = join(dir, "writer.lock");
    if (existsSync(lock) && json(lock).pid === saved.pid) rmSync(lock);
  }
}
export async function alive(pid: number) {
  try {
    await processIdentity(pid);
    return true;
  } catch {
    return false;
  }
}

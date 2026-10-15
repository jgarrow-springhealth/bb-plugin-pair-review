import {
  mkdirSync,
  lstatSync,
  realpathSync,
  existsSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import {
  Status,
  Input,
  Settings,
  Id,
  keyFor,
  terminal,
  type Entry,
} from "./types.ts";
import { z } from "zod";
export const ROOT = join(homedir(), ".pair-review", "pi-batches");
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export const now = () => new Date().toISOString();
export function inside(root: string, path: string) {
  const r = relative(resolve(root), resolve(path));
  return (
    r === "" || (!r.startsWith(".." + "/") && r !== ".." && !isAbsolute(r))
  );
}
/** No symlinks in any existing ancestor, including the destination. */
export function safePath(path: string) {
  const p = resolve(path);
  let c = p;
  while (true) {
    if (
      existsSync(c) ||
      (() => {
        try {
          return lstatSync(c).isSymbolicLink();
        } catch {
          return false;
        }
      })()
    ) {
      if (lstatSync(c).isSymbolicLink()) throw Error(`Symlink rejected: ${c}`);
    }
    const d = dirname(c);
    if (d === c) break;
    c = d;
  }
  return p;
}
export function privateDir(path: string) {
  safePath(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
}
export function atomicJson(path: string, value: unknown) {
  safePath(path);
  privateDir(dirname(path));
  const tmp = join(dirname(path), `.${randomBytes(12).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const d = openSync(dirname(path), "r");
  try {
    fsyncSync(d);
  } finally {
    closeSync(d);
  }
}
export function text(path: string, value: string) {
  safePath(path);
  privateDir(dirname(path));
  writeFileSync(path, value, { mode: 0o600 });
}
export function json(path: string) {
  safePath(path);
  if (statSync(path).size > 32 * 1024 * 1024)
    throw Error("JSON artifact exceeds 32 MiB");
  const s = readFileSync(path, "utf8");
  return JSON.parse(s);
}
export function directory(id: string, root = ROOT) {
  return safePath(join(root, Id.parse(id)));
}
export function loadSettings(root = ROOT) {
  try {
    return Settings.parse(json(join(root, "settings.json")));
  } catch {
    return Settings.parse({});
  }
}
export function saveSettings(value: unknown, root = ROOT) {
  atomicJson(join(root, "settings.json"), Settings.parse(value));
}
export function normalize(value: unknown) {
  const s = Status.parse(value);
  if (s.version > 1) throw Error("Unsupported future status version");
  return s;
}
export function initial(input: Input): Status {
  return {
    version: 1,
    batchId: input.batchId,
    name: input.name,
    state: "queued",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    entries: input.targets.map((target) => ({
      key: keyFor(target),
      target,
      attempt: 1,
      review: { state: "queued" },
      resolver: { state: "not_started" },
    })),
  };
}
export function readStatus(dir: string) {
  return normalize(json(join(dir, "status.json")));
}
export function warnings(s: Status, clock = Date.now()) {
  const w: string[] = [];
  if (
    s.state === "running" &&
    s.heartbeatAt &&
    clock - Date.parse(s.heartbeatAt) > 20000
  )
    w.push(
      `Coordinator heartbeat is ${Math.floor((clock - Date.parse(s.heartbeatAt)) / 1000)}s old`,
    );
  const live = new Set<string>();
  for (const e of s.entries) {
    if (!terminal(e.review.state) || !terminal(e.resolver.state)) {
      if (live.has(e.key))
        w.push(`Corrupt status: multiple live attempts for ${e.key}`);
      live.add(e.key);
    }
  }
  return w;
}
const Dismissals = z
  .object({
    version: z.literal(1),
    entries: z.record(
      z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\/\d+$/),
      z
        .object({
          at: z.string().datetime(),
          key: z.string(),
          head: z.string().regex(/^[a-f0-9]{40}$/),
        })
        .strict(),
    ),
  })
  .strict();
export type DismissalIndex = z.infer<typeof Dismissals>;
export const dismissalId = (batchId: string, index: number) =>
  `${Id.parse(batchId)}/${z.number().int().nonnegative().parse(index)}`;
export function dismissalDirectory(root = ROOT) {
  return privateDir(join(root, ".bb-ui"));
}
export function loadDismissals(root = ROOT): DismissalIndex {
  try {
    return Dismissals.parse(json(join(dismissalDirectory(root), "dismissals.json")));
  } catch {
    return { version: 1, entries: {} };
  }
}
export function saveDismissals(value: unknown, root = ROOT) {
  atomicJson(
    join(dismissalDirectory(root), "dismissals.json"),
    Dismissals.parse(value),
  );
}
export function setDismissed(
  root: string,
  batchId: string,
  index: number,
  entry: Pick<Entry, "key" | "target">,
  dismissed: boolean,
  at = now(),
) {
  const value = loadDismissals(root),
    id = dismissalId(batchId, index);
  if (dismissed)
    value.entries[id] = {
      at,
      key: entry.key,
      head: entry.target.headSha,
    };
  else delete value.entries[id];
  saveDismissals(value, root);
  return value;
}
export function recent(root = ROOT) {
  try {
    return readdirSync(root)
      .flatMap((id) => {
        try {
          return [readStatus(directory(id, root))];
        } catch {
          return [];
        }
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  } catch {
    return [];
  }
}
export function reviewComplete(e: Entry) {
  return ["findings", "zero_findings"].includes(e.review.state);
}
export function isSuperseded(e: Entry, s: Status) {
  return s.entries.some((x) => x.key === e.key && x.attempt > e.attempt);
}
export function finish(s: Status) {
  const active = s.entries.filter((e) => !isSuperseded(e, s));
  s.state = active.some((e) => e.attention)
    ? "needs_attention"
    : active.some((e) => e.review.state === "failed")
      ? "failed"
      : active.some((e) => e.review.state === "cancelled")
        ? "cancelled"
        : "complete";
}
export function withLock<T>(dir: string, fn: () => Promise<T>) {
  const path = join(dir, "writer.lock");
  safePath(path);
  const fd = openSync(path, "wx", 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
  closeSync(fd);
  return fn().finally(() => rmSync(path));
}
export function loadInput(dir: string) {
  return Input.parse(json(join(dir, "input.json")));
}

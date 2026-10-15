import {
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { inside, safePath, hash } from "./status.ts";
export class Guard {
  root: string;
  inspected = new Map<string, string>();
  changed = new Set<string>();
  dispositions = new Map<
    number,
    { state: string; reason: string; path?: string }
  >();
  constructor(root: string) {
    safePath(root);
    this.root = realpathSync(root);
    safePath(this.root);
  }
  path(path: string) {
    const p = safePath(join(this.root, path));
    if (
      !inside(this.root, p) ||
      p === this.root ||
      path.startsWith("/") ||
      relative(this.root, p)
        .split("/")
        .map((s) => s.toLowerCase())
        .some(
          (s) =>
            s === ".git" ||
            s === "node_modules" ||
            s === ".pi" ||
            s === ".pair-review" ||
            s === ".ssh" ||
            s === ".aws" ||
            [
              ".config",
              ".gnupg",
              ".npmrc",
              ".pypirc",
              ".netrc",
              ".git-credentials",
              ".docker",
            ].includes(s) ||
            s === ".env" ||
            s.startsWith(".env."),
        )
    )
      throw Error(
        "Path outside allowed source checkout or protected configuration",
      );
    if (
      lstatSync(p).isSymbolicLink() ||
      !lstatSync(p).isFile() ||
      lstatSync(p).nlink > 1
    )
      throw Error("Only regular non-linked source files are allowed");
    return p;
  }
  read(path: string) {
    const p = this.path(path);
    if (lstatSync(p).size > 256 * 1024)
      throw Error(
        "Source read exceeds 256 KiB; inspect a smaller file manually",
      );
    const content = readFileSync(p, "utf8");
    this.inspected.set(path, hash(content));
    return content;
  }
  list(path = "") {
    const p = safePath(join(this.root, path));
    if (!inside(this.root, p)) throw Error("Directory escape");
    return readdirSync(p, { withFileTypes: true })
      .filter(
        (e) =>
          !e.isSymbolicLink() &&
          !e.name.startsWith(".") &&
          e.name !== "node_modules",
      )
      .map((e) => e.name + (e.isDirectory() ? "/" : ""))
      .slice(0, 500);
  }
  edit(path: string, oldText: string, newText: string) {
    const p = this.path(path);
    const current = readFileSync(p, "utf8");
    if (this.inspected.get(path) !== hash(current))
      throw Error("Inspect current source before editing");
    if (!oldText || current.split(oldText).length !== 2)
      throw Error("Exact edit must have one match");
    if (Buffer.byteLength(newText) > 256 * 1024) throw Error("Edit too large");
    writeFileSync(p, current.replace(oldText, newText));
    this.changed.add(path);
  }
  disposition(
    index: number,
    state: string,
    reason: string,
    path: string | undefined,
    tasks: any[],
  ) {
    const task = tasks[index];
    const allowed = [
      "fixed",
      "invalid",
      "already addressed",
      "out of scope",
      "not relevant",
      "blocked",
      "needs human judgment",
    ];
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      !task ||
      !allowed.includes(state) ||
      !reason.trim()
    )
      throw Error("Disposition requires a valid task index, state, and reason");
    if (path && !this.inspected.has(path))
      throw Error("Disposition path must be inspected first");
    if (
      typeof task.file === "string" &&
      task.file &&
      !["out of scope", "not relevant"].includes(state) &&
      path !== task.file
    )
      throw Error("Disposition must inspect the referenced task source");
    if (state === "fixed" && (!path || !this.changed.has(path)))
      throw Error("Fixed disposition requires an inspected source edit");
    this.dispositions.set(index, {
      state,
      reason,
      ...(path ? { path } : {}),
    });
  }
  validate() {
    const results: string[] = [];
    for (const path of this.changed) {
      const content = readFileSync(this.path(path), "utf8");
      if (path.endsWith(".json")) JSON.parse(content);
      else if (/\.[cm]?[jt]sx?$/.test(path)) {
        const source = ts.createSourceFile(
          path,
          content,
          ts.ScriptTarget.Latest,
          true,
        );
        const errors = (source as any).parseDiagnostics;
        if (errors.length) throw Error(`Syntax validation failed: ${path}`);
      } else
        throw Error(
          `Focused validation unavailable for ${path}; human validation required`,
        );
      results.push(`Syntax checked ${path}; behavioral tests not run`);
    }
    return results;
  }
}
/** No shell/network/Git tool is exposed. This rejects every command, not just spellings on a denylist. */
export function rejectCommand(_command: string): never {
  throw Error(
    "Resolver commands disabled: no credentials, shell, network, GitHub mutation, or push access",
  );
}
export function verifyDispositions(guard: Guard, tasks: any[]) {
  if (guard.dispositions.size !== tasks.length)
    throw Error("A disposition is required for every resolver task");
  return [...guard.dispositions].map(([index, d]) => ({ index, ...d }));
}

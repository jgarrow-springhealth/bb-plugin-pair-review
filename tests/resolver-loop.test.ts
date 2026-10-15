import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { execute, resolverTasks } from "../engine/engine.ts";
import { GitHub } from "../engine/data.ts";
import { initial, privateDir } from "../engine/status.ts";
import { Input } from "../engine/types.ts";
import { Guard, verifyDispositions } from "../engine/resolver-guard.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a normal Pair Review never starts resolution automatically", async () => {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "pair-review-analysis-only-")),
  );
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(repo, "value.ts"), "export const value = 1;\n");
  git("add", "value.ts");
  git("commit", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");
  git("checkout", "-b", "feature");
  writeFileSync(join(repo, "value.ts"), "export const value = 2;\n");
  git("add", "value.ts");
  git("commit", "-m", "change");
  const headSha = git("rev-parse", "HEAD");
  const dir = privateDir(join(root, "batch"));
  for (const sub of ["reviews", "feedback"]) privateDir(join(dir, sub));
  const input = Input.parse({
    version: 1,
    batchId: "manual-only",
    createdAt: new Date().toISOString(),
    login: "local-user",
    settings: {},
    targets: [
      {
        kind: "branch",
        repoRoot: repo,
        branch: "feature",
        base: "main",
        baseSha,
        headSha,
        title: "local branch feature",
      },
    ],
    origin: "test",
  });
  const status = initial(input);
  const resolve = vi.fn();
  await execute(dir, input, status, "run", undefined, new AbortController().signal, {
    exec: async (command, args, options) => {
      const { run } = await import("../engine/process.ts");
      return run(command, args, options);
    },
    github: new GitHub(),
    analyze: vi.fn(async () => ({
      state: "findings" as const,
      count: 1,
      runId: "run-1",
      file: join(dir, "review.json"),
      digest: "digest",
      home: root,
      database: join(root, "database.db"),
      dbId: "db",
      port: 7247,
      uiPath: "/local/1",
      model: "openai/gpt-5",
    })) as any,
    resolve,
  });

  expect(resolve).not.toHaveBeenCalled();
  expect(status.entries[0].resolver.state).toBe("not_started");
});

test("human comments become first-class resolver tasks, including summary feedback", () => {
  const tasks = resolverTasks(
    [{ file: "src/review.ts", title: "Pair finding" }],
    {
      complete: true,
      comments: [
        {
          author: "alice",
          body: "This condition drops the final item.",
          location: "src/review.ts:42",
          url: "https://github.com/example/project/pull/1#discussion_r1",
        },
        {
          author: "bob",
          body: "Please keep this change limited to the parser.",
          location: "Review summary",
          url: "https://github.com/example/project/pull/1#pullrequestreview-1",
        },
      ],
    },
  );

  expect(tasks).toHaveLength(3);
  expect(tasks[1]).toMatchObject({
    source: "human_feedback",
    feedbackIndex: 0,
    file: "src/review.ts",
    line_start: 42,
  });
  expect(tasks[2]).toMatchObject({
    source: "human_feedback",
    feedbackIndex: 1,
    location: "Review summary",
  });
  expect(tasks[2]).not.toHaveProperty("file");
});

test("resolver dispositions can reject broad feedback but fixes require inspected edits", () => {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "pair-review-resolver-")),
  );
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "review.ts"), "export const value = 1;\n");
  const tasks = [
    {
      source: "human_feedback",
      feedbackIndex: 0,
      title: "Broad feedback",
      description: "Refactor the whole package.",
    },
    {
      source: "human_feedback",
      feedbackIndex: 1,
      file: "src/review.ts",
      title: "Concrete feedback",
    },
  ];
  const guard = new Guard(root);

  guard.disposition(
    0,
    "out of scope",
    "This is unrelated to the reviewed change.",
    undefined,
    tasks,
  );
  guard.read("src/review.ts");
  expect(() =>
    guard.disposition(
      1,
      "fixed",
      "Updated the value.",
      "src/review.ts",
      tasks,
    ),
  ).toThrow(/requires an inspected source edit/);
  guard.edit("src/review.ts", "value = 1", "value = 2");
  guard.disposition(
    1,
    "fixed",
    "Updated the incorrect value.",
    "src/review.ts",
    tasks,
  );

  expect(verifyDispositions(guard, tasks)).toEqual([
    {
      index: 0,
      state: "out of scope",
      reason: "This is unrelated to the reviewed change.",
    },
    {
      index: 1,
      state: "fixed",
      reason: "Updated the incorrect value.",
      path: "src/review.ts",
    },
  ]);
});

import { join } from "node:path";
import { realpathSync } from "node:fs";
import { run, cleanEnv, type Run } from "./process.ts";
import { safePath, privateDir, text, hash } from "./status.ts";
import { Sha, Branch, type Target } from "./types.ts";
export function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...cleanEnv(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    // Propagate trusted overrides into Git's local upload-pack children too.
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "uploadpack.packObjectsHook",
    GIT_CONFIG_VALUE_2: "git pack-objects",
    GIT_CONFIG_KEY_3: "credential.helper",
    GIT_CONFIG_VALUE_3: "!gh auth git-credential",
  };
}
export async function git(
  cwd: string,
  args: string[],
  exec: Run = run,
  signal?: AbortSignal,
) {
  return exec(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.file.allow=never",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=!gh auth git-credential",
      "-C",
      cwd,
      ...args,
    ],
    { env: gitEnv(), signal },
  );
}
export const remoteFor = (t: Target) =>
  t.kind === "pr" ? `https://${t.host}/${t.owner}/${t.repo}.git` : undefined;
export function validateRemote(url: string, t: Target) {
  if (url !== remoteFor(t)) throw Error("Canonical repository remote mismatch");
}
export async function retained(
  dir: string,
  t: Target,
  exec: Run = run,
  fixtureRemote?: string,
  signal?: AbortSignal,
) {
  safePath(dir);
  privateDir(dir);
  const bare = join(dir, "repo.git"),
    checkout = join(dir, "analysis");
  await git(dir, ["init", "--bare", bare], exec, signal);
  await git(bare, ["config", "core.hooksPath", "/dev/null"], exec, signal);
  await git(bare, ["config", "core.fsmonitor", "false"], exec, signal);
  if (t.kind === "pr") {
    const remote = fixtureRemote ?? remoteFor(t)!;
    if (!fixtureRemote) validateRemote(remote, t);
    await git(bare, ["remote", "add", "origin", remote], exec, signal);
    await git(
      bare,
      [
        ...(fixtureRemote ? ["-c", "protocol.file.allow=always"] : []),
        "fetch",
        "--no-tags",
        remote,
        t.baseSha,
        t.headSha,
      ],
      exec,
      signal,
    );
  } else {
    const origin = realpathSync(t.repoRoot);
    await git(
      bare,
      [
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "--no-tags",
        origin,
        t.baseSha,
        t.headSha,
      ],
      exec,
      signal,
    );
  }
  for (const s of [t.baseSha, t.headSha]) {
    Sha.parse(s);
    if (
      (await git(bare, ["cat-file", "-t", s], exec, signal)).trim() !==
      "commit"
    )
      throw Error("Ref is not a commit");
  }
  await git(
    bare,
    ["update-ref", "refs/heads/reviewed", t.headSha],
    exec,
    signal,
  );
  await git(
    bare,
    ["symbolic-ref", "HEAD", "refs/heads/reviewed"],
    exec,
    signal,
  );
  await git(
    bare,
    ["worktree", "add", "--detach", checkout, t.headSha],
    exec,
    signal,
  );
  if (
    (await git(checkout, ["rev-parse", "HEAD"], exec, signal)).trim() !==
      t.headSha ||
    (await git(checkout, ["status", "--porcelain"], exec, signal)).trim()
  )
    throw Error("Retained checkout verification failed");
  // Native PR mode uses a merge-base diff. Save both exact endpoint and native scoped diffs.
  const flags = [
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--no-relative",
    "--full-index",
    "--unified=3",
  ];
  const diff = await git(
    bare,
    ["diff", ...flags, `${t.baseSha}...${t.headSha}`],
    exec,
    signal,
  );
  const endpoints = await git(
    bare,
    ["diff", ...flags, t.baseSha, t.headSha],
    exec,
    signal,
  );
  text(join(dir, "diff.patch"), diff);
  text(join(dir, "endpoints.patch"), endpoints);
  return { bare, checkout, diff, digest: hash(diff) };
}
export async function resolverCheckout(
  bare: string,
  path: string,
  sha: string,
  exec: Run = run,
  signal?: AbortSignal,
) {
  safePath(path);
  Sha.parse(sha);
  await git(
    bare,
    ["worktree", "add", "--detach", path, sha],
    exec,
    signal,
  );
  if (
    (await git(path, ["rev-parse", "HEAD"], exec, signal)).trim() !== sha ||
    (await git(path, ["status", "--porcelain"], exec, signal)).trim()
  )
    throw Error("Resolver checkout verification failed");
  return path;
}
export function pushArgs(branch: string, sha: string) {
  Branch.parse(branch);
  Sha.parse(sha);
  return [
    "push",
    "origin",
    `HEAD:refs/heads/${branch}`,
    `--force-with-lease=refs/heads/${branch}:${sha}`,
  ];
}
export async function publish(
  path: string,
  t: Target,
  check: () => Promise<Target>,
  exec: Run = run,
  login?: string,
  signal?: AbortSignal,
) {
  safePath(path);
  signal?.throwIfAborted();
  if (t.kind !== "pr") throw Error("Local branch publication disabled");
  if (!login || t.author.toLowerCase() !== login.toLowerCase())
    throw Error("Publication requires authenticated ownership");
  const { unchanged } = await import("./data.ts");
  unchanged(t, await check());
  for (const args of [
    ["remote", "get-url", "--all", "origin"],
    ["remote", "get-url", "--push", "--all", "origin"],
  ]) {
    const urls = (await git(path, args, exec)).trim().split("\n");
    if (urls.length !== 1) throw Error("Ambiguous publication remotes");
    validateRemote(urls[0], t);
  }
  if ((await git(path, ["status", "--porcelain"], exec)).trim())
    throw Error("Publication requires a clean committed checkout");
  const tip = (
    await git(path, ["ls-remote", "origin", `refs/heads/${t.headBranch}`], exec)
  )
    .trim()
    .split(/\s+/);
  if (
    tip.length !== 2 ||
    tip[0] !== t.headSha ||
    tip[1] !== `refs/heads/${t.headBranch}`
  )
    throw Error("Remote head moved before publication");
  unchanged(t, await check());
  signal?.throwIfAborted();
  await git(path, pushArgs(t.headBranch, t.headSha), (command, args, options) =>
    exec(command, args, { ...options, signal }),
  );
  signal?.throwIfAborted();
}

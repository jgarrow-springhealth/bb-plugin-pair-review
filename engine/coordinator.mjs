import { join } from "node:path";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { execute, executeResolverLoop } from "./engine.ts";
import { GitHub, unchanged, owned } from "./data.ts";
import { run, processIdentity } from "./process.ts";
import { agent } from "./agent.ts";
import { publish, git } from "./git.ts";
import { verifySaved } from "./review.ts";
import {
  loadInput,
  readStatus,
  initial,
  atomicJson,
  withLock,
  now,
  json,
  hash,
  safePath,
  inside,
  finish,
  isSuperseded,
} from "./status.ts";
const [dir, mode = "run", token, indexText] = process.argv.slice(2);
safePath(dir);
if (!/^[a-f0-9]{48}$/.test(token ?? "")) throw Error("Missing launch identity");
const input = loadInput(dir);
const github = new GitHub(input.settings.hostname);
const identity = await processIdentity(process.pid);
if (identity.pgid !== process.pid)
  throw Error("Coordinator must own a detached process group");
const abort = new AbortController();
process.on("SIGTERM", () => abort.abort());
process.on("SIGINT", () => abort.abort());
await withLock(dir, async () => {
  atomicJson(join(dir, "coordinator.json"), {
    pid: process.pid,
    pgid: identity.pgid,
    token,
    identity,
    at: now(),
  });
  const status = existsSync(join(dir, "status.json"))
    ? readStatus(dir)
    : initial(input);
  status.coordinatorPid = process.pid;
  let validationHeartbeat;
  try {
    if (mode === "validated") {
      const e = status.entries[Number(indexText)];
      if (
        !e?.attention ||
        isSuperseded(e, status) ||
        !e.resolver.path
      )
        throw Error(
          "Only a converged manual resolver loop with retained edits is eligible",
        );
      abort.signal.throwIfAborted();
      safePath(e.resolver.path);
      status.state = "running";
      status.heartbeatAt = now();
      status.updatedAt = now();
      atomicJson(join(dir, "status.json"), status);
      validationHeartbeat = setInterval(() => {
        status.heartbeatAt = now();
        status.updatedAt = now();
        atomicJson(join(dir, "status.json"), status);
      }, 1000);
      const check = () =>
        e.target.kind === "pr"
          ? github.hydrate(e.target.url)
          : Promise.resolve(e.target);
      if (e.target.kind === "pr") {
        if (!owned(e.target, await github.login())) throw Error("Not your PR");
        unchanged(e.target, await check());
      }
      const resultPath = join(e.resolver.path, "..", "result.json");
      const result = json(resultPath);
      if (result.converged !== true || !Array.isArray(result.changed) || !result.changed.length)
        throw Error("Only a converged resolver loop with retained edits is eligible");
      const action = json(join(dir, "actions", "validation.json"));
      if (
        action.head !== e.target.headSha ||
        action.attempt !== e.attempt ||
        action.key !== e.key ||
        action.resultDigest !== hash(JSON.stringify(result)) ||
        action.confirmed !== true
      )
        throw Error(
          "Human validation attestation does not match reviewed work",
        );
      if (!inside(join(dir, "resolvers"), e.resolver.path))
        throw Error("Resolver path outside batch");
      if (
        (await git(e.resolver.path, ["rev-parse", "HEAD"])).trim() !==
        e.target.headSha
      )
        throw Error("Resolver head changed; preserve work for manual handling");
      if (
        result.dispositions.some((d) =>
          ["blocked", "needs human judgment"].includes(d.state),
        )
      )
        throw Error("Unresolved dispositions require manual work");
      const changed = (
        await git(e.resolver.path, ["diff", "--name-only", "-z"])
      )
        .split("\0")
        .filter(Boolean);
      if (!changed.length || changed.some((p) => !result.changed.includes(p)))
        throw Error("Unexpected changes in resolver checkout");
      abort.signal.throwIfAborted();
      await git(e.resolver.path, ["add", "--", ...changed]);
      abort.signal.throwIfAborted();
      await git(e.resolver.path, [
        "-c",
        "user.name=Pair Review Local",
        "-c",
        "user.email=pair-review@localhost",
        "commit",
        "-m",
        "Resolve verified review findings",
      ]);
      abort.signal.throwIfAborted();
      if (input.settings.publish && e.target.kind === "pr") {
        e.resolver.state = "publishing";
        status.updatedAt = now();
        atomicJson(join(dir, "status.json"), status);
        await publish(
          e.resolver.path,
          e.target,
          check,
          run,
          await github.login(),
          abort.signal,
        );
      }
      e.resolver.state =
        input.settings.publish && e.target.kind === "pr"
          ? "published"
          : "resolved_local";
      delete e.attention;
      finish(status);
      status.updatedAt = now();
      atomicJson(join(dir, "status.json"), status);
    } else {
      const dependencies = {
        exec: run,
        github,
        analyze: (await import("./review.ts")).analyze,
        resolve: agent,
      };
      if (mode === "resolve-loop") {
        const action = json(join(dir, "actions", "resolver-loop.json"));
        if (
          action.confirmed !== true ||
          action.index !== Number(indexText) ||
          !Number.isInteger(action.maxRounds)
        )
          throw Error("Resolver loop confirmation is missing or does not match");
        await executeResolverLoop(
          dir,
          input,
          status,
          Number(indexText),
          { maxRounds: action.maxRounds },
          abort.signal,
          dependencies,
        );
      } else {
        await execute(
          dir,
          input,
          status,
          mode,
          indexText === undefined ? undefined : Number(indexText),
          abort.signal,
          dependencies,
        );
      }
    }
  } catch (err) {
    if (mode === "validated") {
      const e = status.entries[Number(indexText)];
      if (e) {
        e.resolver.state = "needs_attention";
        e.attention = {
          reason: `Publication or local finalization stopped: ${err}`,
          reviewedSha: e.target.headSha,
          branch:
            e.target.kind === "pr" ? e.target.headBranch : e.target.branch,
          path: e.resolver.path,
          at: now(),
        };
        try {
          if (e.target.kind === "pr")
            e.attention.remoteSha = (
              await github.hydrate(e.target.url)
            ).headSha;
        } catch {}
      }
    }
    status.state = abort.signal.aborted ? "cancelled" : "needs_attention";
    status.error = String(err);
    status.updatedAt = now();
    atomicJson(join(dir, "status.json"), status);
    throw err;
  } finally {
    clearInterval(validationHeartbeat);
  }
});

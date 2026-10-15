import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { processIdentity, run, type Run } from "./process.ts";
import {
  readStatus,
  json,
  atomicJson,
  now,
  finish,
  warnings,
  withLock,
} from "./status.ts";
import { attention } from "./engine.ts";
/** Reconcile only after BOTH the exact coordinator and its entire original group are gone. */
export async function recoverInterrupted(dir: string, exec: Run = run) {
  const s = readStatus(dir);
  if (!["queued", "running"].includes(s.state)) return s;
  const saved = json(join(dir, "coordinator.json"));
  let live;
  try {
    live = await processIdentity(saved.pid, exec);
  } catch {}
  if (live && JSON.stringify(live) === JSON.stringify(saved.identity))
    throw Error("Batch coordinator is active");
  const groups = (await exec("ps", ["-e", "-o", "pgid="]))
    .trim()
    .split(/\s+/)
    .map(Number);
  if (groups.includes(saved.pgid))
    throw Error(
      "Original process group still exists; refusing to recover or signal it",
    );
  if (warnings(s).some((w) => w.includes("multiple live")))
    throw Error("Corrupt status; manual reconciliation required");
  // Reject races with a newer coordinator. A lock belonging to another writer is never removed.
  if (json(join(dir, "coordinator.json")).token !== saved.token)
    throw Error("Coordinator changed during recovery");
  const lock = join(dir, "writer.lock");
  if (existsSync(lock)) {
    if (json(lock).pid !== saved.pid) throw Error("Unknown writer lock");
    rmSync(lock);
  }
  return withLock(dir, async () => {
    if (json(join(dir, "coordinator.json")).token !== saved.token)
      throw Error("Coordinator changed during recovery");
    for (const e of s.entries) {
      if (["queued", "preparing", "reviewing"].includes(e.review.state))
        attention(
          e,
          "Coordinator interrupted before a verifiable review completed",
        );
      else if (
        ["resolving", "reviewing", "publishing", "pending"].includes(
          e.resolver.state,
        )
      ) {
        e.resolver.state = "interrupted";
        e.resolver.error =
          "Coordinator stopped; local work retained. Start a new manual resolver loop after inspecting the retained checkout.";
      }
    }
    finish(s);
    s.updatedAt = now();
    atomicJson(join(dir, "status.json"), s);
    return s;
  });
}
export async function health(dir: string, exec: Run = run) {
  const s = readStatus(dir);
  if (s.state !== "running" || !s.coordinatorPid) return [];
  try {
    const saved = json(join(dir, "coordinator.json"));
    const live = await processIdentity(s.coordinatorPid, exec);
    if (JSON.stringify(live) !== JSON.stringify(saved.identity))
      return ["Coordinator process identity changed; no signal will be sent"];
    return [];
  } catch {
    return [`Coordinator process ${s.coordinatorPid} is no longer running`];
  }
}

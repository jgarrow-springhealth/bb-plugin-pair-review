import { describe, expect, test, vi } from "vitest";
import { StaleReviewError, refreshStalePr, verifyOutput } from "../engine/review";

const OLD = "dc57fcc094ed48c4b642c922cb896e2df9dde6c5";
const NEW = "a71cda37fd0d4b4c79f3e0a73d5984ae2e33c351";
const target: any = {
  kind: "pr",
  owner: "SpringCare",
  repo: "caregiver-portal",
  number: 5823,
  baseSha: "383d156457b9130a2a8d48337fe1922a2934f79a",
  headSha: NEW,
};
const envelope = (headSha: string) => ({
  ok: true,
  mode: "pr",
  consolidation: "success",
  count: 0,
  suggestions: [],
  run: {
    id: "run-1",
    review_id: 58,
    provider: "pi",
    model: "m",
    head_sha: headSha,
    status: "completed",
    level_outcomes: { level1: "success" },
  },
});

describe("verifyOutput stale PR copy", () => {
  test("explains that Pair Review analyzed an out-of-date commit", () => {
    let error: unknown;
    try {
      verifyOutput(envelope(OLD), target, "", {}, {}, {});
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(StaleReviewError);
    expect((error as Error).message).toContain("dc57fcc");
    expect((error as Error).message).toContain("a71cda3");
    expect((error as Error).message).toMatch(/Refresh the PR from GitHub/);
  });
});

describe("refreshStalePr", () => {
  const runtime = { database: "/db", dbId: "db-1", port: 7247 };
  const healthy = () =>
    new Response(JSON.stringify({ service: "pair-review", dbId: "db-1" }));

  test("does nothing when the saved PR copy is current", async () => {
    const fetchImpl = vi.fn();
    const result = await refreshStalePr(target, runtime, {
      fetch: fetchImpl as any,
      readStored: () => ({ headSha: NEW, baseSha: target.baseSha }),
    });
    expect(result).toBe("not_needed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("refreshes a stale saved PR copy through the running app", async () => {
    let stored = { headSha: OLD, baseSha: "96d1ab5b4c7358a0f13b8804250b0f03a4f51d2c" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/health")) return healthy();
      expect(url).toBe(
        "http://127.0.0.1:7247/api/pr/SpringCare/caregiver-portal/5823/refresh",
      );
      expect(init?.method).toBe("POST");
      stored = { headSha: NEW, baseSha: target.baseSha };
      return new Response("{}");
    });
    const result = await refreshStalePr(target, runtime, {
      fetch: fetchImpl as any,
      readStored: () => stored,
    });
    expect(result).toBe("refreshed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("leaves it to the in-process CLI when no matching app is running", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ service: "pair-review", dbId: "other" })),
    );
    const result = await refreshStalePr(target, runtime, {
      fetch: fetchImpl as any,
      readStored: () => ({ headSha: OLD, baseSha: target.baseSha }),
    });
    expect(result).toBe("not_needed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("explains a failed refresh", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/health")
        ? healthy()
        : new Response(JSON.stringify({ error: "Worktree is in use by stack analysis" }), {
            status: 409,
          }),
    );
    await expect(
      refreshStalePr(target, runtime, {
        fetch: fetchImpl as any,
        readStored: () => ({ headSha: OLD, baseSha: target.baseSha }),
      }),
    ).rejects.toThrow(/refreshing it from GitHub failed: Worktree is in use by stack analysis/);
  });

  test("explains when GitHub moved past the queued commit", async () => {
    let stored = { headSha: OLD, baseSha: target.baseSha };
    const NEWER = "b".repeat(40);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) return healthy();
      stored = { headSha: NEWER, baseSha: target.baseSha };
      return new Response("{}");
    });
    await expect(
      refreshStalePr(target, runtime, {
        fetch: fetchImpl as any,
        readStored: () => stored,
      }),
    ).rejects.toThrow(/changed on GitHub after the review was queued/);
  });
});

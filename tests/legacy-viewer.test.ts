import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  retainedPairReviewViewer,
  selectLegacyPairReviewPort,
} from "../service";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".pair-review-legacy-viewer-"));
  roots.push(root);
  const reviewPath = join(root, "review");
  const home = join(reviewPath, "home");
  mkdirSync(home, { recursive: true });
  const runId = "434da389-b57e-4a86-b397-3fc6269de081";
  const target = {
    kind: "pr",
    host: "github.com",
    owner: "ExampleOrg",
    repo: "example-app",
    number: 6108,
  };
  const uiPath = `/pr/ExampleOrg/example-app/6108?runId=${runId}`;
  const saved = {
    ok: true,
    mode: "pr",
    consolidation: "success",
    run: {
      id: runId,
      review_id: 67,
      head_sha: "a".repeat(40),
      status: "completed",
      provider: "pi",
      model: "openai/gpt-5.6-sol",
      level_outcomes: {},
    },
    suggestions: [],
    count: 0,
  };
  return { reviewPath, home, target, uiPath, saved };
}

describe("retained Pair Review viewer selection", () => {
  test("skips a legacy viewer for another database and selects the next port", async () => {
    const probe = vi.fn(async (port: number) =>
      port === 7248
        ? {
            ready: false,
            observed: {
              service: "pair-review",
              version: "5.3.4",
              dbId: "other-db",
            },
            error: null,
          }
        : { ready: false, observed: null, error: null },
    );
    const isFree = vi.fn(async () => true);

    await expect(
      selectLegacyPairReviewPort(
        7248,
        { version: "5.3.4", dbId: "wanted-db" },
        { probe: probe as any, isFree },
      ),
    ).resolves.toEqual({ port: 7249, running: false });
    expect(isFree).toHaveBeenCalledOnce();
    expect(isFree).toHaveBeenCalledWith(7249);
  });

  test("reuses an already-running viewer for the same retained database", async () => {
    const isFree = vi.fn(async () => true);

    await expect(
      selectLegacyPairReviewPort(
        7248,
        { version: "5.3.4", dbId: "wanted-db" },
        {
          probe: vi.fn(async () => ({
            ready: true,
            observed: {
              service: "pair-review",
              version: "5.3.4",
              dbId: "wanted-db",
            },
            error: null,
          })) as any,
          isFree,
        },
      ),
    ).resolves.toEqual({ port: 7248, running: true });
    expect(isFree).not.toHaveBeenCalled();
  });

  test("opens a verified legacy run from its retained isolated home", () => {
    const value = fixture();

    expect(
      retainedPairReviewViewer(
        {
          target: value.target,
          review: {
            path: value.reviewPath,
            home: value.home,
            uiPath: value.uiPath,
          },
        } as any,
        value.saved as any,
        { home: "/shared/home", dbId: "shared-db" },
      ),
    ).toEqual({ kind: "legacy", home: value.home, uiPath: value.uiPath });
  });

  test("keeps current shared-database runs on the configured app", () => {
    const value = fixture();

    expect(
      retainedPairReviewViewer(
        {
          target: value.target,
          review: {
            path: value.reviewPath,
            home: value.home,
            uiPath: value.uiPath,
            dbId: "shared-db",
          },
        } as any,
        value.saved as any,
        { home: value.home, dbId: "shared-db" },
      ),
    ).toEqual({ kind: "shared", uiPath: value.uiPath });
  });

  test("still rejects retained routes and database identities that do not match", () => {
    const value = fixture();
    expect(() =>
      retainedPairReviewViewer(
        {
          target: value.target,
          review: {
            path: value.reviewPath,
            home: value.home,
            uiPath: `${value.uiPath}-other`,
          },
        } as any,
        value.saved as any,
        { home: value.home, dbId: "shared-db" },
      ),
    ).toThrow("Retained app route does not match the verified review");

    expect(() =>
      retainedPairReviewViewer(
        {
          target: value.target,
          review: {
            path: value.reviewPath,
            home: value.home,
            uiPath: value.uiPath,
            dbId: "different-db",
          },
        } as any,
        value.saved as any,
        { home: value.home, dbId: "shared-db" },
      ),
    ).toThrow("does not belong to the Pair Review database");
  });
});

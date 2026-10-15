import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { argumentsFor, sharedPairReviewRuntime } from "../engine/review";
import { Settings, type Entry, type Target } from "../engine/types";
import {
  dismissalId,
  loadDismissals,
  setDismissed,
} from "../engine/status";

describe("shared Pair Review runtime", () => {
  test("dismisses BB runs without deleting retained evidence and can restore them", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "pair-review-dismiss-"));
    const target: Target = {
      kind: "pr",
      host: "github.com",
      owner: "acme",
      repo: "widget",
      number: 7,
      url: "https://github.com/acme/widget/pull/7",
      title: "Review me",
      author: "author",
      baseBranch: "main",
      baseSha: "a".repeat(40),
      headBranch: "feature",
      headSha: "b".repeat(40),
      headRepo: "acme/widget",
    };
    const entry = { key: "github.com/acme/widget#7", target } as Entry;

    setDismissed(root, "old-batch", 0, entry, true, "2026-10-07T00:00:00.000Z");
    expect(loadDismissals(root).entries[dismissalId("old-batch", 0)]).toEqual({
      at: "2026-10-07T00:00:00.000Z",
      key: entry.key,
      head: target.headSha,
    });

    setDismissed(root, "old-batch", 0, entry, false);
    expect(loadDismissals(root).entries).toEqual({});
  });

  test("uses configured providers with native team metadata and shared database", () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), "pair-review-shared-"));
    const dir = join(home, ".pair-review");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ port: 8123, db_name: "history.db" }),
    );
    writeFileSync(
      join(dir, "pi-settings.json"),
      JSON.stringify({
        version: 1,
        reviewModel: "openai/gpt-5.6-sol",
        fixModel: "anthropic/claude-opus-4-6",
        teams: ["ExampleOrg/platform"],
        teammates: ["alice"],
      }),
    );

    const runtime = sharedPairReviewRuntime(
      {
        reviewProvider: "claude",
        reviewModel: "opus",
        fixProvider: "codex",
        fixModel: "gpt-5.6-sol-high",
      },
      home,
    );

    expect(runtime).toMatchObject({
      home: realpathSync(home),
      database: join(dir, "history.db"),
      port: 8123,
      reviewProvider: "claude",
      reviewModel: "opus",
      fixProvider: "codex",
      fixModel: "gpt-5.6-sol-high",
      teams: ["ExampleOrg/platform"],
      teammates: ["alice"],
    });
  });

  test("delegates headless reviews instead of forcing an isolated server", () => {
    const target: Target = {
      kind: "pr",
      host: "github.com",
      owner: "acme",
      repo: "widget",
      number: 7,
      url: "https://github.com/acme/widget/pull/7",
      title: "Review me",
      author: "author",
      baseBranch: "main",
      baseSha: "a".repeat(40),
      headBranch: "feature",
      headSha: "b".repeat(40),
      headRepo: "acme/widget",
    };
    const args = argumentsFor(
      target,
      Settings.parse({ reviewProvider: "claude", reviewModel: "opus" }),
      "unused",
    );

    expect(args).toContain("--provider");
    expect(args).toContain("claude");
    expect(args).toContain("opus");
    expect(args).not.toContain("--no-server");
  });
});

import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTeams,
  parseTeammates,
  requestTag,
  repositoryFor,
} from "../queue";
import { Preferences } from "../contract";
import { GitHub } from "../engine/data";
test("configuration is normalized and validated, with no organization defaults", () => {
  expect(
    parseTeams("Example/Frontend, example/frontend\nexample/platform"),
  ).toEqual(["example/frontend", "example/platform"]);
  expect(parseTeammates("Alice, bob\nALICE")).toEqual(["alice", "bob"]);
  expect(parseTeams("")).toEqual([]);
  expect(parseTeammates("")).toEqual([]);
  for (const value of [
    "frontend",
    "example/a/b",
    "example/team is:closed",
    "example/team?token=x",
  ])
    expect(() => parseTeams(value)).toThrow();
  expect(() => parseTeammates("bot[bot]")).toThrow();
  expect(() => parseTeammates("alice; command")).toThrow();
  expect(
    Preferences.shape.teams.safeParse("example/team -author:someone").success,
  ).toBe(false);
});
test("teammate direct requests are distinct from other direct requests, including bot authors", () => {
  expect(requestTag("Alice", ["alice"])).toBe("Teammate request");
  expect(requestTag("outsider", ["alice"])).toBe("Other direct request");
  expect(requestTag("dependabot[bot]", ["alice"])).toBe("Other direct request");
  expect(requestTag("outsider", ["alice"], true)).toBe("Team request");
  expect(requestTag("Alice", ["alice"], true)).toBe("Team request");
  expect(repositoryFor("https://github.com/example/project/pull/12")).toBe(
    "example/project",
  );
});
test("team discovery uses a validated read-only team search and fails closed on partial results", async () => {
  const calls: string[][] = [];
  let incomplete = false;
  const gh = new GitHub("github.com", async (command, args) => {
    expect(command).toBe("gh");
    calls.push(args);
    return JSON.stringify({
      total_count: 0,
      incomplete_results: incomplete,
      items: [],
    });
  });
  const root = mkdtempSync(join(tmpdir(), "pair-review-team-test-"));
  expect(await gh.discoverTeam("example/frontend", root)).toEqual([]);
  expect(decodeURIComponent(calls[0].at(-1)!)).toContain(
    "team-review-requested:example/frontend",
  );
  expect(calls[0]).toContain("GET");
  incomplete = true;
  await expect(gh.discoverTeam("example/frontend", root)).rejects.toThrow();
  const count = calls.length;
  await expect(
    gh.discoverTeam("example/frontend/extra", root),
  ).rejects.toThrow();
  expect(calls).toHaveLength(count);
});

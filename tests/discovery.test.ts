import { expect, test } from "vitest";
import { Actor } from "../engine/types";
import { GitHub, normalizePR, parseURL } from "../engine/data";
import { repositoryLink } from "../repository";
const url = "https://github.com/example/project/pull/12";
const repo = {
  full_name: "example/project",
  html_url: "https://github.com/example/project",
};
function raw(author: string) {
  return {
    number: 12,
    html_url: url,
    title: "Dependency update",
    updated_at: "2026-10-07T12:34:56Z",
    state: "open",
    draft: true,
    user: { login: author },
    base: { sha: "a".repeat(40), ref: "main", repo },
    head: { sha: "b".repeat(40), ref: "update", repo },
  };
}
test.each(["dependabot[bot]", "github-actions[bot]", "ordinary-user"])(
  "hydrates valid GitHub author %s",
  (author) => {
    expect(Actor.parse(author)).toBe(author);
    expect(normalizePR(raw(author), url)).toMatchObject({
      author,
      draft: true,
      updatedAt: "2026-10-07T12:34:56Z",
      headBranch: "update",
    });
  },
);
test.each(["bot[admin]", "bot[bot]/escape", "bot\n[bot]", "bot\\b"])(
  "rejects malformed actor %s",
  (author) => expect(() => normalizePR(raw(author), url)).toThrow(),
);
test("loads an exact committed PR diff through the read-only compare endpoint", async () => {
  const calls: { command: string; args: string[] }[] = [];
  const github = new GitHub("github.com", async (command, args) => {
    calls.push({ command, args });
    return "diff --git a/a.ts b/a.ts\n";
  });
  const target = normalizePR(raw("ordinary-user"), url);
  await expect(github.diff(target)).resolves.toContain("diff --git");
  expect(calls).toEqual([
    {
      command: "gh",
      args: [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "-H",
        "Accept: application/vnd.github.v3.diff",
        `repos/example/project/compare/${"a".repeat(40)}...${"b".repeat(40)}`,
      ],
    },
  ]);
});
test("bot authors do not relax canonical repository coordinates", () =>
  expect(() =>
    parseURL("https://github.com/dependabot[bot]/project/pull/12"),
  ).toThrow());
test.each([
  "git@github.com:example/pair-review.git",
  "https://github.com/example/pair-review.git",
  "https://github.com/example/pair-review",
])("derives a canonical display link from %s", (remote) =>
  expect(repositoryLink(remote)).toEqual({
    name: "example/pair-review",
    url: "https://github.com/example/pair-review",
  }),
);
test.each([
  "https://token@github.com/example/pair-review",
  "https://github.com.evil.example/example/pair-review",
  "https://github.com/example/pair-review?token=hidden",
  "git@github.com:../pair-review.git",
  "https://github.com/example/a%2Fb",
])("does not expose unsafe origin %s", (remote) =>
  expect(repositoryLink(remote)).toBeNull(),
);

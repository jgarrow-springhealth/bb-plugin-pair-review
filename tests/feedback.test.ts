import { expect, test, vi } from "vitest";
import { GitHub } from "../engine/data";
import { PR } from "../engine/types";

const target = PR.parse({
  kind: "pr",
  host: "github.com",
  owner: "example",
  repo: "project",
  number: 12,
  url: "https://github.com/example/project/pull/12",
  title: "Change behavior",
  author: "pull-author",
  baseBranch: "main",
  baseSha: "a".repeat(40),
  headBranch: "feature",
  headSha: "b".repeat(40),
  headRepo: "example/project",
});
const page = (nodes: unknown[]) => ({
  pageInfo: { hasNextPage: false },
  nodes,
});
const comment = (
  login: string,
  body: string,
  typename = "User",
  path?: string,
) => ({
  body,
  path,
  line: path ? 42 : null,
  url: `https://github.com/example/project/pull/12#${login}`,
  author: { login, __typename: typename },
});

test("captures human feedback for any PR while excluding authors, bots, and resolved threads", async () => {
  const payload = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: page([
            {
              isResolved: false,
              comments: page([
                comment(
                  "human-reviewer",
                  "Please guard this branch.",
                  "User",
                  "src/view.ts",
                ),
                comment(
                  "review-bot",
                  "Automated thread",
                  "User",
                  "src/view.ts",
                ),
                comment(
                  "github-actions",
                  "Automated thread",
                  "Bot",
                  "src/view.ts",
                ),
              ]),
            },
            {
              isResolved: true,
              comments: page([
                comment(
                  "other-reviewer",
                  "Already resolved",
                  "User",
                  "src/old.ts",
                ),
              ]),
            },
          ]),
          reviews: page([
            comment("pull-author", "Author summary"),
            comment("terraform-robot", "Automated summary"),
            comment("summary-reviewer", "Human review summary"),
          ]),
          comments: page([
            comment("conversation-reviewer", "Please document this behavior."),
            comment("automation", "Deployment succeeded."),
          ]),
        },
      },
    },
  };
  const exec = vi.fn(async () => JSON.stringify(payload));
  const feedback = await new GitHub("github.com", exec as any).feedback(target);

  expect(feedback.complete).toBe(true);
  expect(feedback.comments).toEqual([
    expect.objectContaining({
      author: "human-reviewer",
      location: "src/view.ts:42",
    }),
    expect.objectContaining({
      author: "summary-reviewer",
      location: "Review summary",
    }),
    expect.objectContaining({
      author: "conversation-reviewer",
      location: "PR conversation",
    }),
  ]);
  expect(exec).toHaveBeenCalledOnce();
});

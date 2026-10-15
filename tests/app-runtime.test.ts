import { describe, expect, test, vi } from "vitest";
import {
  githubTokenForPairReviewViewer,
  pairReviewAppEnv,
  pairReviewGitCredentialEnv,
  pairReviewGitHubConfigDir,
  pairReviewPrPath,
  patchStats,
} from "../service";
import { subprocessFailureDetail } from "../engine/process";

describe("Pair Review app runtime", () => {
  test("counts files and changed lines from the exact unified diff", () => {
    expect(
      patchStats(
        [
          "diff --git a/one.ts b/one.ts",
          "--- a/one.ts",
          "+++ b/one.ts",
          "@@ -1,2 +1,3 @@",
          "-old",
          "+new",
          "+added",
          " context",
          "diff --git a/two.ts b/two.ts",
          "--- a/two.ts",
          "+++ b/two.ts",
          "@@ -4 +4 @@",
          "-before",
          "+after",
        ].join("\n"),
      ),
    ).toEqual({ files: 2, additions: 3, deletions: 2 });
  });

  test("builds the Pair Review PR route before any analysis run exists", () => {
    expect(
      pairReviewPrPath({ owner: "example", repo: "project", number: 12 }),
    ).toBe("/pr/example/project/12");
  });

  test("uses the trusted shared-home GitHub credentials for a legacy viewer", () => {
    expect(
      pairReviewGitHubConfigDir(
        "/retained/review/home",
        { HOME: "/host/home" },
        "/trusted/shared/home",
      ),
    ).toBe("/trusted/shared/home/.config/gh");
    expect(
      pairReviewGitHubConfigDir(
        "/retained/review/home",
        { GH_CONFIG_DIR: "/explicit/gh" },
        "/trusted/shared/home",
      ),
    ).toBe("/explicit/gh");
  });

  test("loads the GitHub token under the trusted shared HOME without persisting it", async () => {
    const exec = vi.fn(async () => "  test-github-token\n");

    await expect(
      githubTokenForPairReviewViewer(
        "/trusted/shared/home",
        "github.com",
        { PATH: "/usr/bin:/bin", GH_CONFIG_DIR: "/trusted/gh" },
        exec as any,
      ),
    ).resolves.toBe("test-github-token");
    expect(exec).toHaveBeenCalledWith(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      expect.objectContaining({
        env: expect.objectContaining({
          HOME: "/trusted/shared/home",
          GH_CONFIG_DIR: "/trusted/gh",
        }),
        timeout: 15_000,
      }),
    );
  });

  test("passes GitHub HTTPS credentials to git without rewriting the remote", () => {
    const env = pairReviewGitCredentialEnv("GitHub.COM", "test-github-token");

    expect(env).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(
        "x-access-token:test-github-token",
      ).toString("base64")}`,
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  test("degrades to an unauthenticated legacy viewer when gh has no token", async () => {
    await expect(
      githubTokenForPairReviewViewer(
        "/trusted/shared/home",
        "github.com",
        {},
        vi.fn(async () => {
          throw new Error("not logged in");
        }) as any,
      ),
    ).resolves.toBeUndefined();
  });

  test("loads an OpenAI key into memory when BB starts the shared app", () => {
    const env = pairReviewAppEnv(
      {
        home: "/trusted/home",
        reviewProvider: "pi",
        reviewModel: "openai/gpt-5.6-sol",
        port: 7247,
      },
      {
        HOME: "/host/home",
        SHELL: "/bin/zsh",
        PATH: "/usr/bin:/bin",
        NODE_OPTIONS: "--import untrusted",
        PORT: "9999",
      },
      () => "test-openai-api-key",
    );

    expect(env.HOME).toBe("/trusted/home");
    expect(env.PORT).toBe("7247");
    expect(env.OPENAI_API_KEY).toBe("test-openai-api-key");
    expect(env.PAIR_REVIEW_NO_OPEN).toBe("1");
    expect(env.GH_CONFIG_DIR).toBe("/trusted/home/.config/gh");
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  test("does not request an OpenAI key for another provider", () => {
    let calls = 0;
    const env = pairReviewAppEnv(
      {
        home: "/trusted/home",
        reviewProvider: "claude",
        reviewModel: "opus",
        port: 7247,
      },
      { HOME: "/host/home", PATH: "/usr/bin:/bin" },
      () => {
        calls++;
        return "unused";
      },
    );

    expect(calls).toBe(0);
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  test("surfaces structured stdout errors when a CLI exits silently", () => {
    expect(
      subprocessFailureDetail(
        "",
        JSON.stringify({
          ok: false,
          error: { message: "Delegated analysis failed: provider unavailable" },
        }),
      ),
    ).toBe("Delegated analysis failed: provider unavailable");
  });
});

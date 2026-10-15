import { expect, test } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginShellOpenAIKey } from "../engine/model-auth";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const shell = "/bin/zsh";
function context(zshrc: string) {
  const home = mkdtempSync(join(tmpdir(), "pair-review-auth-home-"));
  writeFileSync(join(home, ".zshrc"), zshrc, { mode: 0o600 });
  return {
    home,
    env: {
      HOME: "/isolated/review/home",
      SHELL: shell,
      PAIR_BATCH_AUTH_HOME: home,
      PAIR_BATCH_AUTH_SHELL: shell,
      PAIR_BATCH_AUTH_PATH: "/usr/bin:/bin",
    },
  };
}
test("loads only the regular Pi OpenAI key from a trusted login shell", () => {
  const { home, env } = context(
    'print startup-noise\nprint -r -- "$PWD" > "$HOME/cwd"\nexport OPENAI_API_KEY="test-openai-api-key"\n',
  );
  expect(loginShellOpenAIKey(env)).toBe("test-openai-api-key");
  expect(readFileSync(join(home, "cwd"), "utf8").trim()).toBe(
    realpathSync(home),
  );
});
test("runtime OpenAI override stays in memory instead of auth.json", async () => {
  const home = mkdtempSync(join(tmpdir(), "pair-review-runtime-auth-"));
  const authPath = join(home, "auth.json");
  writeFileSync(authPath, "{}\n", { mode: 0o600 });
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    allowModelNetwork: false,
  });
  await runtime.setRuntimeApiKey("openai", "test-openai-api-key");
  expect(runtime.hasConfiguredAuth("openai")).toBe(true);
  expect(runtime.isUsingOAuth("openai")).toBe(false);
  expect(readFileSync(authPath, "utf8")).toBe("{}\n");
});
test("does not inherit an ambient key or support arbitrary shells", () => {
  const { env } = context("");
  expect(
    loginShellOpenAIKey({ ...env, OPENAI_API_KEY: "ambient-secret" }),
  ).toBeUndefined();
  expect(
    loginShellOpenAIKey({ ...env, PAIR_BATCH_AUTH_SHELL: "/usr/bin/env" }),
  ).toBeUndefined();
});

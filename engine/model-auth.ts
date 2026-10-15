import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { cleanEnv } from "./process.ts";
const supportedShells = new Set(["/bin/zsh", "/bin/bash"]);
/**
 * Reads the OpenAI key exactly as the user's regular interactive login shell
 * does. The key stays in this trusted model-transport process and is installed
 * only as an in-memory ModelRuntime override.
 */
export function loginShellOpenAIKey(source: NodeJS.ProcessEnv = process.env) {
  const shellValue = source.PAIR_BATCH_AUTH_SHELL ?? source.SHELL ?? "";
  const homeValue = source.PAIR_BATCH_AUTH_HOME ?? source.HOME ?? homedir();
  if (!isAbsolute(shellValue) || !isAbsolute(homeValue)) return undefined;
  let shell: string, home: string;
  try {
    shell = realpathSync(shellValue);
    home = realpathSync(homeValue);
  } catch {
    return undefined;
  }
  if (!supportedShells.has(shell)) return undefined;
  const marker = `PAIR_BATCH_OPENAI_${randomBytes(12).toString("hex")}_`;
  const env = Object.fromEntries(
    Object.entries({
      HOME: home,
      USER: source.USER,
      LOGNAME: source.LOGNAME,
      SHELL: shell,
      PATH: source.PAIR_BATCH_AUTH_PATH ?? cleanEnv(source).PATH,
      LANG: source.LANG,
      LC_ALL: source.LC_ALL,
      TMPDIR: source.TMPDIR,
    }).filter(([, value]) => typeof value === "string"),
  ) as NodeJS.ProcessEnv;
  const result = spawnSync(
    shell,
    ["-lic", `printf '\\n${marker}%s\\n' "\${OPENAI_API_KEY-}"`],
    {
      cwd: home,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    },
  );
  if (result.status !== 0 || result.error) return undefined;
  const position = result.stdout.lastIndexOf(marker);
  if (position < 0) return undefined;
  const key = result.stdout
    .slice(position + marker.length)
    .split(/\r?\n/, 1)[0]
    ?.trim();
  if (!key || !/^[^\s\x00-\x1f\x7f]{8,4096}$/.test(key)) return undefined;
  return key;
}

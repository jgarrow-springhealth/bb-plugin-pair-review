import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { pairReviewInstallation } from "../service";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pair-review-installation-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@in-the-loop-labs/pair-review", version: "5.4.0" }),
  );
  for (const name of ["pair-review", "pair-review.js"]) {
    const executable = join(bin, name);
    writeFileSync(executable, "#!/usr/bin/env node\n");
    chmodSync(executable, 0o755);
  }
  return { root, bin, executable: join(bin, "pair-review.js") };
}

describe("Pair Review installation selection", () => {
  test("resolves the original installed pair-review command from PATH", () => {
    const installed = fixture();

    expect(
      pairReviewInstallation("pair-review", { PATH: installed.bin }),
    ).toEqual({
      root: installed.root,
      executable: installed.executable,
      version: "5.4.0",
    });
  });

  test("uses an explicit compatible local fork directory", () => {
    const fork = fixture();

    expect(pairReviewInstallation(fork.root, { PATH: "" })).toEqual({
      root: fork.root,
      executable: fork.executable,
      version: "5.4.0",
    });
  });

  test("explains how to recover when the installed command is absent", () => {
    expect(() => pairReviewInstallation("pair-review", { PATH: "" })).toThrow(
      /Install @in-the-loop-labs\/pair-review or configure a local fork/,
    );
  });
});

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agent } from "../engine/agent";
import {
  changedWorkspaceFiles,
  createIsolatedWorkspace,
  structuredAgentInvocation,
} from "../engine/structured-cli";

describe("provider-neutral resolver workspace", () => {
  test("copies bounded source while excluding credentials and links", () => {
    const source = mkdtempSync(join(tmpdir(), "resolver-source-"));
    mkdirSync(join(source, "src"));
    writeFileSync(join(source, "src", "index.ts"), "export const before = true;\n");
    writeFileSync(join(source, ".env"), "SECRET=do-not-copy\n");
    symlinkSync(join(source, "src", "index.ts"), join(source, "linked.ts"));

    const workspace = createIsolatedWorkspace(source);
    try {
      expect(readFileSync(join(workspace.root, "src", "index.ts"), "utf8")).toContain(
        "before",
      );
      expect(workspace.files.has(".env")).toBe(false);
      expect(workspace.files.has("linked.ts")).toBe(false);
    } finally {
      workspace.cleanup();
    }
  });

  test("reports edits and rejects files created by an external agent", () => {
    const source = mkdtempSync(join(tmpdir(), "resolver-source-"));
    writeFileSync(join(source, "index.ts"), "export const before = true;\n");
    const workspace = createIsolatedWorkspace(source);
    try {
      writeFileSync(join(workspace.root, "index.ts"), "export const after = true;\n");
      expect([...changedWorkspaceFiles(workspace)]).toHaveLength(1);
      writeFileSync(join(workspace.root, "created.ts"), "not allowed\n");
      expect(() => changedWorkspaceFiles(workspace)).toThrow(
        "may not create source files",
      );
    } finally {
      workspace.cleanup();
    }
  });

  test("applies a fake Claude resolver edit only through the guarded checkout", async () => {
    const source = mkdtempSync(
      join(realpathSync(tmpdir()), "resolver-source-"),
    );
    writeFileSync(join(source, "index.ts"), "export const broken = true;\n");
    const bin = mkdtempSync(join(tmpdir(), "resolver-bin-"));
    const executable = join(bin, "claude");
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nconst fs=require("fs"),p=require("path");\nprocess.stdin.resume();\nprocess.stdin.on("end",()=>{\n const f=p.join(process.cwd(),"index.ts");\n fs.writeFileSync(f,"export const broken = false;\\n");\n process.stdout.write(JSON.stringify({structured_output:{dispositions:[{index:0,state:"fixed",reason:"Corrected the value",path:"index.ts"}]}}));\n});\n`,
    );
    chmodSync(executable, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
      const result = await agent({
        root: source,
        provider: "claude",
        model: "fake",
        thinking: "low",
        prompt: "Resolve the indexed task.",
        diff: "diff --git a/index.ts b/index.ts",
        resolve: true,
        findings: [{ file: "index.ts", title: "Incorrect value" }],
      });
      expect(result.changed).toEqual(["index.ts"]);
      expect(result.dispositions).toEqual([
        {
          index: 0,
          state: "fixed",
          reason: "Corrected the value",
          path: "index.ts",
        },
      ]);
      expect(readFileSync(join(source, "index.ts"), "utf8")).toContain("false");
    } finally {
      process.env.PATH = previous;
    }
  });

  test("applies a fake Codex resolver edit only through the guarded checkout", async () => {
    const source = mkdtempSync(
      join(realpathSync(tmpdir()), "resolver-source-"),
    );
    writeFileSync(join(source, "index.ts"), "export const broken = true;\n");
    const bin = mkdtempSync(join(tmpdir(), "resolver-bin-"));
    const executable = join(bin, "codex");
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nconst fs=require("fs"),p=require("path"),a=process.argv.slice(2);\nprocess.stdin.resume();\nprocess.stdin.on("end",()=>{\n fs.writeFileSync(p.join(process.cwd(),"index.ts"),"export const broken = false;\\n");\n const output=a[a.indexOf("--output-last-message")+1];\n fs.writeFileSync(output,JSON.stringify({dispositions:[{index:0,state:"fixed",reason:"Corrected the value",path:"index.ts"}]}));\n});\n`,
    );
    chmodSync(executable, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
      const result = await agent({
        root: source,
        provider: "codex",
        model: "fake",
        thinking: "low",
        prompt: "Resolve the indexed task.",
        diff: "diff --git a/index.ts b/index.ts",
        resolve: true,
        findings: [{ file: "index.ts", title: "Incorrect value" }],
      });
      expect(result.changed).toEqual(["index.ts"]);
      expect(result.dispositions).toEqual([
        {
          index: 0,
          state: "fixed",
          reason: "Corrected the value",
          path: "index.ts",
        },
      ]);
      expect(readFileSync(join(source, "index.ts"), "utf8")).toContain("false");
    } finally {
      process.env.PATH = previous;
    }
  });

  test("preflights validation before applying external resolver edits", async () => {
    const source = mkdtempSync(
      join(realpathSync(tmpdir()), "resolver-source-"),
    );
    writeFileSync(join(source, "notes.txt"), "before\n");
    const bin = mkdtempSync(join(tmpdir(), "resolver-bin-"));
    const executable = join(bin, "claude");
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nconst fs=require("fs"),p=require("path");\nprocess.stdin.resume();\nprocess.stdin.on("end",()=>{\n fs.writeFileSync(p.join(process.cwd(),"notes.txt"),"after\\n");\n process.stdout.write(JSON.stringify({structured_output:{dispositions:[{index:0,state:"fixed",reason:"Changed it",path:"notes.txt"}]}}));\n});\n`,
    );
    chmodSync(executable, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
      await expect(
        agent({
          root: source,
          provider: "claude",
          model: "fake",
          prompt: "Resolve the indexed task.",
          diff: "diff --git a/notes.txt b/notes.txt",
          resolve: true,
          findings: [{ file: "notes.txt", title: "Update notes" }],
        }),
      ).rejects.toThrow("Focused validation unavailable");
      expect(readFileSync(join(source, "notes.txt"), "utf8")).toBe("before\n");
    } finally {
      process.env.PATH = previous;
    }
  });

  test("builds constrained Claude and Codex invocations without ambient API keys", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "should-not-be-forwarded";
    try {
      const common = {
        model: "example-model",
        thinking: "high" as const,
        workspace: "/tmp/safe-workspace",
        schema: { type: "object" },
        outputFile: "/tmp/output.json",
      };
      const claude = structuredAgentInvocation({ ...common, provider: "claude" });
      expect(claude.args).toContain("--restricted");
      expect(claude.args).toContain("Read,Edit");
      expect(claude.env.OPENAI_API_KEY).toBeUndefined();
      expect(
        structuredAgentInvocation({
          ...common,
          provider: "claude",
          thinking: "xhigh",
        }).env.CLAUDE_CODE_EFFORT_LEVEL,
      ).toBe("max");

      const codex = structuredAgentInvocation({ ...common, provider: "codex" });
      expect(codex.args).toContain("workspace-write");
      expect(codex.args).toContain("--ignore-user-config");
      expect(codex.env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});

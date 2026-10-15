import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("does not publish the obsolete example todos agent skill", () => {
  expect(existsSync(resolve(root, "skills/example-todos/SKILL.md"))).toBe(false);
});

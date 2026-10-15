import { describe, expect, test, vi } from "vitest";
import {
  capabilities,
  REQUIRED_PAIR_REVIEW_CAPABILITIES,
  VERIFIED_LEGACY_PAIR_REVIEW_BUILDS,
  VERIFIED_PAIR_REVIEW_VERSIONS,
} from "../engine/review";
import type { Run } from "../engine/process";

const requiredHelp = "--headless --json --scope --provider";
const contract = (version: string, overrides: Record<string, unknown> = {}) => ({
  service: "pair-review",
  version,
  buildId: "a".repeat(64),
  buildCommit: "1234567",
  dirty: false,
  adapterProtocol: 1,
  databaseSchema: 56,
  databaseSnapshot: 1,
  headlessEnvelope: 1,
  healthIdentity: 1,
  capabilities: [...REQUIRED_PAIR_REVIEW_CAPABILITIES],
  ...overrides,
});

function executable(
  version: string,
  help = requiredHelp,
  adapterContract?: Record<string, unknown>,
) {
  return vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === "--version") return version;
    if (args[0] === "--adapter-contract") {
      if (adapterContract) return JSON.stringify(adapterContract);
      throw new Error("Unknown flag: --adapter-contract");
    }
    if (args[0] === "--help") return help;
    throw new Error(`Unexpected arguments: ${args.join(" ")}`);
  }) as unknown as Run;
}

describe("Pair Review adapter protocol gate", () => {
  test.each(VERIFIED_PAIR_REVIEW_VERSIONS)(
    "keeps the audited legacy fallback for Pair Review v%s",
    async (version) => {
      const exec = executable(`pair-review v${version}`);

      await expect(
        capabilities("pair-review", exec, {
          legacyBuildId: () => VERIFIED_LEGACY_PAIR_REVIEW_BUILDS[version],
        }),
      ).resolves.toBe(`pair-review v${version}`);
      expect(exec).toHaveBeenCalledTimes(3);
    },
  );

  test("rejects a modified legacy build that only reports an audited version", async () => {
    const exec = executable("pair-review v5.3.4");

    await expect(
      capabilities("pair-review", exec, {
        legacyBuildId: () => "f".repeat(64),
      }),
    ).rejects.toThrow("is not the audited legacy build");
  });

  test("accepts a newer version when its machine-readable contract is compatible", async () => {
    const exec = executable(
      "pair-review v5.4.0",
      requiredHelp,
      contract("5.4.0"),
    );

    await expect(capabilities("pair-review", exec)).resolves.toBe(
      "pair-review v5.4.0",
    );
  });

  test.each(["5.3.3", "5.3.5", "6.0.0"])(
    "rejects contractless, unaudited Pair Review v%s",
    async (version) => {
      const exec = executable(`pair-review v${version}`);

      await expect(capabilities("pair-review", exec)).rejects.toThrow(
        `Pair Review ${version} did not provide an adapter protocol`,
      );
      expect(exec).toHaveBeenCalledTimes(2);
    },
  );

  test("rejects a malformed contract even for a legacy-allowlisted version", async () => {
    const exec = executable(
      "pair-review v5.3.4",
      requiredHelp,
      contract("5.3.4", { databaseSchema: 57 }),
    );

    await expect(capabilities("pair-review", exec)).rejects.toThrow(
      "Pair Review database schema 57 is newer than the adapter's verified maximum 56.",
    );
  });

  test("rejects a contract that omits a required capability", async () => {
    const exec = executable(
      "pair-review v5.4.0",
      requiredHelp,
      contract("5.4.0", { capabilities: ["headless-json"] }),
    );

    await expect(capabilities("pair-review", exec)).rejects.toThrow(
      "is missing capabilities",
    );
  });

  test("rejects a contract whose version differs from the executable", async () => {
    const exec = executable(
      "pair-review v5.4.0",
      requiredHelp,
      contract("5.4.1"),
    );

    await expect(capabilities("pair-review", exec)).rejects.toThrow(
      "contract version 5.4.1 does not match executable version 5.4.0",
    );
  });

  test("still verifies the required headless CLI surface", async () => {
    const exec = executable(
      "pair-review v5.3.4",
      "--headless --json --scope",
      contract("5.3.4"),
    );

    await expect(capabilities("pair-review", exec)).rejects.toThrow(
      "Pair Review missing --provider",
    );
  });
});

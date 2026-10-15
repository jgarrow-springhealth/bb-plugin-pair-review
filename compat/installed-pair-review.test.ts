import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  inspectPairReviewCapabilities,
  REQUIRED_PAIR_REVIEW_CAPABILITIES,
} from "../engine/review";

const executable = process.env.PAIR_REVIEW_EXECUTABLE ?? "pair-review";
const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await vi.waitFor(() => expect(child.exitCode).not.toBeNull(), {
      timeout: 10_000,
      interval: 50,
    });
  }
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function isolatedHome(port: number) {
  const home = mkdtempSync(join(tmpdir(), "pair-review-compat-home-"));
  temporaryDirectories.push(home);
  const configDir = join(home, ".pair-review");
  const binDir = join(home, "bin");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      port,
      update_check: false,
      github_token_command: "gh auth token --hostname github.com",
    }),
  );
  const fakeGh = join(binDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nexit 1\n");
  chmodSync(fakeGh, 0o755);
  return { home, binDir };
}

describe("installed Pair Review compatibility", () => {
  test("publishes the protocol required by the BB adapter", async () => {
    const inspected = await inspectPairReviewCapabilities(executable);

    expect(inspected.legacyContract).toBe(false);
    expect(inspected.contract).toMatchObject({
      service: "pair-review",
      version: inspected.version,
      adapterProtocol: 1,
      databaseSnapshot: 1,
      headlessEnvelope: 1,
      healthIdentity: 1,
    });
    expect(inspected.contract?.capabilities).toEqual(
      expect.arrayContaining([...REQUIRED_PAIR_REVIEW_CAPABILITIES]),
    );
  });

  test("serves the same contract and build identity from health", async () => {
    const inspected = await inspectPairReviewCapabilities(executable);
    if (!inspected.contract) throw new Error("Installed contract is unavailable");
    const port = await availablePort();
    const { home, binDir } = isolatedHome(port);
    const child = spawn(executable, [], {
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        PAIR_REVIEW_NO_OPEN: "1",
      },
      stdio: "ignore",
    });
    children.push(child);

    let health: Record<string, unknown> | null = null;
    await vi.waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        expect(response.ok).toBe(true);
        health = (await response.json()) as Record<string, unknown>;
        expect(health.service).toBe("pair-review");
      },
      { timeout: 20_000, interval: 100 },
    );

    expect(health).toMatchObject({
      version: inspected.contract.version,
      buildId: inspected.contract.buildId,
      adapterProtocol: inspected.contract.adapterProtocol,
      databaseSchema: inspected.contract.databaseSchema,
      databaseSnapshot: inspected.contract.databaseSnapshot,
      headlessEnvelope: inspected.contract.headlessEnvelope,
      healthIdentity: inspected.contract.healthIdentity,
    });
    expect(health?.dbId).toMatch(/^[0-9a-f]{64}$/);
  });
});

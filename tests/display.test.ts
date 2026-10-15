import { expect, test } from "vitest";
import { clean, viewerIdentityError } from "../service";
test("saved errors render without ANSI coloring or terminal controls", () => {
  const error =
    "Analysis failed: \u001b[36m[03:50:42]\u001b[0m \u001b[1m\u001b[33m[AI ⚠]\u001b[0m gh auth token\u0007";
  expect(clean(error)).toBe("Analysis failed: [03:50:42] [AI ⚠] gh auth token");
});
test("viewer identity errors name version and database conflicts", () => {
  expect(
    viewerIdentityError(
      7247,
      { version: "5.2.3", dbId: "a".repeat(64) },
      { service: "pair-review", version: "5.2.2", dbId: "b".repeat(64) },
    ),
  ).toBe(
    "Port 7247 is already serving a conflicting Pair Review app: version is 5.2.2, expected 5.2.3; database is bbbbbbbbbbbb, expected aaaaaaaaaaaa",
  );
  expect(
    viewerIdentityError(
      7247,
      { version: "5.2.3", dbId: "a".repeat(64) },
      { service: "pair-review", version: "5.2.3", dbId: "a".repeat(64) },
    ),
  ).toBeNull();
});
test("viewer identity errors expose protocol, schema, and build conflicts", () => {
  expect(
    viewerIdentityError(
      7247,
      {
        version: "5.4.0",
        dbId: "a".repeat(64),
        adapterProtocol: 1,
        databaseSchema: 56,
        databaseSnapshot: 1,
        headlessEnvelope: 1,
        healthIdentity: 1,
        buildId: "b".repeat(64),
      },
      {
        service: "pair-review",
        version: "5.4.0",
        dbId: "a".repeat(64),
        adapterProtocol: 2,
        databaseSchema: 57,
        databaseSnapshot: 2,
        headlessEnvelope: 2,
        healthIdentity: 2,
        buildId: "c".repeat(64),
      },
    ),
  ).toContain(
    "adapter protocol is 2, expected 1; database schema is 57, expected 56",
  );
});

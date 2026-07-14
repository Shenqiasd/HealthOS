import { FeatureFlagsService } from "./feature-flags.service";

type Revision = { active: boolean; version: number } | null;

function service(epoch: bigint | null, revision: Revision): FeatureFlagsService {
  const transaction = {
    $queryRaw: async () => epoch === null ? [] : [{ version: epoch }],
    safetyControlRevision: {
      findFirst: async () => revision,
    },
  };
  const database = {
    $transaction: async <T>(operation: (tx: typeof transaction) => Promise<T>) => operation(transaction),
  };
  return new FeatureFlagsService(database as never);
}

describe("LLM generation feature decision", () => {
  test("fails closed when the audited revision is missing", async () => {
    await expect(service(4n, null).evaluate(
      "feature.llm_generation",
      { type: "global", id: "*" },
    )).resolves.toEqual({
      enabled: false,
      reason: "missing_revision_fail_closed",
      version: 0,
      control_epoch: "4",
    });
  });

  test("fails closed when the audited revision is disabled", async () => {
    await expect(service(5n, { active: false, version: 2 }).evaluate(
      "feature.llm_generation",
      { type: "global", id: "*" },
    )).resolves.toEqual({
      enabled: false,
      reason: "disabled_revision",
      version: 2,
      control_epoch: "5",
    });
  });

  test("fails closed when the safety-control epoch is missing", async () => {
    await expect(service(null, { active: true, version: 1 }).evaluate(
      "feature.llm_generation",
      { type: "global", id: "*" },
    )).resolves.toEqual({
      enabled: false,
      reason: "control_epoch_missing_fail_closed",
      version: 1,
      control_epoch: "missing",
    });
  });
});

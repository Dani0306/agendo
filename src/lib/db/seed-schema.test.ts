import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TenantSeedSchema } from "./seed-schema";

const seedFile = () =>
  JSON.parse(readFileSync(new URL("../../../scripts/seed/tenant-fisio-demo.json", import.meta.url), "utf8"));

describe("TenantSeedSchema", () => {
  it("accepts the synthetic tenant", () => {
    const seed = TenantSeedSchema.parse(seedFile());
    expect(seed.tenant.timezone).toBe("America/Bogota");
    expect(seed.services).toHaveLength(4);
  });

  it("rejects a time zone that does not exist", () => {
    const seed = seedFile();
    seed.tenant.timezone = "Medellin/Centro";
    expect(TenantSeedSchema.safeParse(seed).success).toBe(false);
  });

  it("rejects hours that close before they open", () => {
    const seed = seedFile();
    seed.availability_rules.weekly[0].closes = "06:00";
    expect(TenantSeedSchema.safeParse(seed).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import * as guidedDeploy from "./index";
import * as core from "../../index";

/**
 * DBT-303: the CrowdStrike FDR breaker literal had one consumer, the deleted
 * POST /lib/breakers request builder. The pack path builds its own CrowdStrike
 * tuning (domain/pack-assembly/breakers.ts), so the literal was dead and was
 * removed with it. Re-exporting it would invite wiring the undeclared write
 * back in.
 */
const REMOVED = [
  "buildCrowdStrikeFdrBreaker",
  "isCrowdStrikeVendor",
  "CROWDSTRIKE_FDR_BREAKER_ID",
  "buildFdrBreakerRequest",
  "BREAKERS_API_PATH",
] as const;

describe("guided-deploy barrel (DBT-303)", () => {
  it("exports none of the removed FDR breaker names", () => {
    const leaked = REMOVED.filter((n) => n in guidedDeploy || n in core);
    expect(leaked).toEqual([]);
  });
});

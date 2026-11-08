import { describe, expect, it } from "vitest";
import { summarizeStoredTotals } from "./views";

describe("stored dashboard totals", () => {
  it("combines recorded provider and session costs once per delivered audit", () => {
    expect(
      summarizeStoredTotals({
        candidates: 4,
        scanned: 3,
        paidOrders: 2,
        deliveredAudits: 2,
        revenueUsd: 998,
        eventCostUsd: 6.25,
        naiveCostUsd: 1.75,
      }),
    ).toEqual({
      candidates: 4,
      scanned: 3,
      paidOrders: 2,
      deliveredAudits: 2,
      revenueUsd: 998,
      costsUsd: 8,
      costPerDeliveredAuditUsd: 4,
    });
  });

  it("shows no cost per audit before delivery", () => {
    expect(
      summarizeStoredTotals({
        candidates: 1,
        scanned: 0,
        paidOrders: 0,
        deliveredAudits: 0,
        revenueUsd: 0,
        eventCostUsd: 0.5,
        naiveCostUsd: 0,
      }).costPerDeliveredAuditUsd,
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { growthRescanDue } from "./growth";

describe("monthly Growth rescan", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  const delivered = { product: "growth", state: "delivered", deliveredAt: new Date("2026-09-01T12:00:00Z") };
  it("is due 30 days after delivery or the last scan", () => {
    expect(growthRescanDue(delivered, null, now)).toBe(true);
    expect(growthRescanDue(delivered, new Date("2026-10-08T12:00:00Z"), now)).toBe(true);
    expect(growthRescanDue(delivered, new Date("2026-10-09T12:00:00Z"), now)).toBe(false);
  });
  it("never schedules other products or unfinished orders", () => {
    expect(growthRescanDue({ ...delivered, product: "auditKit" }, null, now)).toBe(false);
    expect(growthRescanDue({ ...delivered, state: "auditing" }, null, now)).toBe(false);
  });
});

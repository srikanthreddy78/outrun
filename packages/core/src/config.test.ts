import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

describe("config", () => {
  it("uses the documented defaults", () => {
    const c = loadConfig({});
    expect(c.settings).toEqual({
      llmBudgetUsdDaily: null,
      sendDailyCap: 30,
      discoveryDailyCap: 200,
      smartModel: "gpt-5.5",
      jobMaxAttempts: 5,
      demo: false,
    });
  });

  it("an unset or blank budget means unlimited", () => {
    expect(loadConfig({ OUTRUN_LLM_BUDGET_USD_DAILY: "" }).settings.llmBudgetUsdDaily).toBeNull();
    expect(loadConfig({ OUTRUN_LLM_BUDGET_USD_DAILY: "12.5" }).settings.llmBudgetUsdDaily).toBe(12.5);
  });

  it.each([
    ["OUTRUN_SEND_DAILY_CAP", "lots"],
    ["OUTRUN_SEND_DAILY_CAP", "0"],
    ["OUTRUN_DISCOVERY_DAILY_CAP", "-3"],
    ["OUTRUN_JOB_MAX_ATTEMPTS", "100"],
    ["OUTRUN_LLM_BUDGET_USD_DAILY", "-1"],
    ["OUTRUN_DEMO", "yes"],
    ["APP_URL", "not a url"],
  ])("fails boot on a bad %s", (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(ConfigError);
  });

  it("treats blank keys as missing", () => {
    expect(loadConfig({ OPENAI_API_KEY: "  " }).keys.openai).toBeUndefined();
  });

  it("trims a trailing slash from APP_URL", () => {
    expect(loadConfig({ APP_URL: "https://outrun.example/" }).appUrl).toBe("https://outrun.example");
  });
});

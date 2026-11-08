import { describe, expect, it } from "vitest";
import { crewMcpPath, naiveAgentName, parseNaiveAgentName } from "./identity";
import { crewToken, crewTokenEnv, crewTokenEnvAll } from "./tokens";

describe("crew identity: a client's role", () => {
  it("keeps Outrun's names, URLs and tokens as they were before clients", () => {
    expect(naiveAgentName("sdr")).toBe("sdr");
    expect(crewMcpPath("sdr")).toBe("sdr");
    expect(crewTokenEnv("sdr")).toBe("CREW_TOKEN_SDR");
    expect(crewToken("s", "sdr", "outrun")).toBe(crewToken("s", "sdr"));
  });

  it("prefixes another client's crew with its slug, in names, paths and env", () => {
    expect(naiveAgentName("closer", "acme-labs")).toBe("acme-labs-closer");
    expect(crewMcpPath("closer", "acme-labs")).toBe("acme-labs/closer");
    expect(crewTokenEnv("closer", "acme-labs")).toBe("CREW_TOKEN_ACME_LABS_CLOSER");
  });

  it("parses names back, and refuses ones that aren't a crew member", () => {
    expect(parseNaiveAgentName("sdr")).toEqual({ agent: "sdr", clientSlug: "outrun" });
    expect(parseNaiveAgentName("acme-labs-closer")).toEqual({ agent: "closer", clientSlug: "acme-labs" });
    expect(parseNaiveAgentName("outrun-sdr")).toBeNull();
    expect(parseNaiveAgentName("helper-bot")).toBeNull();
    expect(parseNaiveAgentName("-sdr")).toBeNull();
  });

  it("gives every crew member its own token", () => {
    // Outrun's six and the CEO, then six for each other client: no client has a CEO.
    const all = crewTokenEnvAll("s", ["outrun", "acme", "beta"]);
    expect(Object.keys(all)).toHaveLength(19);
    expect(new Set(Object.values(all)).size).toBe(19);
    expect(all.CREW_TOKEN_CEO).toBeDefined();
    expect(all.CREW_TOKEN_ACME_CEO).toBeUndefined();
    expect(parseNaiveAgentName("acme-ceo")).toBeNull();
  });

  it("names optional roles with dashes on Naive, and gives tokens only to the roles staffed", () => {
    expect(naiveAgentName("account_manager", "acme")).toBe("acme-account-manager");
    expect(crewMcpPath("account_manager", "acme")).toBe("acme/account_manager");
    expect(crewTokenEnv("signal_scout", "acme")).toBe("CREW_TOKEN_ACME_SIGNAL_SCOUT");
    expect(parseNaiveAgentName("acme-account-manager")).toEqual({
      agent: "account_manager",
      clientSlug: "acme",
    });
    expect(parseNaiveAgentName("big-co-signal-scout")).toEqual({
      agent: "signal_scout",
      clientSlug: "big-co",
    });
    // Outrun's crew never has the optional roles.
    expect(parseNaiveAgentName("account_manager")).toBeNull();
    const all = crewTokenEnvAll("s", ["outrun", "beta", { slug: "acme", roles: ["experimenter"] }]);
    expect(Object.keys(all)).toHaveLength(7 + 6 + 7);
    expect(all.CREW_TOKEN_ACME_EXPERIMENTER).toBe(crewToken("s", "experimenter", "acme"));
    expect(all.CREW_TOKEN_BETA_EXPERIMENTER).toBeUndefined();
    expect(all.CREW_TOKEN_EXPERIMENTER).toBeUndefined();
  });
});

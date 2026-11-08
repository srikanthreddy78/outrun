import type { Integrations } from "../integrations/types";
import { FakeLlmProvider } from "./llm";
import { FakeNaiveClient } from "./naive";
import {
  FakeAgentMail,
  FakeApify,
  FakeHubSpot,
  FakeMonid,
  FakeStripe,
  createFakeDiscover,
  createFakeEnrich,
  createFakeScan,
} from "./others";

export * from "./llm";
export * from "./naive";
export * from "./others";

export interface FakeIntegrations extends Integrations {
  llm: { openai: FakeLlmProvider; openrouter: FakeLlmProvider };
  naive: FakeNaiveClient;
  stripe: FakeStripe;
  apify: FakeApify;
  agentmail: FakeAgentMail;
  hubspot: FakeHubSpot;
  monid: FakeMonid;
}

/** Every integration as a fake. Override any of them per test. */
export function createFakes(overrides: Partial<FakeIntegrations> = {}): FakeIntegrations {
  const agentmail = overrides.agentmail ?? new FakeAgentMail();
  return {
    llm: { openai: new FakeLlmProvider("openai"), openrouter: new FakeLlmProvider("openrouter") },
    naive: new FakeNaiveClient(),
    stripe: new FakeStripe(),
    scanDomain: createFakeScan(),
    apify: new FakeApify(),
    discover: createFakeDiscover(),
    enrich: createFakeEnrich(),
    agentmail,
    sendTransactional: agentmail.sendTransactional,
    hubspot: new FakeHubSpot(),
    monid: new FakeMonid(),
    ...overrides,
  };
}

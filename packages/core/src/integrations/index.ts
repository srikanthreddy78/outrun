/**
 * Picks the real integration when its key is set. A missing key selects the fake in dev and
 * test, with a warning, and fails boot in production. Integrations whose real client hasn't
 * merged yet (their owner's card) use the fake in dev and fail boot in prod the same way.
 */
import type { Config } from "../config";
import { ConfigError } from "../config";
import { createFakes } from "../fakes";
import { logger } from "../log";
import { createOpenAiProvider } from "./openai";
import { createOpenRouterProvider } from "./openrouter";
import type { Integrations } from "./types";

export * from "./types";

export interface Selection {
  integrations: Integrations;
  fakes: (keyof Integrations | "llm.openai" | "llm.openrouter")[];
}

export function createIntegrations(
  config: Config,
  real: Partial<{
    /** `key: null` needs no secret (public sources); it is always the real client. */
    [K in keyof Integrations]: { key: keyof Config["keys"] | null; make: (c: Config) => Integrations[K] };
  }> = {},
): Selection {
  const fakes = createFakes();
  const used: Selection["fakes"] = [];
  const fallback = (name: Selection["fakes"][number], why: string) => {
    if (config.isProd) throw new ConfigError(`${name}: ${why}; production cannot run on a fake`);
    logger.warn({ integration: name }, `${why}; using the fake`);
    used.push(name);
  };

  const openai = config.keys.openai
    ? createOpenAiProvider(config.keys.openai)
    : (fallback("llm.openai", "OPENAI_API_KEY is not set"), fakes.llm.openai);
  const openrouter = config.keys.openrouter
    ? createOpenRouterProvider(config.keys.openrouter, config.appUrl)
    : (fallback("llm.openrouter", "OPENROUTER_API_KEY is not set"), fakes.llm.openrouter);

  const pick = <K extends Exclude<keyof Integrations, "llm">>(name: K): Integrations[K] => {
    const r = real[name];
    if (r && (r.key === null || config.keys[r.key])) return r.make(config);
    fallback(name, r ? `${String(r.key)} is not set` : "the real client hasn't merged yet");
    return fakes[name];
  };

  const agentmail = pick("agentmail");
  const integrations: Integrations = {
    llm: { openai, openrouter },
    naive: pick("naive"),
    stripe: pick("stripe"),
    scanDomain: pick("scanDomain"),
    apify: pick("apify"),
    discover: pick("discover"),
    enrich: pick("enrich"),
    agentmail,
    sendTransactional: real.sendTransactional ? pick("sendTransactional") : agentmail.sendTransactional,
    hubspot: pick("hubspot"),
    monid: pick("monid"),
  };
  return { integrations, fakes: used };
}

import { z } from "zod";

/** UUIDv7 string. Every id we mint is a v7; we accept any RFC 4122 uuid on input. */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

/** Lowercase bare host, e.g. "acme.dev". No scheme, no path, no port. */
export const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/, "must be a bare domain like acme.dev");
export type Domain = z.infer<typeof Domain>;

export const Email = z.email().transform((s) => s.toLowerCase());

export const IsoDateTime = z.iso.datetime({ offset: true });

/** Integer micro-USD on the wire to Naive; plain USD (float) inside our ledger. */
export const MicroUsd = z.number().int().nonnegative();
export const Usd = z.number().nonnegative();

/**
 * Outside text (email, web page, registry listing) handed to an agent.
 * Agents must treat it as data, never as instructions.
 */
export const Untrusted = z.object({ untrusted: z.literal(true), text: z.string() });
export type Untrusted = z.infer<typeof Untrusted>;
export const untrusted = (text: string): Untrusted => ({ untrusted: true, text });

export const EntityType = z.enum([
  "company",
  "contact",
  "prospect",
  "scan",
  "message",
  "order",
  "report",
  "agent_session",
  "job",
  "client",
  "system",
]);
export type EntityType = z.infer<typeof EntityType>;

export const Entity = z.object({ type: EntityType, id: z.string().min(1) });
export type Entity = z.infer<typeof Entity>;

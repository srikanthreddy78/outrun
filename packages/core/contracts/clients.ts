/**
 * A client of the agency, and the profile its crew works from. The client's researcher drafts
 * the profile from the client's own site (save_client_profile); the owner reviews, edits and
 * confirms it on /dashboard/clients. Nothing goes out for a client before that.
 */
import { z } from "zod";
import { Domain } from "./common";

export const CLIENT_STATUSES = [
  "draft",
  "profiling",
  "awaiting_confirmation",
  "email_setup",
  "active",
  "paused",
] as const;
export const ClientStatus = z.enum(CLIENT_STATUSES);
export type ClientStatus = z.infer<typeof ClientStatus>;

/** Lowercase letters, digits and single hyphens: it appears in agent names and URLs. */
export const ClientSlug = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase letters, digits and single hyphens")
  .refine((s) => s !== "outrun", "outrun is the agency itself");

const Text = (max: number) => z.string().trim().min(1).max(max);
const Https = z.url({ protocol: /^https$/ });

/** Company sizes, as Hunter's company search takes them. */
export const COMPANY_SIZES = [
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5001-10000",
  "10001+",
] as const;

/** A price the crew may quote, exactly as written (e.g. "$49/month"). */
export const ProfilePrice = z.object({ label: Text(80), amount: Text(40) });

export const ClientProfile = z.object({
  /** One sentence: what the client sells and to whom. */
  summary: Text(400),
  icp: z.object({
    /** Who to look for, in plain words. */
    description: Text(600),
    /** Words a fitting company's name, summary or site would contain. */
    includeKeywords: z.array(Text(40)).min(1).max(20),
    /** Words that rule a company out (consumer, agency, a competitor's name, ...). */
    excludeKeywords: z.array(Text(40)).max(20).default([]),
    /** Job titles worth emailing. */
    buyerRoles: z.array(Text(60)).min(1).max(10),
    /** Company sizes to search for; empty means any size. */
    companySizes: z.array(z.enum(COMPANY_SIZES)).max(8).default([]),
  }),
  offer: z.object({
    /** What the email offers (a demo, a free trial, an audit), in one sentence. */
    pitch: Text(400),
    /** The one link every email ends on: a meeting page, a trial signup, a pricing page. */
    callToActionUrl: Https,
    /** The only prices the crew may quote; empty means no prices in emails. */
    prices: z.array(ProfilePrice).max(10).default([]),
  }),
  /** Other hosts the crew may link to (docs, a case study), on top of the client's own domain. */
  allowedLinkHosts: z.array(Domain).max(10).default([]),
  sender: z.object({
    /** The person emails are signed as. */
    name: Text(80),
    title: Text(80).optional(),
    /** The postal address commercial email must carry (CAN-SPAM). */
    postalAddress: Text(300),
  }),
  tone: Text(200).default("plain, specific, friendly; no hype"),
  /** The pages the profile was drafted from, so the owner can check them. */
  sources: z.array(Https).min(1).max(20),
});
export type ClientProfile = z.infer<typeof ClientProfile>;

/** What the owner enters to add a client: a name and a domain. Everything else is drafted. */
export const NewClient = z.object({
  name: Text(80),
  domain: Domain,
  slug: ClientSlug.optional(),
  approverEmails: z
    .array(z.email().transform((s) => s.toLowerCase()))
    .max(10)
    .default([]),
});
export type NewClient = z.infer<typeof NewClient>;

/** A slug from a client's name: "Acme Labs, Inc." → "acme-labs-inc". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/**
 * What the CEO may propose changing in a confirmed profile: who to look for, nothing else.
 * Strict, so prices, the offer, the call to action, the sender and link hosts can't ride along.
 */
export const ProfileChanges = z
  .strictObject({
    addIncludeKeywords: z.array(Text(40)).min(1).max(10).optional(),
    dropIncludeKeywords: z.array(Text(40)).min(1).max(10).optional(),
    addExcludeKeywords: z.array(Text(40)).min(1).max(10).optional(),
    /** Replaces the buyer roles. */
    buyerRoles: z.array(Text(60)).min(1).max(10).optional(),
    /** Replaces the company sizes; empty means any size. */
    companySizes: z.array(z.enum(COMPANY_SIZES)).max(8).optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined), "propose at least one change");
export type ProfileChanges = z.infer<typeof ProfileChanges>;

/**
 * Postgres is the source of truth; HubSpot only mirrors it.
 * Ids are UUIDv7 minted in code. Money in our ledger is numeric USD.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import {
  AGENTS,
  COMPANY_KINDS,
  MESSAGE_STATUSES,
  ORDER_STATES,
  MESSAGE_DIRECTIONS,
  MESSAGE_KINDS,
  PRODUCT_KEYS,
  PROSPECT_STAGES,
  SESSION_STATUSES,
  SOURCES,
  STOP_REASONS,
} from "../../contracts";
import { OUTRUN_CLIENT_ID } from "../constants";

const id = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const companyKind = pgEnum("company_kind", COMPANY_KINDS);
export const source = pgEnum("source", SOURCES);
export const prospectStage = pgEnum("prospect_stage", PROSPECT_STAGES);
export const messageStatus = pgEnum("message_status", MESSAGE_STATUSES);
export const messageDirection = pgEnum("message_direction", MESSAGE_DIRECTIONS);
export const messageKind = pgEnum("message_kind", MESSAGE_KINDS);
export const orderState = pgEnum("order_state", ORDER_STATES);
export const agentName = pgEnum("agent_name", AGENTS);
export const sessionStatus = pgEnum("session_status", SESSION_STATUSES);
export const stopReason = pgEnum("stop_reason", STOP_REASONS);
export const product = pgEnum("product", PRODUCT_KEYS);
export const clientStatus = pgEnum("client_status", [
  "draft",
  "profiling",
  "awaiting_confirmation",
  "email_setup",
  "active",
  "paused",
]);

/** A company the agency markets. Each one gets its own crew of six agents on Naive. */
export const clients = pgTable(
  "clients",
  {
    id: id(),
    /** Lowercase a-z0-9-, used in agent names (`<slug>-<role>`) and crew MCP URLs. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    domain: text("domain").notNull(),
    status: clientStatus("status").notNull().default("draft"),
    /** Target customer, offer, prices, links, sender and postal address; drafted by its researcher. */
    profile: jsonb("profile").$type<Record<string, unknown>>().notNull().default({}),
    profileConfirmedAt: timestamp("profile_confirmed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by"),
    agentmailInboxId: text("agentmail_inbox_id"),
    agentmailDomainId: text("agentmail_domain_id"),
    /** The DNS records AgentMail asks for, as last read, for the client to add. */
    dnsRecords: jsonb("dns_records")
      .$type<{ type: string; name: string; value: string; status: string; priority?: number }[]>()
      .notNull()
      .default([]),
    sendingDomain: text("sending_domain"),
    dnsStatus: text("dns_status", { enum: ["none", "pending", "verified", "failed"] })
      .notNull()
      .default("none"),
    dailySendCap: integer("daily_send_cap").notNull().default(30),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("clients_slug_uq").on(t.slug), uniqueIndex("clients_domain_uq").on(t.domain)],
);

/** People at a client who sign in to the portal and approve its emails. */
export const clientUsers = pgTable(
  "client_users",
  {
    id: id(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    email: text("email").notNull(),
    role: text("role", { enum: ["approver"] })
      .notNull()
      .default("approver"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("client_users_client_email_uq").on(t.clientId, t.email)],
);

/** The client a row belongs to; rows from before clients existed are Outrun's. */
const clientId = () =>
  uuid("client_id")
    .notNull()
    .default(OUTRUN_CLIENT_ID)
    .references(() => clients.id);

export const companies = pgTable(
  "companies",
  {
    id: id(),
    domain: text("domain").notNull(),
    name: text("name").notNull().default(""),
    source: source("source").notNull(),
    sourceRef: text("source_ref"),
    kind: companyKind("kind").notNull().default("candidate"),
    summary: text("summary").notNull().default(""),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("companies_domain_uq").on(t.domain), index("companies_kind_idx").on(t.kind)],
);

export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    name: text("name").notNull(),
    role: text("role").notNull().default(""),
    email: text("email").notNull(),
    sourceUrl: text("source_url").notNull(),
    /** Lawful basis for B2B outreach: a public business address for this role. */
    consent: text("consent").notNull().default("legitimate_interest_business"),
    suppressed: boolean("suppressed").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("contacts_email_uq").on(t.email), index("contacts_company_idx").on(t.companyId)],
);

export const prospects = pgTable(
  "prospects",
  {
    id: id(),
    clientId: clientId(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    stage: prospectStage("stage").notNull().default("filed"),
    facts: jsonb("facts").$type<{ key: string; value: string; sourceUrl: string }[]>().notNull().default([]),
    fitScore: real("fit_score"),
    gapScore: real("gap_score"),
    filedReason: text("filed_reason").notNull().default(""),
    /** Set only by seedDemo. Demo mode emails only these prospects' contacts. */
    isDemo: boolean("is_demo").notNull().default(false),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
    followupStep: integer("followup_step").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("prospects_client_company_uq").on(t.clientId, t.companyId),
    index("prospects_client_idx").on(t.clientId),
    index("prospects_stage_idx").on(t.stage),
  ],
);

export const scans = pgTable(
  "scans",
  {
    id: id(),
    domain: text("domain").notNull(),
    version: integer("version").notNull(),
    scannerVersion: text("scanner_version").notNull(),
    score: real("score").notNull(),
    checks: jsonb("checks").$type<unknown[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("scans_domain_version_uq").on(t.domain, t.version)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    clientId: clientId(),
    prospectId: uuid("prospect_id").references(() => prospects.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    threadId: text("thread_id"),
    direction: messageDirection("direction").notNull(),
    kind: messageKind("kind").notNull(),
    status: messageStatus("status").notNull(),
    toEmail: text("to_email"),
    fromEmail: text("from_email"),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    citedCheckIds: jsonb("cited_check_ids").$type<string[]>().notNull().default([]),
    draftHash: text("draft_hash"),
    providerId: text("provider_id"),
    naiveSessionId: text("naive_session_id"),
    naiveToolCallId: text("naive_tool_call_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("messages_provider_uq")
      .on(t.providerId)
      .where(sql`${t.providerId} is not null`),
    index("messages_thread_idx").on(t.threadId),
    index("messages_status_idx").on(t.status),
    index("messages_client_idx").on(t.clientId),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: id(),
    prospectId: uuid("prospect_id").references(() => prospects.id),
    domain: text("domain").notNull(),
    contactEmail: text("contact_email").notNull(),
    product: product("product").notNull(),
    state: orderState("state").notNull().default("pending"),
    amountUsd: numeric("amount_usd", { precision: 10, scale: 2 }).notNull(),
    idempotencyKey: text("idempotency_key"),
    stripeCheckoutId: text("stripe_checkout_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("orders_idem_uq")
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    uniqueIndex("orders_checkout_uq")
      .on(t.stripeCheckoutId)
      .where(sql`${t.stripeCheckoutId} is not null`),
    index("orders_state_idx").on(t.state),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: id(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    accessToken: text("access_token").notNull(),
    audit: jsonb("audit").$type<Record<string, unknown>>().notNull(),
    kit: jsonb("kit").$type<Record<string, unknown>>().notNull().default({}),
    sections: jsonb("sections").$type<unknown[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("reports_token_uq").on(t.accessToken), uniqueIndex("reports_order_uq").on(t.orderId)],
);

/** One public Apify crawl per paid order. A claimed row prevents duplicate run starts. */
export const auditCrawls = pgTable(
  "audit_crawls",
  {
    orderId: uuid("order_id")
      .primaryKey()
      .references(() => orders.id),
    runId: text("run_id").unique(),
    datasetId: text("dataset_id"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    status: text("status").notNull().default("starting"),
    startedAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("audit_crawls_status_idx").on(t.status)],
);

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: id(),
    sessionId: text("session_id"),
    clientId: clientId(),
    agent: agentName("agent").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: sessionStatus("status").notNull().default("starting"),
    stopReason: stopReason("stop_reason"),
    spendUsd: numeric("spend_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    /** Highest Naive session event seq already applied (approvals are read from events). */
    lastSeq: integer("last_seq").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("agent_sessions_session_uq")
      .on(t.sessionId)
      .where(sql`${t.sessionId} is not null`),
    uniqueIndex("agent_sessions_idem_uq").on(t.idempotencyKey),
    /** One live session per client, agent and entity. */
    uniqueIndex("agent_sessions_live_uq")
      .on(t.clientId, t.agent, t.entityType, t.entityId)
      .where(sql`${t.status} in ('starting','running','idle')`),
  ],
);

export const events = pgTable(
  "events",
  {
    id: id(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor").notNull(),
    type: text("type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
  },
  (t) => [
    index("events_ts_idx").on(t.ts),
    index("events_entity_idx").on(t.entityType, t.entityId),
    index("events_type_ts_idx").on(t.type, t.ts),
    /** Webhook dedupe: one `webhook.received` per provider delivery id (`<provider>:<id>`). */
    uniqueIndex("events_webhook_uq")
      .on(t.entityId)
      .where(sql`${t.type} = 'webhook.received'`),
  ],
);

export const suppressions = pgTable(
  "suppressions",
  {
    id: id(),
    /** A lowercase email address or a bare domain. */
    value: text("value").notNull(),
    kind: text("kind", { enum: ["email", "domain"] }).notNull(),
    reason: text("reason").notNull(),
    /** Set for an unsubscribe from one client's email; null applies to every client. */
    clientId: uuid("client_id").references(() => clients.id),
    createdAt: createdAt(),
  },
  // One row per address and client; a null client (everyone) counts once too.
  (t) => [unique("suppressions_value_client_uq").on(t.value, t.clientId).nullsNotDistinct()],
);

/** Application tables, for tests and tooling. */
export const TABLES = [
  "clients",
  "client_users",
  "companies",
  "contacts",
  "prospects",
  "scans",
  "messages",
  "orders",
  "reports",
  "audit_crawls",
  "agent_sessions",
  "events",
  "suppressions",
] as const;

/**
 * Loads every prospect into Naive's built-in CRM, with enrichment and a fit score.
 *
 *   pnpm --filter @outrun/user-acquisition crm:sync             enrich new prospects, score, sync
 *   pnpm --filter @outrun/user-acquisition crm:sync --dry-run   no paid calls, no writes; report only
 *   ... --refresh   re-enrich prospects already enriched (paid again)
 *   ... --limit N   only the first N prospects
 *
 * Enrichment is stored on the prospect row and reused, so a rerun pays nothing for companies
 * already enriched. One CRM contact per prospect, found by its stored id or by email, so a
 * rerun creates nothing new. A contact a person has moved past `lead` keeps its stage; only a
 * suppressed address is moved to `lost`.
 */
import { enrich, type Enrichment } from "./enrich.ts";
import { fitSummary, scoreFit, type FitScore } from "./fit.ts";
import {
  addNote,
  clientFromEnv,
  createContact,
  dbQuery,
  findContactByEmail,
  getContact,
  NaiveApiError,
  sqlLiteral,
  updateContact,
  type CrmContactInput,
  type NaiveClient,
} from "./naive-api.ts";

const APP_NAME = "outreach";

/** Mirrors `server/db.ts`, so the sync works before the app's next deploy adds the columns. */
const COLUMNS = `
alter table outrun_prospects add column if not exists enrichment jsonb;
alter table outrun_prospects add column if not exists fit_score integer;
alter table outrun_prospects add column if not exists fit_band text;
alter table outrun_prospects add column if not exists fit_parts jsonb;
alter table outrun_prospects add column if not exists crm_contact_id text;
alter table outrun_prospects add column if not exists crm_fit_score integer;
alter table outrun_prospects add column if not exists crm_synced_at timestamptz;
`;

interface ProspectRow {
  domain: string;
  company: string;
  found_via: string;
  listing_url: string | null;
  why_fit: string;
  contact_email: string;
  contact_name: string | null;
  contact_role: string | null;
  email_source_url: string;
  enrichment: Enrichment | null;
  crm_contact_id: string | null;
  crm_fit_score: number | null;
  suppressed: string | null;
}

interface Options {
  dryRun: boolean;
  refresh: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): Options {
  const limitAt = argv.indexOf("--limit");
  const limit = limitAt === -1 ? null : Number(argv[limitAt + 1]);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1))
    throw new Error("--limit takes a positive integer");
  return { dryRun: argv.includes("--dry-run"), refresh: argv.includes("--refresh"), limit };
}

async function appId(client: NaiveClient): Promise<string> {
  const response = await fetch(`${client.baseUrl}/v1/apps?name=${APP_NAME}`, {
    headers: { authorization: `Bearer ${client.apiKey}`, "vetta-version": "2026-09-30" },
  });
  const page = (await response.json()) as { data?: { id: string; name: string }[] };
  const app = page.data?.find((row) => row.name === APP_NAME);
  if (app === undefined) throw new Error(`no Naive app named ${APP_NAME}; apply user_acquisition first`);
  return app.id;
}

/** Runs `work` over `items`, `limit` at a time. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  });
  await Promise.all(lanes);
  return results;
}

function contactFor(row: ProspectRow, fit: FitScore): CrmContactInput {
  return {
    name: row.contact_name ?? `${row.company} team`,
    company: row.company,
    email: row.contact_email,
    source: `prospector:${row.found_via}`,
    next_step:
      row.suppressed === null
        ? `Fit ${fit.score} (${fit.band}): send the first outreach email`
        : `Do not email: ${row.suppressed}`,
  };
}

function noteFor(row: ProspectRow, fit: FitScore, enrichment: Enrichment, first: boolean): string {
  const socials = Object.entries(enrichment.socials)
    .map(([platform, url]) => `${platform}: ${url}`)
    .join("\n");
  const profile = enrichment.profile;
  const lines = [
    first
      ? `Fit score ${fit.score}/100 (${fit.band})`
      : `Fit score updated to ${fit.score}/100 (${fit.band})`,
    "",
    fitSummary(fit),
    "",
    `Why they fit: ${row.why_fit}`,
    `Found via ${row.found_via}${row.listing_url === null ? "" : `: ${row.listing_url}`}`,
    `Email published at: ${row.email_source_url}`,
  ];
  if (enrichment.homepage.title !== null) lines.push(`Homepage: ${enrichment.homepage.title}`);
  if (profile.found) {
    lines.push(
      `Profile: HQ ${profile.hqCountry ?? "unknown"}, founded ${profile.foundedYear ?? "unknown"}, ` +
        `${profile.fundingStage ?? "funding unknown"}, revenue ${profile.revenueEstimate ?? "unknown"}`,
    );
  }
  if (socials !== "") lines.push("", "Social profiles:", socials);
  return lines.join("\n").slice(0, 4000);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const client = clientFromEnv(process.env);
  const app = await appId(client);
  const now = new Date();

  if (!options.dryRun) await dbQuery(client, app, COLUMNS);
  const select = `
    select p.domain, p.company, p.found_via, p.listing_url, p.why_fit, p.contact_email, p.contact_name,
           p.contact_role, p.email_source_url,
           ${options.dryRun ? "null::jsonb as enrichment, null as crm_contact_id, null::int as crm_fit_score," : "p.enrichment, p.crm_contact_id, p.crm_fit_score,"}
           s.reason as suppressed
      from outrun_prospects p
      left join outrun_suppressions s on s.email = p.contact_email
     order by p.verified_at
     ${options.limit === null ? "" : `limit ${options.limit}`}`;
  const rows = await dbQuery<ProspectRow>(client, app, select);

  const needEnrichment = rows.filter((row) => options.refresh || row.enrichment === null);
  console.log(
    `${rows.length} prospects; ${needEnrichment.length} to enrich${options.dryRun ? " (dry run: skipped)" : ""}`,
  );

  let spentMicroUsd = 0;
  if (!options.dryRun) {
    await pool(needEnrichment, 5, async (row) => {
      const enrichment = await enrich(client, row.domain, now);
      spentMicroUsd += enrichment.costMicroUsd;
      row.enrichment = enrichment;
      await dbQuery(
        client,
        app,
        `update outrun_prospects set enrichment = ${sqlLiteral(enrichment)}::jsonb where domain = ${sqlLiteral(row.domain)}`,
      );
    });
  }

  let created = 0;
  let updated = 0;
  let notes = 0;
  const report: { company: string; email: string; score: number; band: string; stage: string }[] = [];

  for (const row of rows) {
    const enrichment = row.enrichment ?? emptyEnrichment(now);
    const fit = scoreFit(
      {
        company: row.company,
        domain: row.domain,
        whyFit: row.why_fit,
        contactEmail: row.contact_email,
        contactName: row.contact_name,
        contactRole: row.contact_role,
        enrichment,
      },
      now,
    );
    if (options.dryRun) {
      report.push({
        company: row.company,
        email: row.contact_email,
        score: fit.score,
        band: fit.band,
        stage: "-",
      });
      continue;
    }

    const input = contactFor(row, fit);
    let contactId = row.crm_contact_id;
    if (contactId !== null) {
      contactId = await getContact(client, contactId).then(
        (contact) => contact.id,
        (error: unknown) =>
          error instanceof NaiveApiError && error.status === 404 ? null : Promise.reject(error),
      );
    }
    contactId ??= (await findContactByEmail(client, row.contact_email))?.id ?? null;

    let stage: string;
    let first = false;
    if (contactId === null) {
      const contact = await createContact(
        client,
        { ...input, stage: row.suppressed === null ? "lead" : "lost" },
        `outrun-crm-contact-${row.domain}`,
      );
      contactId = contact.id;
      stage = contact.stage;
      created += 1;
      first = true;
    } else {
      const contact = await updateContact(client, contactId, {
        ...input,
        ...(row.suppressed === null ? {} : { stage: "lost" as const }),
      });
      stage = contact.stage;
      updated += 1;
    }

    if (first || row.crm_fit_score !== fit.score) {
      await addNote(
        client,
        contactId,
        noteFor(row, fit, enrichment, first),
        `outrun-crm-note-${row.domain}-${fit.score}`,
      );
      notes += 1;
    }

    await dbQuery(
      client,
      app,
      `update outrun_prospects
          set fit_score = ${fit.score}, fit_band = ${sqlLiteral(fit.band)}, fit_parts = ${sqlLiteral(fit.parts)}::jsonb,
              crm_contact_id = ${sqlLiteral(contactId)}, crm_fit_score = ${fit.score}, crm_synced_at = now()
        where domain = ${sqlLiteral(row.domain)}`,
    );
    report.push({ company: row.company, email: row.contact_email, score: fit.score, band: fit.band, stage });
  }

  report.sort((a, b) => b.score - a.score);
  for (const line of report) {
    console.log(
      `${String(line.score).padStart(3)}  ${line.band.padEnd(6)}  ${line.stage.padEnd(8)}  ${line.company} <${line.email}>`,
    );
  }
  console.log(
    options.dryRun
      ? "dry run: nothing written"
      : `CRM: ${created} created, ${updated} updated, ${notes} notes. Enrichment spent $${(spentMicroUsd / 1e6).toFixed(2)}.`,
  );
}

function emptyEnrichment(now: Date): Enrichment {
  return {
    version: 1,
    enrichedAt: now.toISOString(),
    costMicroUsd: 0,
    homepage: { found: false, title: null, description: null, foundingDate: null },
    profile: {
      found: false,
      hqCountry: null,
      foundedYear: null,
      fundingStage: null,
      totalFundingUsd: null,
      revenueEstimate: null,
      gtmMotions: [],
      customerSegments: [],
    },
    socials: {},
  };
}

await main();

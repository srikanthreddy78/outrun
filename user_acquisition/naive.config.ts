/**
 * Outrun's user-acquisition stack on Naive, read by `naive up`:
 *
 * - the `outrun` persona and its inbox, which wakes `inbox-triage` on every email that arrives;
 * - the `outreach` app: the leads dashboard Studio opens at `/`, the crew's MCP tools (`outreach.*`),
 *   the one-click unsubscribe page at `/u/<token>`, and the suppression list in the app's Postgres;
 * - the prospects table, filled by `prospector` with emails `outreach.save_prospect` verifies;
 * - the `landing` app: the static landing page in `landing_page/`, served at heyoutrun.com;
 * - the CRM page in the Studio, Naive's built-in CRM loaded by `crm/sync.ts` with fit scores;
 * - the three agents in `crew/agents.ts`.
 *
 * The inbox lives on `OUTREACH_MAIL_DOMAIN` when set (a domain bought or connected in Naive), and on
 * the organization's free system subdomain otherwise.
 */
import { defineProject } from "@usenaive-sdk/blueprints";
import { IDENTITY, INBOX, PROSPECTOR, SENDER } from "./crew/agents.ts";

const mailDomain = process.env["OUTREACH_MAIL_DOMAIN"] || undefined;
const mailingAddress = process.env["OUTREACH_MAILING_ADDRESS"] || undefined;

export default defineProject({
  name: "user-acquisition",
  title: "Outrun user acquisition",
  description:
    "Outreach email for Outrun: approved sends with one-click unsubscribe, and an inbox agent that handles every reply.",

  /** Naive's built-in CRM in the Studio, filled by `crm/sync.ts` with every prospect and its fit score. */
  mini_apps: [
    {
      slug: "crm",
      name: "CRM",
      icon: "person",
      pages: [
        {
          slug: "leads",
          title: "Leads",
          spec: {
            root: "page",
            elements: {
              page: { type: "Page", props: {}, children: ["crm"] },
              crm: { type: "Crm", props: {} },
            },
          },
        },
      ],
    },
  ],

  identities: [
    {
      name: IDENTITY,
      description: "Outrun itself: the persona outreach is sent from and replies arrive to.",
      inbox: {
        localpart: "hello",
        agent: INBOX.name,
        ...(mailDomain === undefined ? {} : { domain: mailDomain }),
      },
    },
  ],

  apps: [
    {
      name: "outreach",
      type: "fullstack",
      description: "The crew's outreach tools, the one-click unsubscribe page, and the suppression list.",
      deploy_dir: "dist",
      mcp: "/mcp",
      required: true,
      env: {
        UNSUBSCRIBE_SECRET: { generate: true as const },
        /** Studio signs the leads dashboard in by minting a ticket from this; nobody ever sees it. */
        DASHBOARD_TOKEN: { generate: true as const },
        /** For a browser Studio can't sign in: shown in the app's Access panel in Studio. */
        DASHBOARD_PASSWORD: { generate: true as const },
        OUTREACH_STUDIO_URL: "https://app.usenaive.ai",
        ...(mailingAddress === undefined ? {} : { OUTREACH_MAILING_ADDRESS: mailingAddress }),
      },
    },
    {
      name: "landing",
      type: "frontend_only",
      description: "Outrun's public landing page, served at heyoutrun.com.",
      deploy_dir: "landing_page",
    },
  ],

  agents: [SENDER, INBOX, PROSPECTOR],

  /** `aga` was the persona's name before the company was named Outrun. */
  removed: { identities: ["aga"] },
});

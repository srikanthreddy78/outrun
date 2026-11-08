# Outreach email template

The first email each prospect gets, written from `wiki/PRODUCT.md`: Outrun is a product marketing
agency that the prospect's coding agent uses, and its feedback loop ships code. Plain text, one
recipient, anonymous ("The Outrun team", written as "we"), and one link besides the unsubscribe
link: `heyoutrun.com/llms.txt`, the page written for the prospect's agent. Every send waits for a
person's approval, so nothing below goes out until someone approves it.

## Envelope

| Field   | Value                                                                                       |
| ------- | ------------------------------------------------------------------------------------------- |
| From    | `hello@launchpad-marketing-prgqe7.usenaive.ai` until an inbox exists on a domain of our own |
| To      | `{{contact_email}}`, one recipient only                                                     |
| Subject | `Marketing your coding agent can run, for {{company}}`                                      |

## Body

```text
Hi {{first_name_or_team}},

We came across {{company}} through {{found_via_label}}. You ship {{what_they_ship}}.

Outrun is a product marketing agency built for coding agents. Tell the agent that builds
{{company}} (Claude Code, Codex or similar) to use Outrun, and it sends us three things: a
product link, a brand style and a marketing theme. We send back a marketing plan for your
agent to review, then run your marketing on TikTok and Instagram.

The part most agencies skip: what we hear comes back to your agent as tickets it can ship, each
with the evidence attached. That means comments on our posts, complaints in competitors'
reviews, Reddit threads, and which hooks got attention. If the hook that lands is "never lose
your streak" but your landing page leads with "beautiful habit tracking", your agent gets a
ticket to change the headline, not just a report.

We're opening early access. Reply "yes" and we'll send the details, or point your agent at
heyoutrun.com/llms.txt and it can take it from there.

The Outrun team
```

## Footer (added automatically)

`outreach.prepare_email` appends this to every email. The agent can't remove it, and approvers
should reject any email without it.

```text
--
Not interested? Unsubscribe in one click: https://outreach-9vzp5sprgqe7.vercel.app/u/{{token}}
{{mailing_address}}
```

- `{{token}}` is 32 characters, unique per recipient address.
- The `{{mailing_address}}` line appears only once `OUTREACH_MAILING_ADDRESS` is set. US
  commercial email law (CAN-SPAM) requires a postal address, so set it before any real outreach.

## Where each field comes from

| Field                    | Source                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{contact_email}}`      | `outrun_prospects.contact_email`: published on the company's own page and verified by `outreach.save_prospect`                                                                                                                           |
| `{{company}}`            | `outrun_prospects.company`                                                                                                                                                                                                               |
| `{{what_they_ship}}`     | `outrun_prospects.why_fit`, cut down to the product itself, e.g. "a habit tracker for iOS" or "a REST API for generating images from templates"                                                                                          |
| `{{found_via_label}}`    | From `outrun_prospects.found_via`: `mcp_registry` → "the MCP Registry", `glama` → "Glama", `smithery` → "Smithery", `apis_guru` → "APIs.guru", `product_hunt` → "Product Hunt", `yc` → "the YC directory", `hacker_news` → "Hacker News" |
| `{{first_name_or_team}}` | First word of `outrun_prospects.contact_name`; "{{company}} team" when there's no name                                                                                                                                                   |

## Rules for every email

- Anonymous: signed "The Outrun team", never a person's name, title, phone or personal email.
- No invented facts: no metrics, customer names, results or prices. The streak example is the
  illustration from `wiki/PRODUCT.md`, phrased as a hypothetical ("If the hook that lands...").
- Don't promise what doesn't exist yet: no install command or public CLI/MCP connector. Early
  access is by reply, or through `heyoutrun.com/llms.txt`.
- A reply of "yes" lands in the inbox, where `inbox-triage` logs it as a human reply. Someone has
  to answer it with the early-access details; nothing answers automatically yet.

## Follow-ups

Sent only if there's no reply and the address hasn't unsubscribed or bounced. These aren't
automated yet; each would go through the same prepare-and-approve path.

**Day 3**, same thread subject with `Re: `:

```text
Hi {{first_name_or_team}},

A quick nudge on Outrun. Your coding agent hands us the product, we run the marketing, and
what we learn comes back as tickets it can ship. Reply "yes" for early access, or point your
agent at heyoutrun.com/llms.txt.

The Outrun team
```

**Day 7**, the last email; nothing is sent after this:

```text
Hi {{first_name_or_team}},

Last note from us. If you ever want your coding agent to hand off {{company}}'s marketing,
reply any time, or have it read heyoutrun.com/llms.txt.

The Outrun team
```

# Outreach email template

The first email each prospect gets. Plain text, one recipient, no links except the unsubscribe
link the system adds. Emails are anonymous: they're signed "The Outrun team" and never name
anyone on the team. Every send waits for a person's approval, so nothing below goes out
until someone approves it.

## Envelope

| Field   | Value                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------- |
| From    | `hello@launchpad-marketing-prgqe7.usenaive.ai` until a domain is bought, then `hello@<that domain>` |
| To      | `{{contact_email}}`, one recipient only                                                             |
| Subject | `{{company}} and AI agents`                                                                         |

## Body

```text
Hi {{first_name_or_team}},

We came across {{company}} through {{found_via_label}}. You ship {{why_fit}}, so AI agents are
already one of your users, whether they show up in your analytics or not.

Agents decide in seconds whether they can use a product: they look for an llms.txt, a clean
OpenAPI spec, an MCP listing, docs they can read without running JavaScript, and pricing they
can parse. Most teams are missing two or three of these without knowing it.

We run a free agent-readiness scan that scores {{domain}} on 14 of these checks and lists your
top three gaps. Want us to send yours over? Just reply "yes".

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
- The `{{mailing_address}}` line appears only once `OUTREACH_MAILING_ADDRESS` is set. US commercial
  email law (CAN-SPAM) requires a postal address, so set it before any real outreach.

## Where each field comes from

| Field                    | Source                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{contact_email}}`      | `outrun_prospects.contact_email`: published on the company's own page and verified by `outreach.save_prospect`                                                                                                                           |
| `{{company}}`            | `outrun_prospects.company`                                                                                                                                                                                                               |
| `{{domain}}`             | `outrun_prospects.domain`                                                                                                                                                                                                                |
| `{{why_fit}}`            | `outrun_prospects.why_fit`, shortened to a phrase, e.g. "an MCP server for your billing API"                                                                                                                                             |
| `{{found_via_label}}`    | From `outrun_prospects.found_via`: `mcp_registry` → "the MCP Registry", `glama` → "Glama", `smithery` → "Smithery", `apis_guru` → "APIs.guru", `product_hunt` → "Product Hunt", `yc` → "the YC directory", `hacker_news` → "Hacker News" |
| `{{first_name_or_team}}` | First word of `outrun_prospects.contact_name`; "{{company}} team" when there's no name                                                                                                                                                   |

## Example

For a made-up prospect, Acme Tools (`acmetools.example`), found on Glama, contact Jane Doe:

```text
To: jane@acmetools.example
Subject: Acme Tools and AI agents

Hi Jane,

We came across Acme Tools through Glama. You ship an MCP server for your scheduling API, so AI
agents are already one of your users, whether they show up in your analytics or not.

Agents decide in seconds whether they can use a product: they look for an llms.txt, a clean
OpenAPI spec, an MCP listing, docs they can read without running JavaScript, and pricing they
can parse. Most teams are missing two or three of these without knowing it.

We run a free agent-readiness scan that scores acmetools.example on 14 of these checks and
lists your top three gaps. Want us to send yours over? Just reply "yes".

The Outrun team

--
Not interested? Unsubscribe in one click: https://outreach-9vzp5sprgqe7.vercel.app/u/3fQ9…
```

## Follow-ups

Sent only if there's no reply and the address hasn't unsubscribed or bounced. These aren't
automated yet; each would go through the same prepare-and-approve path.

**Day 3**, same thread subject with `Re: `:

```text
Hi {{first_name_or_team}},

Quick nudge on the free agent-readiness scan for {{domain}}. It takes a few minutes and
you get the score plus your top three gaps. Reply "yes" and it's yours.

The Outrun team
```

**Day 7**, the last email; nothing is sent after this:

```text
Hi {{first_name_or_team}},

Last note from us. If agents using {{company}} ever becomes a priority, reply any time and
we'll run the scan.

The Outrun team
```

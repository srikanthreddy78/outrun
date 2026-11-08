# Marketing

Outrun's marketing loop from `wiki/PRODUCT.md`, as its own Naive project (`outrun-marketing`),
separate from the crew in the root `naive.config.ts`. It lives in the Naive account that has the X
account connected (the second account).

| Piece           | What it does                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promoter`      | Triages an app once, makes two posters in its style from HTML, and posts a poster or a saved short video to the connected accounts. Each post waits for approval. |
| `producer`      | Makes a vertical short-form video and a voiced demo of the real product, and saves them with `publish_file`. Never posts.                                         |
| `listener`      | Every four hours, reads new X comments, saves a summary and suggestions per app, and emails each owner the summary. Each email waits for approval.                |
| `outrun-studio` | Internal dashboard and the agents' records: each app served, its owner email, posts, comments read, suggestions, media.                                           |

Playbooks are in `skills/`. The studio's agent tools are in `app/mcp.ts`.

- Owner emails are where summaries go. `send_summary` takes only the app, so the recipient and text
  come from the studio's records, and each set of suggestions can go out once.
- Comments are stored as text only, without their authors.
- If an app needs an account, the promoter gets a throwaway inbox from `new_test_inbox` and reads
  it with `read_test_inbox`. The AgentMail key stays on the studio's server, and those inboxes
  never send.

## Deploy

```sh
cd marketing
pnpm build
NAIVE_API_KEY=$NAIVE_TWO_API_KEY AGENTMAIL_API_KEY=$AGENTMAIL_API_KEY OUTRUN_IDENTITY_ID=<idn_…> \
  node ../node_modules/@usenaive-sdk/cli/dist/index.js up
```

`naive up` mints the studio a read-only Naive key. Check `naive whoami` first: this must never go
to the primary account.

## Run

Start each session with `--identity <idn_…>`. Without it the agent has no social tools, even
though its config names the identity.

```sh
naive session create --agent <promoter id> --identity <idn_…> --message "App: <url>"
```

Then open the studio from Naive Studio to see the app, its posts, comments and suggestions.

To post a saved video, ask for it: `--message "App: <url>. Post its short video."`

An agent saying a post went out isn't enough: `social.post` returns `scheduled`, and the network can
still refuse it. The promoter checks `social.status` and reports what it reads; to check yourself,
run `naive social show --identity <idn_…> --post <id>`.

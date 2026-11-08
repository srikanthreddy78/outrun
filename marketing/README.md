# Marketing

Outrun's marketing loop from `wiki/PRODUCT.md`, as its own Naive project (`outrun-marketing`),
separate from the crew in the root `naive.config.ts`. It lives in the Naive account that has the X
account connected (the second account).

| Piece           | What it does                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promoter`      | Triages an app once, makes two posters in its style from HTML, and posts a poster or an approved short video to the connected accounts. Each post waits for approval. |
| `producer`      | Makes a vertical short-form video and a voiced demo of the real product, and saves them with `publish_file`. Never posts.                                             |
| `reviewer`      | Hourly, checks each saved short's spec, captions, brand and claims and saves a verdict. Never posts or sends.                                                         |
| `listener`      | Every four hours, reads new X comments, saves a summary and suggestions per app, and emails each owner the summary. Each email waits for approval.                    |
| `outrun-studio` | Internal dashboard and the agents' records: each app served, its owner email, posts, comments read, suggestions, media, video jobs and reviews.                       |

Playbooks are in `skills/`. The studio's agent tools are in `app/mcp.ts`.

- Owner emails are where summaries go. `send_summary` takes only the app, so the recipient and text
  come from the studio's records, and each set of suggestions can go out once.
- Comments are stored as text only, without their authors, and handles in reply text are masked.
- If an app needs an account, the promoter gets a throwaway inbox from `new_test_inbox` and reads
  it with `read_test_inbox`. The AgentMail key stays on the studio's server, and those inboxes
  never send.

## Publishing to X and Reddit

X and Reddit posting are manual for now. The promoter records each post with `queue_post`, and it shows in the
**Post ledger** on the app's dashboard page. Publish from the ledger by hand, then mark the entry
with `mark_posted` and the live URL, which on X also registers the post so its replies can be read. Reddit replies aren't read yet.

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

## Video jobs

`register_client` queues one video job per app. From there it runs on two hourly schedules, and the
app's dashboard page shows the job's status and event trail.

| Step                                       | Who        | Tool                                 |
| ------------------------------------------ | ---------- | ------------------------------------ |
| Makes the short, saves it, sends to review | `producer` | `next_video_job`, `finish_video_job` |
| Checks it and saves a verdict              | `reviewer` | `next_review_job`, `save_review`     |

The producer checks at :05 and the reviewer at :35, and a session with nothing to do stops at once.
On `changes` the producer revises and the reviewer looks again, at most twice; after that the job
stops at `needs_person`. A session that dies gives up its claim when its lease runs out, and after
three attempts the job is marked `failed`.

Clients that existed before this shipped get a job too, the first time the studio starts.

## Post a client's video

Only a short with an `approved` review is posted. Each client posts to its own accounts, through
its own identity:

1. Create the client's identity, let the promoter select it, and turn on social (this needs a key
   with `billing:write`):

   ```sh
   naive identity create --name "<app name>" --description "Accounts for <app name>"
   naive identity attach --agent <promoter id> --identity <idn_…>
   naive social activate --identity <idn_…>
   ```

2. Get the connect link and send the printed `url` to the client, exactly as printed. They open it
   and connect their own accounts; nobody else can do this for them.

   ```sh
   naive social portal --identity <idn_…>
   naive social accounts --identity <idn_…>   # after they've connected
   ```

3. Start the promoter with that identity, and name it in the message too:

   ```sh
   naive session create --agent <promoter id> --identity <idn_…> \
     --message "App: <url>. Identity: <idn_…>. Post its short video."
   ```

   The first run records the identity with `set_client_identity`, which waits for your approval.
   `social.post` waits for your approval as well: `naive session confirm --session <id> --tool-call <id> --allow`.

## Posting directly to X

Naive's `social.post` comes first. If X refuses it, the promoter can call `post_direct` once, which
waits for approval and posts with the studio's own keys. Set these in the shell before `naive up`:

| Variable                | What it is                                    |
| ----------------------- | --------------------------------------------- |
| `X_API_KEY`             | The X app's API key (OAuth 1.0a consumer key) |
| `X_API_SECRET`          | The X app's API secret                        |
| `X_ACCESS_TOKEN`        | The access token of the account to post as    |
| `X_ACCESS_TOKEN_SECRET` | That access token's secret                    |

All four are optional; without them `post_direct` answers that it isn't configured. They belong to
one X account, so every direct post goes there, not to a client's own account. The same app, text
and file post once. Replies on direct posts are read by `sync_x`, at most once per listener run.

## Replies on posts Naive didn't make

`track_post` registers a live x.com post under an app. Each listener run reads the replies with
Naive's data tools, which need no X keys and bill at their listed price against the run's budget (at
most 25 results per post, 20 posts per run), and stores them with `add_comments`, text only.

An agent saying a post went out isn't enough: `social.post` returns `scheduled`, and the network can
still refuse it. The promoter checks `social.status` and reports what it reads; to check yourself,
run `naive social show --identity <idn_…> --post <id>`.

# The community prefab library — setup and moderation

The library is the one part of OpsForge with a server. It runs on the same
Vercel deployment as the editor: `api/index.js` is a single serverless
function, `admin/` is the moderation page, and the rules both the editor and
the server keep are in `src/prefablib.js`. No npm dependencies — everything
outside is reached with `fetch`.

```
browser ──► /api/library, /api/submit, /api/report ──► api/index.js ──┬─ Upstash Redis   records, reports, bans, tags, sessions
            /api/admin/*  (admin cookie)                              ├─ Vercel Blob     prefab.json, thumbnail, 360° strip
                                                                      ├─ mod.io /me      who a contributor is (token used once, never kept)
                                                                      └─ Resend          the admin's sign-in code
```

## Setting it up

All on the Vercel project that serves the editor (`opsforge`, team
`rorick-tech`):

| What | How | Environment variables it sets |
| --- | --- | --- |
| Redis | Vercel dashboard → Storage → **Upstash for Redis**, connected to the project | `KV_REST_API_URL`, `KV_REST_API_TOKEN` |
| File store | `vercel blob create-store`, connected to the project | `BLOB_READ_WRITE_TOKEN` |
| Mail | Your Resend key, and a sender on a domain Resend has verified | `RESEND_API_KEY`, `RESEND_FROM` |
| Admins | Comma-separated addresses that may sign in to `/admin/` | `OPSFORGE_ADMIN_EMAILS` |
| Session secret | 32+ random characters; codes and sessions are stored as hashes keyed by it. Changing it signs every admin out | `OPSFORGE_SECRET` |

Until Redis and Blob are both connected, every endpoint answers "the prefab
library is not set up on this copy of OpsForge" and the editor says so; nothing
half-works. Without Resend or an admin address the library works and the admin
page cannot be signed in to.

Deploy as usual (`npm run package`, then `vercel deploy --prod` from
`dist/spatial-ops-map-editor/`): the packager copies `api/`, `admin/` and the
three shared modules into the release, and writes the rewrite that sends every
`/api/<route>` to the one function.

Locally, `npm run serve` runs the same function against an in-memory store: a
mod.io token `dev:<id>:<name>` is that person, and the admin code for
`admin@opsforge.test` is printed to the console instead of mailed.

## Moderating

Click the OpsForge wordmark **ten times** (or open `/admin/`) and sign in with an
allowlisted address; a six-digit code is mailed to it. The page is not secret —
it is just not signposted — and does nothing until you are signed in.

- **Review** — hidden prefabs: reported past the threshold, hidden by hand, or
  shared by an account since banned, each with every report (who, why, any
  note). **Restore** puts it back and clears its reports; **Delete** removes the
  record and its files for good.
- **Library** — everything live, most-reported first, with **Hide**, **Dismiss
  reports**, **Edit** (title, description, tags) and **Delete**.
- **Tags** — tags people wrote themselves, with their uses and reports.
  **Hide** takes a tag off every card and out of the picker, and stops it being
  used again; **Rename** onto an existing tag merges the two — the way to fold
  "buliding" into "building".
- **Banned** — mod.io accounts that can no longer share or report. **Ban author**
  on any prefab bans its author and moves everything they shared into Review,
  where you decide what to delete. Bans are by mod.io account id, which is
  stable; mod.io never gives OpsForge anybody's email address.
- **Settings** — how many reports from different accounts hide something
  (default 3).

Delete and Ban author ask for a second click within three seconds.

## Limits, and why

| | |
| --- | --- |
| 300 objects per prefab | a piece of a map; the whole map's budget is 700 |
| 10 shares per account per day, 30 per address | spam |
| 40 reports per account per day | brigading |
| 5 admin codes per address per hour, 20-minute codes, 5 tries | guessing |
| Pictures exactly 384 px and 24 × 192 px | the editor makes them; nothing else is accepted |
| Request body 4 MB | Vercel's ceiling is 4.5 MB |

The public listing is cached at Vercel's edge for 15 seconds, so a hide or a
restore reaches everybody within about that.

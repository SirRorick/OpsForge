# The community prefab library — setup and moderation

The library is the one part of OpsForge with a server. It runs on the same
Vercel deployment as the editor: `api/index.js` is a single serverless
function, `admin/` is the moderation page, and the rules both the editor and
the server keep are in `src/prefablib.js`. No npm dependencies — everything
outside is reached with `fetch`.

```
browser ──► /api/library, /api/submit, /api/report, /api/file/… ──► api/index.js ──┬─ Vercel Blob (private)  the records, and every prefab's files
            /api/admin/*  (admin cookie)                                           ├─ mod.io /me             who a contributor is (token used once, never kept)
                                                                                   └─ Resend                 the admin's sign-in code
```

Everything is kept in **one private Vercel Blob store** — nothing outside
Vercel, and nothing in it readable without the project's own credential:

- `prefabs/<id>/…` — each prefab's `prefab.json`, thumbnail and 360° strip,
  written once under a random name and never changed. The function hands them
  out at `/api/file/…`, cached for a day by the browser and Vercel's edge.
- `library/state.json` — every record, report, tag, ban and setting, as one
  document. Each request reads it, works on a copy, and writes it back once if
  it succeeded and changed something — over the version it read, or not at all
  (an ETag precondition), so two writers at once re-read and replay rather than
  lose each other's work. A request that is refused, or changes nothing, writes
  nothing.

## Setting it up

All on the Vercel project that serves the editor (`opsforge`, team
`rorick-tech`):

| What | How | Environment variables it sets |
| --- | --- | --- |
| Store | Dashboard → Storage → Create → **Blob**, access **Private**, connected to the project (all environments) — or `vercel blob create-store <name> --access private --yes` from a linked folder | `BLOB_STORE_ID` (and the project's OIDC token, which Vercel hands each request) |
| Mail | Your Resend key, and a sender on a domain Resend has verified | `RESEND_API_KEY`, `RESEND_FROM` |
| Admins | Comma-separated addresses that may sign in to `/admin/` | `OPSFORGE_ADMIN_EMAILS` |
| Session secret | 32+ random characters; codes and sessions are signed with it. Changing it signs every admin out | `OPSFORGE_SECRET` |
| *(optional)* Allowance | The store's monthly uploads and writes, if not the free plan's 2,000 | `OPSFORGE_BLOB_OPS` |

The store must be **private**: the records are in it. The library uses the
store `BLOB_STORE_ID` names and nothing else — a read-write token on its own
does not say whether its store is private. A project can have only one store
connected under the default names, so a public store connected earlier has to
be disconnected (or deleted, if it is empty) first. With OIDC turned off for
the project, a classic `vercel_blob_rw_<store>_<secret>` token for the same
store is used instead.

Until a store is connected every endpoint answers "the prefab library is not
set up on this copy of OpsForge" and the editor says so; nothing half-works.
Without Resend or an admin address the library works and the admin page cannot
be signed in to.

Deploy as usual (`npm run package`, then `vercel deploy --prod` from
`dist/spatial-ops-map-editor/`): the packager copies `api/`, `admin/` and the
three shared modules into the release, and writes the rewrite that sends every
`/api/<route>` to the one function. Environment changes need a redeploy.

Then open **`/api/health`**. It reads the records and writes nothing, and says
whether the store is reachable and how it authenticated (`credential: "oidc"`),
how many prefabs there are, this month's storage use, and whether mail, the
admin list and the secret are set — without anybody having to copy a
credential anywhere.

Locally, `npm run serve` runs the same function against an in-memory store: a
mod.io token `dev:<id>:<name>` is that person, and the admin code for
`admin@opsforge.test` is printed to the console instead of mailed.

## The month's allowance

The free plan's Blob store allows **2,000 uploads and writes a month**; past
that it stops for thirty days, every prefab's pictures with it. It never
charges. The library counts its own — sharing is four (three files and the
record), a report, a sign-in code or an admin change is one, and deleting is
free — and stops each kind of change before the store would:

| | stops at |
| --- | --- |
| New prefabs | 75% (1,500) |
| Reports | 90% (1,800) |
| The admin's own changes | 97.5% (1,950) |

Browsing and placing never stop. The month is the calendar month in UTC, which
is near enough to the plan's own thirty days with this much room left. Browsing
the store in the Vercel dashboard counts against the same allowance. The
admin page's Settings tab shows where the month stands.

## Moderating

Click the OpsForge wordmark **ten times** (or open `/admin/`) and sign in with an
allowlisted address; an eight-character code (`ABCD-EFGH`) is mailed to it, and
works for twenty minutes in the browser that asked for it. The page is not
secret — it is just not signposted — and does nothing until you are signed in.

Neither the code nor the session is stored: asking for a code sets a cookie
holding a keyed hash of it, and the session is a signed cookie that lasts a
week. That is why the code is eight characters rather than six digits — with
no database counting wrong guesses everywhere at once, it has to be unguessable
on its own. **Sign out** ends a session for every copy of its cookie; changing
`OPSFORGE_SECRET`, or taking an address off the list, ends all of them.

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
  (default 3), and the month's storage use.

Delete and Ban author ask for a second click within three seconds. A deleted
prefab leaves every card at once; its files can still be fetched for up to a
day by anybody who already had their address.

## Limits, and why

| | |
| --- | --- |
| 300 objects per prefab | a piece of a map; the whole map's budget is 700 |
| 10 shares per account per day, 30 per address | spam |
| 20 reports per account per day | brigading |
| 3 admin codes per address per hour, 8 a day; 20-minute codes | guessing, and a flooded inbox |
| Pictures exactly 384 px and 24 × 192 px | the editor makes them; nothing else is accepted |
| Request body 4 MB | Vercel's ceiling is 4.5 MB |

The public listing is cached at Vercel's edge for 15 seconds, so a hide or a
restore reaches everybody within about that.

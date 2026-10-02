# Slop Rooster

A small screen recorder: enter the shared access UUID, record, stop, and copy a link. Videos upload automatically. Two optional controls protect the link with a permanent viewing token and generate Markdown from the recording with Gemini.

It runs on [ohmyho.st](#hosting-on-ohmyhost) or on your own Cloudflare account ([Deploy to Cloudflare](#deploy-to-cloudflare)).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MAKESEB/loom-for-poor-people)

## Run locally

Use Node.js 22.13 or later and npm 10.9.8.

```sh
npm ci
npm run setup
npm run dev
```

`npm run setup` creates private `.env.local` settings and preserves existing values. Read `SLOP_ROOSTER_ACCESS_UUID` there to sign in. Add your Gemini API key privately as `GEMINI_API_KEY` to enable Markdown; recording and sharing work without it. Never prefix a server secret with `VITE_`.

Local development uses disk-backed private files in `.local/storage` and embedded Postgres (PGlite) in `.local/database`. It runs the same SQL migration as hosting. The local recovery interval is 15 seconds; hosted recovery runs every five minutes. `npm run preview` serves the frontend build only; use `npm run dev` for the full application.

## Record and share

- Desktop screen, window or tab recording, optional microphone and browser-supported screen audio.
- Pause/resume, automatic upload when stopped, and local download if an upload needs retrying.
- No fixed duration stop; up to 10 GiB per recording on Cloudflare, and up to 1 GiB on ohmyho.st and in local `npm run dev` (see [Hosting on ohmyho.st](#hosting-on-ohmyhost)). Available browser storage can reduce that cap; the displayed limit reflects it. Browsers without private file storage and Web Locks use a 128 MiB fallback.
- Unlisted `/v/<uuid>` is always read-only, including when the creator opens it. Authenticated `/manage/<uuid>` contains the sharing and Markdown controls. Successful uploads open that management page; the copied link always points to the recipient page.
- **Protect link** requires a permanent per-video token for metadata, playback, seeking and Markdown/downloads. It is access control, not end-to-end encryption.
- **Generate Markdown** is separate from recording capacity and currently accepts videos up to 50 MiB. Larger videos can still be recorded, watched, downloaded and shared; management shows the AI limit. Only pressing **Generate** sends a video to Gemini. An empty goal produces a briefing; a custom goal can request a transcript or another format.
- Markdown appears beneath the video and supports copy/download. Disabling the toggle hides it from viewers without deleting the saved result.
- **Delete recording** on the management page asks for a confirmation, then removes the stored video (every part of a long recording) and the saved Markdown, and returns to the recorder. Its links stop working for everyone. The database keeps a tombstone row titled "Deleted recording", because Markdown jobs reference it and may still have to clean up Gemini resources; every route answers it as missing. If a deletion is interrupted, deleting again finishes it.

Everyone with the shared access UUID has the same creator privileges in the management interface. Recipient requests use explicit public access, ignore creator cookies, and cannot modify settings or start AI work. Protected sharing links require their viewing token even in a signed-in creator's browser. Creator sessions use signed host-bound cookies for 30 days. Rotating the access UUID or session secret invalidates creator sessions; rotating `SHARE_TOKEN_SECRET` invalidates previously issued protected viewing links.

On supported browsers, recording chunks are written to origin-private browser files and retained through preview/upload. WebM duration repair reads bounded metadata rather than copying the full video into JavaScript memory. A tab-close warning protects unsaved work. Completed uploads release their temporary local files; inactive, marked local buffers older than 24 hours are cleaned conservatively, while Web Locks protect other active tabs. This cache is temporary and is not a cross-tab recording-recovery feature.

## Runtime and background work

Both hosting targets run the same Web-standard API handler (`src/server/api.ts`), Markdown job service and client. On ohmyho.st, the Vite API companion (`src/ohmyhost/companion.ts`) uses the private Storage Gateway and Postgres (`migrations/`). On Cloudflare, the Worker (`src/worker.ts`, composed in `src/server/cloudflare.ts`) uses a private R2 bucket and D1 (`migrations-d1/`); `src/server/r2-storage.ts` gives R2 the same reservation, receipt and short-lived capability semantics as the managed gateway, so the upload, recovery and playback code is shared.

The Vite API companion uses the ohmyho.st private Storage Gateway and database runtime SDK. Videos remain private; authenticated same-origin application routes stream uploads and authorized playback. Database rows persist upload reservations, sharing settings and Markdown jobs. The runtime remains imported as `@ohmyhost/customer-runtime`, using the exact npm alias reported by the current CLI's `init` inspection.

Recordings above 50 MiB upload as sequential 8 MiB private objects. A durable manifest records each part's expected length, receipt, digest and fenced upload lease. Completion publishes only a complete manifest. Playback and downloads concatenate immutable parts on demand, including byte ranges that cross part boundaries; no whole-file server buffer or final assembly upload is needed. Identical part retries are safe and changed bytes conflict. Incomplete server-side parts remain private and resumable; automatic server cleanup is deliberately deferred until an explicit retention policy is chosen.

Videos are streamed as inline Base64 input to Gemini background Interactions, with bounded byte counts and timeouts. The response reader discards echoed video data while retaining bounded Markdown output. The Files adapter remains available to recover existing jobs; the current provider rejects Files-backed video references in background Interactions, so new jobs use the verified inline path. Durable jobs use database claims, expiring leases and fencing to prevent concurrent Dev/production workers from publishing stale results. Known provider IDs can be reconciled after reload or by scheduled recovery; opening a viewing page never starts a new billable generation. Videos larger than 10 MiB start on the next scheduled run (up to five minutes), keeping large transfers outside the short HTTP background-work window.

An ambiguous Gemini creation result is marked uncertain and requires an explicit new attempt. It is never silently resubmitted. Finished Markdown is stored before temporary provider data is deleted; cleanup failures are retried independently. AI failures leave the video usable. Markdown rendering disables raw HTML and unsafe links.

## Hosting on ohmyho.st

The authorized deployment is in the **MAKESEB** workspace, in the **EU**, with **shared Dev/production data**. `ohmyhost.yaml` enables only hosting, private storage, Postgres, scheduled recovery and the required Gemini and EU storage egress origins. Application access is custom UUID authentication; managed auth and mail are disabled.

`public/_headers` uses ohmyho.st's exact supported opt-in: `media-src 'self' blob:` and `microphone=(self)`. The gateway retains its other restrictions. Do not replace these fragments with a complete CSP or additional permission directives: broader declarations are ignored. Verify the actual document headers and browser playback after deploying.

Use production for public sharing. Protected Dev uses `ohmyhost project dev-share link --project <project-id> --json`; its reusable link has no automatic expiry, but each browser session is time-limited. Keep it private to intended recipients. An anonymous Dev 404 is expected. The app's UUID login and per-video viewing tokens remain separate from this hosting access link.

Server settings, installed through the hosting CLI's stdin-only secret workflow in both environments:

- `SLOP_ROOSTER_ACCESS_UUID`
- `APP_SESSION_SECRET`
- `SHARE_TOKEN_SECRET`
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (default `gemini-3.8-flash`)

Keep the access/share secrets compatible between environments because videos and settings are shared. Browser cookies remain host-bound. Test writes and migrations affect shared data. Keep schema changes additive and verify existing links before promotion.

Deleted recordings are marked by an additive `deleted_at` column (`migrations/20261002090000_deleted_recordings.sql`), because the `upload_state` CHECK constraint cannot change. A backend from before this migration would still list such a tombstone as a ready recording without its video, so promote the compatible backend to both environments before deleting recordings that production serves.

Recordings on ohmyho.st stay limited to 1 GiB (128 parts). The Postgres CHECK constraints on the recording size, part count and part index would have to be relaxed for more, which the hosting's additive-only migration contract does not allow; the Cloudflare schema (`migrations-d1/`) allows 10 GiB.

The larger-recording migration adds effective `full_size_bytes` and `full_duration_seconds` columns because the hosting migration contract does not allow dropping the old CHECK constraints. Legacy columns retain bounded compatibility values; the repository reads the full fields when present. Existing single-object recordings remain unchanged. New multipart recordings need the compatible backend on both environments: promote it before sharing Dev-created multipart records through production, and do not roll back to a pre-multipart artifact once large videos exist.

Follow the official [deployment workflow](https://ohmyho.st/skills/ohmyhost-deploy-github/SKILL.md): inspect, link the exact pushed GitHub commit, review its plan, deploy Dev, verify its protected URL, then promote the same artifact. A successful build or root HTTP response alone is not application verification.

## Deploy to Cloudflare

Slop Rooster also runs as one Cloudflare Worker on your own account: Workers static assets serve the Vite build, `/api/*` runs the Worker, D1 stores recordings, upload manifests, sharing settings and Markdown jobs, a private R2 bucket stores the videos, and a five-minute cron trigger runs Markdown recovery. Sign-in is the same shared access UUID with signed session cookies; no other Cloudflare product (such as Access) is needed.

### Prerequisites

- A Cloudflare account with R2 enabled (the dashboard asks once before the first bucket).
- The **Workers Paid** plan. On Workers Free, a request may use only 10 ms of CPU time and 50 subrequests, and calls to R2 and D1 count as subrequests. Every upload is verified with SHA-256, about 35 ms of CPU per 8 MiB part and roughly 0.2 s for a 50 MiB upload, and playing a recording above 50 MiB reads its 8 MiB parts from R2 (about three R2 operations per part, so close to 4,000 for a full 10 GiB download). Workers Paid allows 30 seconds of CPU per request by default and 10,000 subrequests; cron runs every five minutes get 30 seconds of CPU. Check the current numbers in [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- Node.js 22.13 or later and npm 10.9.8.

### Deploy with the button

The **Deploy to Cloudflare** button above copies this repository to your GitHub or GitLab account, creates the D1 database and R2 bucket, asks for the secrets listed below, builds, applies the D1 migrations and deploys (`npm run deploy`). Enter your own values for the three required secrets; leave `GEMINI_API_KEY` empty if you do not want Markdown.

### Deploy from the command line

```sh
npm ci
npx wrangler login
npx wrangler d1 create slop-rooster --binding DB   # once; records the database ID in wrangler.jsonc
npm run cf:deploy                                   # build, apply migrations-d1/, deploy
```

`wrangler deploy` creates the R2 bucket `slop-rooster-recordings` if it does not exist yet; to choose a location first, run `npx wrangler r2 bucket create slop-rooster-recordings --location <hint>`. Change `database_name` or `bucket_name` in `wrangler.jsonc` to use other names. If you add a jurisdiction (for example `eu`), create the resource with it and set `jurisdiction` on the R2 binding as well.

Then set the secrets. They take effect immediately:

```sh
node -e "console.log(crypto.randomUUID())"          # your access code: note it, then paste it below
npx wrangler secret put SLOP_ROOSTER_ACCESS_UUID
node -e "console.log(crypto.randomBytes(48).toString('base64url'))" | npx wrangler secret put APP_SESSION_SECRET
node -e "console.log(crypto.randomBytes(48).toString('base64url'))" | npx wrangler secret put SHARE_TOKEN_SECRET
npx wrangler secret put GEMINI_API_KEY               # optional
```

| Secret | Required | Purpose |
| --- | --- | --- |
| `SLOP_ROOSTER_ACCESS_UUID` | yes | The shared access code creators sign in with. |
| `APP_SESSION_SECRET` | yes, at least 32 characters | Signs creator session cookies. |
| `SHARE_TOKEN_SECRET` | yes, at least 32 characters | Signs the permanent viewing tokens of protected links. |
| `GEMINI_API_KEY` | no | Enables **Generate Markdown**. Recording and sharing work without it. |

`GEMINI_MODEL` is a plain variable in `wrangler.jsonc` (default `gemini-3.8-flash`). Until the three required secrets are set, the app reports that access is not configured. Rotating them has the same effects as on ohmyho.st (see [Record and share](#record-and-share)).

The app is then live at `https://slop-rooster.<your-subdomain>.workers.dev`. For your own domain, add a route with `"custom_domain": true` to `wrangler.jsonc` (the zone must be on the same account; the comment there shows the syntax), deploy again, and optionally set `workers_dev` to `false`. Session cookies are bound to the host, so creators sign in once per domain.

Later deploys are `npm run cf:deploy` again: it applies new D1 migrations before the new code goes live. Workers Logs is enabled with query strings redacted, because protected links carry their viewing token in the URL.

### Run the Worker locally

```sh
npm run cf:setup   # writes private test secrets to .dev.vars (see .dev.vars.example)
npm run cf:dev     # build, apply migrations-d1/ locally, wrangler dev on http://localhost:8787
```

`wrangler dev` keeps local D1 and R2 data in `.wrangler/`. It serves the production build, so rebuild (or rerun `npm run cf:dev`) after frontend changes; `npm run dev` remains the fastest loop for UI work.

## Verification

```sh
npm run typecheck
npm test
npm run build
ohmyhost init --dry-run --json
npx wrangler deploy --dry-run   # Cloudflare: bundles the Worker and checks wrangler.jsonc
```

Tests cover authentication, public/manage separation, origin checks, chunk upload limits and idempotency, cross-part seeking, real Postgres job claims/fencing, browser-cache cleanup, bounded WebM repair, provider failures and uncertainty. The Cloudflare target is covered with the D1 schema and repository on `node:sqlite`, the R2 storage emulation on an in-memory bucket, end-to-end Worker requests, `/api/*` versus static-asset routing and the scheduled handler. `/tests/recorder.html` is a local-only browser fixture using an animated canvas, synthesized audio and real MediaRecorder encoding. It is excluded from production. A real operating-system screen picker and microphone permission remain under browser control.

Deployment IDs, live checks and sanitized diagnostic reports are retained in the ignored `.local/ohmyhost-diagnostics/` directory. Credentials, cookies, signed storage URLs and viewing tokens must not be copied into reports or commits.

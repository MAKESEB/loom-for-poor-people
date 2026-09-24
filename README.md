# Slop Rooster

A small screen recorder: enter the shared access UUID, record, stop, and copy a link. Videos upload automatically. Two optional controls protect the link with a permanent viewing token and generate Markdown from the recording with Gemini.

## Run locally

Use Node.js 22 or later and npm 10.9.8.

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
- Up to 15 minutes or 50 MiB per video.
- Unlisted `/v/<uuid>` viewer; no public recording directory.
- **Protect link** requires a permanent per-video token for metadata, playback, seeking and Markdown/downloads. It is access control, not end-to-end encryption.
- **Generate Markdown** reveals a goal field. Only pressing **Generate** sends the video to Gemini. An empty goal produces a briefing; a custom goal can request a transcript or another format.
- Markdown appears beneath the video and supports copy/download. Disabling the toggle hides it from viewers without deleting the saved result.

Everyone with the shared access UUID has the same creator privileges. Viewers need only their complete sharing link. Creator sessions use signed host-bound cookies for 30 days. Rotating the access UUID or session secret invalidates creator sessions; rotating `SHARE_TOKEN_SECRET` invalidates previously issued protected viewing links.

## Runtime and background work

The Vite API companion uses the ohmyho.st private Storage Gateway and database runtime SDK. Videos remain private; authenticated same-origin application routes stream uploads and authorized playback. Database rows persist upload reservations, sharing settings and Markdown jobs.

Videos are streamed as inline Base64 input to Gemini background Interactions, with bounded byte counts and timeouts. The response reader discards echoed video data while retaining bounded Markdown output. The Files adapter remains available to recover existing jobs; the current provider rejects Files-backed video references in background Interactions, so new jobs use the verified inline path. Durable jobs use database claims, expiring leases and fencing to prevent concurrent Dev/production workers from publishing stale results. Known provider IDs can be reconciled after reload or by scheduled recovery; opening a viewing page never starts a new billable generation. Videos larger than 10 MiB start on the next scheduled run (up to five minutes), keeping large transfers outside the short HTTP background-work window.

An ambiguous Gemini creation result is marked uncertain and requires an explicit new attempt. It is never silently resubmitted. Finished Markdown is stored before temporary provider data is deleted; cleanup failures are retried independently. AI failures leave the video usable. Markdown rendering disables raw HTML and unsafe links.

## Hosting

The authorized deployment is in the **MAKESEB** workspace, in the **EU**, with **shared Dev/production data**. `ohmyhost.yaml` enables only hosting, private storage, Postgres, scheduled recovery and the required Gemini and EU storage egress origins. Application access is custom UUID authentication; managed auth and mail are disabled.

`public/_headers` uses ohmyho.st's exact supported opt-in: `media-src 'self' blob:` and `microphone=(self)`. The gateway retains its other restrictions. Do not replace these fragments with a complete CSP or additional permission directives: broader declarations are ignored. Verify the actual document headers and browser playback after deploying.

Protected Dev uses `ohmyhost project dev-share link --project <project-id> --json`. Its reusable link opens a browser session without automatic expiry; keep it private to intended recipients. The app's UUID login and per-video viewing tokens remain separate from this hosting access link.

Server settings, installed through the hosting CLI's stdin-only secret workflow in both environments:

- `SLOP_ROOSTER_ACCESS_UUID`
- `APP_SESSION_SECRET`
- `SHARE_TOKEN_SECRET`
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (default `gemini-3.8-flash`)

Keep the access/share secrets compatible between environments because videos and settings are shared. Browser cookies remain host-bound. Test writes and migrations affect shared data. Keep schema changes additive and verify existing links before promotion.

Follow the official [deployment workflow](https://ohmyho.st/skills/ohmyhost-deploy-github/SKILL.md): inspect, link the exact pushed GitHub commit, review its plan, deploy Dev, verify its protected URL, then promote the same artifact. A successful build or root HTTP response alone is not application verification.

## Verification

```sh
npm run typecheck
npm test
npm run build
ohmyhost init --dry-run --json
```

Tests cover authentication, origin checks, upload limits and idempotency, viewer permissions, byte ranges, real Postgres job claims/fencing, provider failures, uncertainty and cleanup. `/tests/recorder.html` is a local-only browser fixture using an animated canvas and real MediaRecorder encoding. It is excluded from production. A real operating-system screen picker and microphone permission remain under browser control.

Deployment IDs, live checks and sanitized diagnostic reports are retained in the ignored `.local/ohmyhost-diagnostics/` directory. Credentials, cookies, signed storage URLs and viewing tokens must not be copied into reports or commits.

# Little Loom

A small screen recorder: record a screen or window, preview it, save it, and share a UUID link. Anyone with the link can watch without an account. There is no public recording directory.

- Optional microphone and browser-supported screen audio.
- Pause, resume, stop, preview, and download locally.
- Upload progress and retries that keep the recorded video in the tab.
- Public `/v/<uuid>` player and streaming video with byte-range support.
- Separate private upload tokens: knowing a viewing UUID does not authorize completing or replacing an upload.
- Up to 15 minutes or 50 MiB per recording, whichever comes first. Browser capture support varies; use a desktop browser over HTTPS or localhost.

## Develop

Use Node.js 22 or later and npm 10.9.8.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. Development uses `.local/storage` on disk, so saved links continue working after reloading or restarting the server. This adapter is only part of the local Vite server; production never falls back to a developer's disk or process memory.

```sh
npm run typecheck
npm test
npm run build
ohmyhost init --dry-run --json
```

`npm run preview` previews the static build only. Use `npm run dev` to exercise the local API and storage together.

## Browser verification

`/tests/recorder.html` is a development-only fixture. It substitutes an animated canvas for the operating system screen picker while retaining real MediaRecorder encoding, the full UI, upload APIs, disk storage, and playback. Turn off the microphone when using the fixture to avoid recording ambient sound. The fixture is not included in the production build.

For a real capture check, open `/`, start a recording, choose a window, pause and resume, then stop from the browser's sharing control. Save, open the UUID link in another tab, reload it, and test playback and seeking. Screen and microphone permissions always remain under browser control.

## Hosting on ohmyho.st

The repository uses the supported Vite companion at `src/ohmyhost/companion.ts` and the private storage SDK from `@ohmyhost/customer-runtime/storage`. `ohmyhost.yaml` enables only edge hosting and private file storage in the supported US jurisdiction. Database, application authentication, and mail are disabled.

Hosting setup and promotion follow the official [setup](https://ohmyho.st/skills/ohmyhost-get-started/SKILL.md) and [GitHub deployment](https://ohmyho.st/skills/ohmyhost-deploy-github/SKILL.md) instructions. Authenticate with `ohmyhost login --json`, reuse the selected organization/project, authorize this GitHub repository, and plan the exact pushed commit. Verify the protected Dev application before promoting that artifact to the public production URL.

### Current storage integration constraint

The beta.40 inspection contract reports a `FILES` binding. Its public runtime documentation requires `createPrivateStorageClient`, whose constructor needs a gateway connection and project/environment identifiers, but does not document how to obtain that connection from the deployment bindings. Production storage must be verified against the actual supported runtime contract before publication. The application fails closed when no supported storage client has been connected; it never guesses a gateway credential or uses a platform management token in application code.

Recordings are unlisted, not confidential: sharing a UUID grants viewing access. The public recorder accepts uploads without an account, subject to application limits and the hosting project's storage quota. No authentication provider, database, mail, custom domain, or automatic deployment is required.

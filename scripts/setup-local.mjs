import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
// `npm run setup` writes .env.local for `npm run dev`; `npm run cf:setup` writes .dev.vars for `wrangler dev`.
const path = process.argv[2] ?? '.env.local';
const cloudflare = path === '.dev.vars';
let source = existsSync(path) ? readFileSync(path, 'utf8') : '';
const defaults = {
  SLOP_ROOSTER_ACCESS_UUID: randomUUID(),
  APP_SESSION_SECRET: randomBytes(48).toString('base64url'),
  SHARE_TOKEN_SECRET: randomBytes(48).toString('base64url'),
  GEMINI_API_KEY: '',
  // On Cloudflare, GEMINI_MODEL is a plain variable in wrangler.jsonc.
  ...(cloudflare ? {} : { GEMINI_MODEL: 'gemini-3.8-flash' }),
};
for (const [name, value] of Object.entries(defaults)) {
  const pattern = new RegExp(`^${name}=(.*)$`, 'm');
  const existing = source.match(pattern);
  if (existing?.[1]?.trim()) continue;
  if (existing) source = source.replace(pattern, `${name}=${value}`);
  else source += `${source && !source.endsWith('\n') ? '\n' : ''}${name}=${value}\n`;
}
writeFileSync(path, source, { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`Local settings are ready in ${path}. Use its access UUID to sign in; add a Gemini API key to enable Markdown. Existing values were preserved.`);

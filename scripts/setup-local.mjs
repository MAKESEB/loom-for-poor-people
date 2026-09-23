import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
const path = '.env.local';
let source = existsSync(path) ? readFileSync(path, 'utf8') : '';
const defaults = {
  SLOP_ROOSTER_ACCESS_UUID: randomUUID(),
  APP_SESSION_SECRET: randomBytes(48).toString('base64url'),
  SHARE_TOKEN_SECRET: randomBytes(48).toString('base64url'),
  GEMINI_API_KEY: '',
  GEMINI_MODEL: 'gemini-3.8-flash',
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
console.log('Local settings are ready in .env.local. Use its access UUID to sign in; add a Gemini API key to enable Markdown. Existing values were preserved.');

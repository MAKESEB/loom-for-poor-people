const SESSION_SECONDS = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();

export interface AuthConfig { accessUuid: string; sessionSecret: string; shareSecret: string }

export class AuthUnavailableError extends Error {
  constructor() { super('Application access is not configured.'); }
}

export function resolveAuthConfig(environment: Record<string, unknown>): AuthConfig {
  const accessUuid = environment.SLOP_ROOSTER_ACCESS_UUID;
  const sessionSecret = environment.APP_SESSION_SECRET;
  const shareSecret = environment.SHARE_TOKEN_SECRET;
  if (typeof accessUuid !== 'string' || !accessUuid || typeof sessionSecret !== 'string' || sessionSecret.length < 32 || typeof shareSecret !== 'string' || shareSecret.length < 32) {
    throw new AuthUnavailableError();
  }
  return { accessUuid, sessionSecret, shareSecret };
}

function isSecure(request: Request) { return new URL(request.url).protocol === 'https:'; }
function cookieName(request: Request) { return isSecure(request) ? '__Host-slop_rooster_session' : 'slop_rooster_session'; }
function encode(bytes: ArrayBuffer) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function decode(value: string): Uint8Array<ArrayBuffer> {
  const text = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(text, c => c.charCodeAt(0));
}
async function key(secret: string) { return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function signature(secret: string, text: string) { return encode(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(text))); }
async function verify(secret: string, text: string, proof: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
  try { return await crypto.subtle.verify('HMAC', await key(secret), decode(proof), encoder.encode(text)); } catch { return false; }
}

export async function validAccessCode(config: AuthConfig, value: unknown) {
  if (typeof value !== 'string' || value.length > 128) return false;
  const proof = await signature(config.sessionSecret, config.accessUuid);
  return verify(config.sessionSecret, value.trim(), proof);
}

export async function createSessionCookie(request: Request, config: AuthConfig, now = new Date()) {
  const expiry = Math.floor(now.getTime() / 1000) + SESSION_SECONDS;
  const payload = `v1:${new URL(request.url).origin}:${config.accessUuid}:${expiry}`;
  const token = `v1.${expiry}.${await signature(config.sessionSecret, payload)}`;
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${isSecure(request) ? '; Secure' : ''}`;
}

export function clearSessionCookie(request: Request) {
  return `${cookieName(request)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure(request) ? '; Secure' : ''}`;
}

export async function hasSession(request: Request, config: AuthConfig, now = new Date()) {
  const cookies = request.headers.get('cookie') ?? '';
  if (cookies.length > 16_384) return false;
  const value = cookies.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName(request)}=`))?.slice(cookieName(request).length + 1);
  const match = /^v1\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(value ?? '');
  if (!match) return false;
  const expiry = Number(match[1]);
  const current = Math.floor(now.getTime() / 1000);
  if (expiry <= current || expiry > current + SESSION_SECONDS + 60) return false;
  return verify(config.sessionSecret, `v1:${new URL(request.url).origin}:${config.accessUuid}:${expiry}`, match[2]);
}

export function viewerToken(config: AuthConfig, recordingId: string) { return signature(config.shareSecret, `slop-rooster:view:v1:${recordingId}`); }
export function validViewerToken(config: AuthConfig, recordingId: string, token: string | null) {
  return token ? verify(config.shareSecret, `slop-rooster:view:v1:${recordingId}`, token) : Promise.resolve(false);
}

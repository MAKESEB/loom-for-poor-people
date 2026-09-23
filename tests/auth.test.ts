import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AuthUnavailableError, clearSessionCookie, createSessionCookie, hasSession,
  resolveAuthConfig, validAccessCode, validViewerToken, viewerToken, type AuthConfig,
} from '../src/server/auth';

const ORIGIN = 'https://slop-rooster.example';
const NOW = new Date('2026-09-23T12:00:00.000Z');
const MONTH_SECONDS = 30 * 24 * 60 * 60;
const CONFIG: AuthConfig = {
  accessUuid: 'b24b0818-296f-4408-9168-0c78b626d817',
  sessionSecret: 'test-session-secret-with-at-least-32-characters',
  shareSecret: 'test-sharing-secret-with-at-least-32-characters',
};

function request(cookie?: string, origin = ORIGIN) {
  return new Request(`${origin}/api/session`, { headers: cookie ? { cookie: cookie.split(';')[0] } : {} });
}

test('access code validation and configuration fail closed without exposing configured secrets', async () => {
  assert.deepEqual(resolveAuthConfig({
    SLOP_ROOSTER_ACCESS_UUID: CONFIG.accessUuid,
    APP_SESSION_SECRET: CONFIG.sessionSecret,
    SHARE_TOKEN_SECRET: CONFIG.shareSecret,
  }), CONFIG);
  for (const environment of [
    {},
    { SLOP_ROOSTER_ACCESS_UUID: CONFIG.accessUuid },
    { SLOP_ROOSTER_ACCESS_UUID: CONFIG.accessUuid, APP_SESSION_SECRET: 'short', SHARE_TOKEN_SECRET: CONFIG.shareSecret },
    { SLOP_ROOSTER_ACCESS_UUID: CONFIG.accessUuid, APP_SESSION_SECRET: CONFIG.sessionSecret, SHARE_TOKEN_SECRET: 'short' },
  ]) {
    assert.throws(() => resolveAuthConfig(environment), AuthUnavailableError);
  }
  assert.equal(await validAccessCode(CONFIG, CONFIG.accessUuid), true);
  assert.equal(await validAccessCode(CONFIG, ` ${CONFIG.accessUuid}\n`), true);
  for (const input of [null, undefined, {}, '', 'wrong-access-code', 'x'.repeat(129)]) {
    assert.equal(await validAccessCode(CONFIG, input), false);
  }
});

test('production sessions use signed host cookies and expire after exactly 30 days', async () => {
  const cookie = await createSessionCookie(request(), CONFIG, NOW);
  assert.match(cookie, /^__Host-slop_rooster_session=v1\.\d{10}\.[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, new RegExp(`; Max-Age=${MONTH_SECONDS}(?:;|$)`));
  assert(!cookie.includes('Domain='), '__Host cookies must not be available to sibling hosts');
  assert(!cookie.includes(CONFIG.accessUuid));
  assert(!cookie.includes(CONFIG.sessionSecret));
  assert.equal(await hasSession(request(cookie), CONFIG, NOW), true);
  assert.equal(await hasSession(request(cookie), CONFIG, new Date(NOW.getTime() + MONTH_SECONDS * 1000 - 1)), true);
  assert.equal(await hasSession(request(cookie), CONFIG, new Date(NOW.getTime() + MONTH_SECONDS * 1000)), false);
  assert.equal(await hasSession(request(cookie), CONFIG, new Date(NOW.getTime() + (MONTH_SECONDS + 1) * 1000)), false);
});

test('session signatures bind the origin, access UUID, secret and expiry', async () => {
  const cookie = await createSessionCookie(request(), CONFIG, NOW);
  for (const origin of ['https://other.example', 'https://child.slop-rooster.example', `${ORIGIN}:8443`, 'http://slop-rooster.example']) {
    assert.equal(await hasSession(request(cookie, origin), CONFIG, NOW), false, origin);
  }
  assert.equal(await hasSession(request(cookie), { ...CONFIG, accessUuid: '83f7c025-bd21-4b98-a0e9-7e18a379f5fa' }, NOW), false);
  assert.equal(await hasSession(request(cookie), { ...CONFIG, sessionSecret: `${CONFIG.sessionSecret}-rotated` }, NOW), false);
  const changedExpiry = cookie.replace(/v1\.(\d{10})\./, (_, value: string) => `v1.${Number(value) + 1}.`);
  assert.equal(await hasSession(request(changedExpiry), CONFIG, NOW), false);
  const value = cookie.split(';')[0];
  const prefix = value.slice(0, -1);
  const changedProof = `${prefix}${value.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(await hasSession(request(changedProof), CONFIG, NOW), false);
  assert.equal(await hasSession(request(cookie), CONFIG, new Date(NOW.getTime() - 61_000)), false, 'future-issued sessions must not bypass the maximum lifetime');
});

test('missing, malformed, oversized and cleared sessions cannot authenticate', async () => {
  for (const cookie of [undefined, '', '__Host-slop_rooster_session=', '__Host-slop_rooster_session=v1.123.invalid', '__Host-slop_rooster_session=' + 'a'.repeat(16_385)]) {
    assert.equal(await hasSession(request(cookie), CONFIG, NOW), false);
  }
  const cleared = clearSessionCookie(request());
  assert.match(cleared, /^__Host-slop_rooster_session=;/);
  assert.match(cleared, /; Max-Age=0/);
  assert.match(cleared, /; HttpOnly/);
  assert.match(cleared, /; Secure/);
  assert.equal(await hasSession(request(cleared), CONFIG, NOW), false);
});

test('local HTTP uses a separate session cookie without weakening the hosted cookie', async () => {
  const localOrigin = 'http://127.0.0.1:5173';
  const cookie = await createSessionCookie(request(undefined, localOrigin), CONFIG, NOW);
  assert.match(cookie, /^slop_rooster_session=/);
  assert(!cookie.includes('; Secure'));
  assert.equal(await hasSession(request(cookie, localOrigin), CONFIG, NOW), true);
  assert.equal(await hasSession(request(cookie, 'http://127.0.0.1:5174'), CONFIG, NOW), false);
  assert.equal(await hasSession(request(cookie), CONFIG, NOW), false);
});

test('viewer links are permanent per-recording capabilities independent of creator sessions', async () => {
  const firstId = '084951a0-a78b-468c-99c4-c613a2a3284a';
  const secondId = 'fe788cc6-23e7-40f7-a273-fcaaf2c616b8';
  const token = await viewerToken(CONFIG, firstId);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await viewerToken(CONFIG, firstId), token, 'reloading reconstructs the same non-expiring token');
  assert.notEqual(await viewerToken(CONFIG, secondId), token);
  assert.equal(await validViewerToken(CONFIG, firstId, token), true);
  assert.equal(await validViewerToken(CONFIG, secondId, token), false);
  for (const invalid of [null, '', `${token}extra`, 'a'.repeat(43), token.slice(1)]) {
    assert.equal(await validViewerToken(CONFIG, firstId, invalid), false);
  }
  const rotatedLogin = { ...CONFIG, accessUuid: 'rotated-login', sessionSecret: `${CONFIG.sessionSecret}-rotated` };
  assert.equal(await viewerToken(rotatedLogin, firstId), token, 'creator credential rotation must retain published links');
  assert.equal(await validViewerToken(rotatedLogin, firstId, token), true);
  assert.equal(await validViewerToken({ ...CONFIG, shareSecret: `${CONFIG.shareSecret}-rotated` }, firstId, token), false);
  assert.equal(await hasSession(request(`__Host-slop_rooster_session=${token}`), CONFIG, NOW), false, 'read capabilities never authenticate a creator');
  const cookie = await createSessionCookie(request(), CONFIG, NOW);
  assert.equal(await validViewerToken(CONFIG, firstId, cookie.split(';')[0].split('=')[1]), false);
});

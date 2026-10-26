/* Admin authentication: peppered PBKDF2 passwords, server-side sessions, lockout, TOTP 2FA, first-run setup. */
import { HttpError, safeEqual } from "./orders.js";

const enc = new TextEncoder();
export const PBKDF2_ITERATIONS = 100000;      // Cloudflare's WebCrypto ceiling; the pepper (secret key) protects leaked hashes further
const SESSION_IDLE_MIN = 30;                   // signed out after 30 minutes without activity
const SESSION_ABSOLUTE_H = 12;                 // and after 12 hours in any case
const MFA_PENDING_MIN = 5;                     // time to enter the authenticator code
const LOCK_AFTER = 5, LOCK_MIN = 15;           // 5 wrong attempts → locked for 15 minutes
export const COOKIE = "__Host-cg_sess";

/* ---------- small crypto helpers ---------- */
export const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export async function sha256b64(text) { return b64url(await crypto.subtle.digest("SHA-256", enc.encode(text))); }
async function hmacRaw(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, typeof data === "string" ? enc.encode(data) : data));
}
const pepper = env => {
  if (!env.PASSWORD_PEPPER || env.PASSWORD_PEPPER.length < 32) throw new HttpError(503, { error: "auth_not_configured" });
  return enc.encode(env.PASSWORD_PEPPER);
};

/* ---------- passwords: pbkdf2-sha256$iterations$salt$hash, keyed with a secret pepper ---------- */
async function derive(env, password, salt, iterations) {
  const peppered = await hmacRaw(pepper(env), "pw:" + password);           // without the server secret, a leaked hash cannot be attacked offline
  const key = await crypto.subtle.importKey("raw", peppered, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}
export async function hashPassword(env, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(await derive(env, password, salt, PBKDF2_ITERATIONS))}`;
}
export async function verifyPassword(env, password, stored) {
  const [alg, it, salt, hash] = String(stored || "").split("$");
  if (alg !== "pbkdf2-sha256" || !salt || !hash) return false;
  return safeEqual(b64url(await derive(env, password, fromB64url(salt), Number(it))), hash);
}
const DUMMY_SALT = new Uint8Array(16);
// Same work for unknown usernames, so response time does not reveal which accounts exist.
async function dummyVerify(env, password) { await derive(env, password, DUMMY_SALT, PBKDF2_ITERATIONS); return false; }

const COMMON = ["password", "12345678", "123456789", "1234567890", "qwerty", "11111111", "00000000", "admin", "vitamik", "calmgastro", "password123", "admin123"];
export function passwordProblem(password, username) {
  const p = String(password || "");
  if (p.length < 12) return "too_short";
  if (p.length > 200) return "too_long";
  if (username && p.toLowerCase().includes(String(username).toLowerCase())) return "contains_username";
  if (COMMON.some(c => p.toLowerCase().includes(c)) || /^(.)\1+$/.test(p)) return "too_common";
  return null;
}
export const validUsername = u => /^[A-Za-z0-9._-]{3,32}$/.test(String(u || ""));

/* ---------- audit ---------- */
export function auditStmt(env, ctx, action, entityType = null, entityId = null, oldValue = null, newValue = null) {
  const j = v => v == null ? null : typeof v === "string" ? v : JSON.stringify(v);
  return env.DB.prepare(`INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind(ctx.user ? ctx.user.id : null, ctx.user ? ctx.user.username : (ctx.username || null), action, entityType, entityId == null ? null : String(entityId),
      j(oldValue), j(newValue), ctx.ip || null, (ctx.ua || "").slice(0, 300) || null, new Date().toISOString());
}
export const audit = (env, ctx, ...a) => auditStmt(env, ctx, ...a).run();

/* ---------- sessions ---------- */
const cookieHeader = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
export const clearCookie = () => cookieHeader("", 0);

async function createSession(env, ctx, userId, mfaPending) {
  const token = randomToken(32), now = Date.now();
  const expires = new Date(now + (mfaPending ? MFA_PENDING_MIN * 60e3 : SESSION_ABSOLUTE_H * 3600e3)).toISOString();
  await env.DB.prepare(`INSERT INTO sessions (id, user_id, mfa_pending, created_at, last_seen_at, expires_at, ip_address, user_agent)
    VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7)`).bind(await sha256b64(token), userId, mfaPending ? 1 : 0, new Date(now).toISOString(), expires, ctx.ip, (ctx.ua || "").slice(0, 300)).run();
  return cookieHeader(token, mfaPending ? MFA_PENDING_MIN * 60 : SESSION_ABSOLUTE_H * 3600);
}
const tokenFrom = request => { const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,})`)); return m ? m[1] : null; };

export async function revokeCurrent(request, env) {
  const t = tokenFrom(request);
  if (t) await env.DB.prepare("UPDATE sessions SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL").bind(new Date().toISOString(), await sha256b64(t)).run();
}
export const revokeAllStmt = (env, userId, exceptId = "") =>
  env.DB.prepare("UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL AND id != ?3").bind(new Date().toISOString(), userId, exceptId);

/* Returns { user, perms:Set, session } or null. */
export async function loadSession(request, env, { allowMfaPending = false } = {}) {
  const t = tokenFrom(request);
  if (!t) return null;
  const id = await sha256b64(t);
  const row = await env.DB.prepare(`SELECT s.id sid, s.mfa_pending, s.last_seen_at, s.expires_at, s.revoked_at,
      u.id, u.username, u.display_name, u.role_id, u.is_active, u.totp_enabled, u.must_change_password, r.name_ar role_name
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id WHERE s.id = ?1`).bind(id).first();
  const now = Date.now();
  if (!row || row.revoked_at || !row.is_active || Date.parse(row.expires_at) < now) return null;
  if (Date.parse(row.last_seen_at) + SESSION_IDLE_MIN * 60e3 < now) {                   // idle timeout
    await env.DB.prepare("UPDATE sessions SET revoked_at = ?1 WHERE id = ?2").bind(new Date().toISOString(), id).run();
    return null;
  }
  if (row.mfa_pending && !allowMfaPending) return null;
  if (now - Date.parse(row.last_seen_at) > 60e3)                                          // at most one write per minute
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2").bind(new Date(now).toISOString(), id).run();
  const perms = new Set((await env.DB.prepare("SELECT permission_key FROM role_permissions WHERE role_id = ?1").bind(row.role_id).all()).results.map(r => r.permission_key));
  return { session: { id, mfaPending: !!row.mfa_pending }, perms,
    user: { id: row.id, username: row.username, displayName: row.display_name, roleId: row.role_id, roleName: row.role_name,
            totpEnabled: !!row.totp_enabled, mustChangePassword: !!row.must_change_password } };
}

/* ---------- login with lockout ---------- */
const GENERIC = () => new HttpError(401, { error: "invalid_credentials" });      // same answer for every failure reason

export async function login(env, ctx, body) {
  const username = String(body && body.username || "").trim().slice(0, 64), password = String(body && body.password || "").slice(0, 200);
  const key = username.toLowerCase(), now = new Date();
  ctx.username = username.slice(0, 64);
  const throttle = await env.DB.prepare("SELECT failures, locked_until FROM login_throttle WHERE username_key = ?1").bind(key).first();
  const user = validUsername(username) ? await env.DB.prepare("SELECT * FROM users WHERE username = ?1").bind(username).first() : null;
  const locked = (throttle && throttle.locked_until && Date.parse(throttle.locked_until) > now) || (user && user.locked_until && Date.parse(user.locked_until) > now);
  const ok = user && !locked && user.is_active ? await verifyPassword(env, password, user.password_hash) : await dummyVerify(env, password);

  if (!ok && locked) {                                  // attempts during a lockout never shorten or reset it
    await audit(env, ctx, "login_blocked_locked", "user", user ? user.id : null, null, { username: ctx.username });
    throw GENERIC();
  }
  if (!ok) {
    const failures = (throttle && (!throttle.locked_until || Date.parse(throttle.locked_until) <= now) ? throttle.failures : 0) + 1;
    const lockUntil = failures >= LOCK_AFTER ? new Date(now.getTime() + LOCK_MIN * 60e3).toISOString() : null;
    const stmts = [
      env.DB.prepare(`INSERT INTO login_throttle (username_key, failures, locked_until, updated_at) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(username_key) DO UPDATE SET failures = ?2, locked_until = ?3, updated_at = ?4`).bind(key, failures, lockUntil, now.toISOString()),
      auditStmt(env, ctx, locked ? "login_blocked_locked" : "login_failed", "user", user ? user.id : null, null, { username: ctx.username, failures })
    ];
    if (user) stmts.push(env.DB.prepare("UPDATE users SET failed_login_attempts = ?1, locked_until = ?2 WHERE id = ?3").bind(failures, lockUntil, user.id));
    await env.DB.batch(stmts);
    throw GENERIC();
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM login_throttle WHERE username_key = ?1").bind(key),
    env.DB.prepare("UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?1").bind(user.id)
  ]);
  ctx.user = { id: user.id, username: user.username };
  if (user.totp_enabled) {
    await audit(env, ctx, "login_password_ok_mfa_required", "user", user.id);
    return { mfa: true, cookie: await createSession(env, ctx, user.id, true) };
  }
  await env.DB.batch([env.DB.prepare("UPDATE users SET last_login_at = ?1 WHERE id = ?2").bind(now.toISOString(), user.id), auditStmt(env, ctx, "login_success", "user", user.id)]);
  return { mfa: false, cookie: await createSession(env, ctx, user.id, false) };
}

/* ---------- TOTP (RFC 6238: SHA-1, 30 s, 6 digits) ---------- */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes) { let bits = 0, v = 0, out = ""; for (const b of bytes) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(v << (5 - bits)) & 31]; return out; }
function unbase32(s) { const out = []; let bits = 0, v = 0; for (const c of s.replace(/=+$/, "").toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(out); }
async function hotp(secretBytes, counter) {
  const msg = new Uint8Array(8); let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg)), o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0");
}
/* Returns the matching time step (to block reuse), or 0. */
export async function verifyTotp(secretB32, code, lastStep = 0, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ""))) return 0;
  const step = Math.floor(now / 30000), secret = unbase32(secretB32);
  for (const s of [step - 1, step, step + 1]) if (s > lastStep && safeEqual(await hotp(secret, s), String(code))) return s;
  return 0;
}
export { hotp as _hotp, unbase32 as _unbase32 };

// TOTP secrets are stored encrypted (AES-GCM, key derived from the pepper) because they must be readable to check codes.
async function totpKey(env) {
  const base = await crypto.subtle.importKey("raw", pepper(env), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("calmgastro-totp"), info: enc.encode("totp-secret") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function encryptSecret(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return `${b64url(iv)}.${b64url(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await totpKey(env), enc.encode(text)))}`;
}
export async function decryptSecret(env, stored) {
  const [iv, ct] = String(stored || "").split(".");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv) }, await totpKey(env), fromB64url(ct)));
}

export async function completeMfa(request, env, ctx, body) {
  const s = await loadSession(request, env, { allowMfaPending: true });
  if (!s || !s.session.mfaPending) throw new HttpError(401, { error: "unauthorized" });
  ctx.user = { id: s.user.id, username: s.user.username };
  const u = await env.DB.prepare("SELECT totp_secret_enc, totp_last_step FROM users WHERE id = ?1").bind(s.user.id).first();
  const step = u && u.totp_secret_enc ? await verifyTotp(await decryptSecret(env, u.totp_secret_enc), body && body.code, u.totp_last_step) : 0;
  if (!step) {
    // wrong codes also count towards the lockout
    const key = s.user.username.toLowerCase(), now = new Date();
    const row = await env.DB.prepare("SELECT failures FROM login_throttle WHERE username_key = ?1").bind(key).first();
    const failures = (row ? row.failures : 0) + 1, lockUntil = failures >= LOCK_AFTER ? new Date(now.getTime() + LOCK_MIN * 60e3).toISOString() : null;
    const stmts = [env.DB.prepare(`INSERT INTO login_throttle (username_key, failures, locked_until, updated_at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(username_key) DO UPDATE SET failures = ?2, locked_until = ?3, updated_at = ?4`).bind(key, failures, lockUntil, now.toISOString()),
      auditStmt(env, ctx, "login_mfa_failed", "user", s.user.id)];
    if (lockUntil) stmts.push(env.DB.prepare("UPDATE sessions SET revoked_at = ?1 WHERE id = ?2").bind(now.toISOString(), s.session.id),
                             env.DB.prepare("UPDATE users SET locked_until = ?1, failed_login_attempts = ?2 WHERE id = ?3").bind(lockUntil, failures, s.user.id));
    await env.DB.batch(stmts);
    throw GENERIC();
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET totp_last_step = ?1, last_login_at = ?2 WHERE id = ?3").bind(step, new Date().toISOString(), s.user.id),
    env.DB.prepare("UPDATE sessions SET revoked_at = ?1 WHERE id = ?2").bind(new Date().toISOString(), s.session.id),   // regenerate: the pre-2FA session ends
    env.DB.prepare("DELETE FROM login_throttle WHERE username_key = ?1").bind(s.user.username.toLowerCase()),
    auditStmt(env, ctx, "login_success", "user", s.user.id, null, { mfa: true })
  ]);
  return createSession(env, ctx, s.user.id, false);
}

/* ---------- first run: create the Super Admin, proven with the existing ADMIN_PASSWORD secret ---------- */
export async function setupNeeded(env) { return !(await env.DB.prepare("SELECT 1 FROM users LIMIT 1").first()); }
export async function setup(env, ctx, body) {
  if (!(await setupNeeded(env))) throw new HttpError(409, { error: "setup_done" });
  if (!env.ADMIN_PASSWORD || !safeEqual(await sha256b64("s:" + String(body && body.setupKey || "")), await sha256b64("s:" + env.ADMIN_PASSWORD)))
    throw new HttpError(401, { error: "invalid_setup_key" });
  const username = String(body.username || "").trim(), password = String(body.password || "");
  if (!validUsername(username)) throw new HttpError(422, { error: "invalid_username" });
  const problem = passwordProblem(password, username);
  if (problem) throw new HttpError(422, { error: "weak_password", reason: problem });
  const now = new Date().toISOString();
  const r = await env.DB.prepare(`INSERT INTO users (username, display_name, password_hash, role_id, password_changed_at, created_at, updated_at)
    SELECT ?1, ?2, ?3, 'super_admin', ?4, ?4, ?4 WHERE NOT EXISTS (SELECT 1 FROM users)`)
    .bind(username, String(body.displayName || username).trim().slice(0, 60), await hashPassword(env, password), now).run();
  if (!r.meta.changes) throw new HttpError(409, { error: "setup_done" });
  ctx.user = { id: null, username };
  await audit(env, ctx, "setup_completed", "user", username, null, { role: "super_admin" });
}

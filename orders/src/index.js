/* CalmGastro orders API + admin (Cloudflare Worker + D1). Full reference: ../README.md
   Public (vitamik.com only, CORS):
     POST /api/orders          create an order (idempotent)             → { order, token }
     POST /api/orders/view     { orderNumber, token }  secure link        → { order }
     POST /api/orders/track    { orderNumber, phone }  number + mobile    → { order }
   Admin (same origin, session cookie, permissions checked per action): /admin/* pages, /admin/api/* JSON */
import { createOrder, loadOrder, customerView, orderToken, normalizeOrderNumber, normalizePhone, safeEqual, HttpError } from "./orders.js";
import { login, completeMfa, loadSession, revokeCurrent, clearCookie, setup, setupNeeded, audit } from "./auth.js";
import * as A from "./admin.js";

const MAX_BODY = 16 * 1024;
// browser family only, for diagnosing "works on X, fails on Y" reports
const uaFamily = ua => { ua = String(ua || ""); return /iPhone|iPad/.test(ua) ? (/CriOS/.test(ua) ? "iOS-Chrome" : /FxiOS/.test(ua) ? "iOS-Firefox" : /Instagram|FBAN|FBAV|Snapchat|TikTok/.test(ua) ? "iOS-InApp" : "iOS-Safari")
  : /Android/.test(ua) ? (/SamsungBrowser/.test(ua) ? "Android-Samsung" : /Instagram|FBAN|FBAV|Snapchat|TikTok|; wv\)/.test(ua) ? "Android-InApp" : "Android-Chrome") : "Desktop"; };
const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" };
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...BASE_HEADERS, ...extra } });

function corsHeaders(env, origin) {
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!origin || !list.includes(origin)) return null;
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
           "Access-Control-Max-Age": "86400", "Vary": "Origin" };
}

/* Cloudflare rate-limit bindings; a small per-isolate counter if a binding is missing. */
const HITS = new Map();
async function allowed(env, binding, key, fallbackPerMinute, url) {
  if (env.RL_DISABLED === "1" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return true;   // local tests only
  const rl = env[binding];
  if (rl) { try { return (await rl.limit({ key })).success; } catch (_) {} }
  const k = binding + ":" + key, now = Date.now(), list = (HITS.get(k) || []).filter(t => now - t < 60000);
  list.push(now); HITS.set(k, list);
  if (HITS.size > 5000) HITS.clear();
  return list.length <= fallbackPerMinute;
}

async function readJson(request) {
  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY) throw new HttpError(413, { error: "too_large" });
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, { error: "too_large" });
  if (!raw) return {};
  try { const v = JSON.parse(raw); if (v && typeof v === "object") return v; } catch (_) {}
  throw new HttpError(400, { error: "bad_json" });
}

async function viewResponse(env, number, extra = {}) {
  const full = await loadOrder(env.DB, number);
  if (!full) throw new HttpError(404, { error: "not_found" });
  return { order: customerView(full), ...extra };
}

/* ---------------------------------------------------------------- public API */
async function publicApi(request, env, url, cors) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const body = await readJson(request);

  if (url.pathname === "/api/orders") {
    if (body.hp) throw new HttpError(422, { error: "validation", fields: {} });     // honeypot field filled by a bot
    if (!(await allowed(env, "ORDER_LIMITER", ip, 10, url))) throw new HttpError(429, { error: "rate_limited" });
    const { replay, number } = await createOrder(env, body);
    return json(await viewResponse(env, number, { token: await orderToken(env, number), replay }), replay ? 200 : 201, cors);
  }

  if (!(await allowed(env, "LOOKUP_LIMITER", ip, 30, url))) throw new HttpError(429, { error: "rate_limited" });
  const number = normalizeOrderNumber(body.orderNumber);
  // Same answer for "no such order", "wrong token" and "wrong phone", so order numbers cannot be probed.
  const row = number && await env.DB.prepare("SELECT customer_phone, token_version, anonymized_at FROM orders WHERE order_number = ?1").bind(number).first();

  if (url.pathname === "/api/orders/view") {
    if (!row || !safeEqual(String(body.token || ""), await orderToken(env, number, row.token_version))) throw new HttpError(404, { error: "not_found" });
    return json(await viewResponse(env, number), 200, cors);
  }
  if (url.pathname === "/api/orders/track") {
    const phone = normalizePhone(body.phone);
    if (!row || !phone || row.anonymized_at || !safeEqual(row.customer_phone, phone)) throw new HttpError(404, { error: "not_found" });
    return json(await viewResponse(env, number), 200, cors);
  }
  throw new HttpError(404, { error: "not_found" });
}

/* ---------------------------------------------------------------- admin pages + API */
const ADMIN_HEADERS = {
  ...BASE_HEADERS,
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY", "Cross-Origin-Opener-Policy": "same-origin", "Strict-Transport-Security": "max-age=31536000"
};
async function asset(env, url, path) {
  if (!env.ASSETS) return new Response("admin assets missing", { status: 500 });
  const r = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(ADMIN_HEADERS)) h.set(k, v);
  return new Response(r.body, { status: r.status, headers: h });
}

// Allowed while a temporary password must be replaced.
const PASSWORD_CHANGE_ONLY = new Set(["GET /me", "POST /me/password", "POST /logout"]);

async function adminApi(request, env, url) {
  const path = url.pathname.slice("/admin/api".length), method = request.method, key = `${method} ${path}`;
  const ctx = { ip: request.headers.get("CF-Connecting-IP") || "local", ua: request.headers.get("User-Agent") || "" };
  if (method === "POST") {
    // CSRF: state-changing calls must come from the admin page itself (custom header + same origin; cookie is SameSite=Strict)
    const origin = request.headers.get("Origin");
    if (request.headers.get("X-CG-Admin") !== "1" || (origin && origin !== url.origin)) throw new HttpError(403, { error: "forbidden" });
  }
  if (key === "GET /setup") return json({ needed: await setupNeeded(env) });
  if (key === "POST /setup") {
    if (!(await allowed(env, "LOGIN_LIMITER", ctx.ip, 5, url))) throw new HttpError(429, { error: "rate_limited" });
    await setup(env, ctx, await readJson(request));
    return json({ ok: true });
  }
  if (key === "POST /login") {
    if (!(await allowed(env, "LOGIN_LIMITER", ctx.ip, 5, url))) throw new HttpError(429, { error: "rate_limited" });
    await revokeCurrent(request, env);                                    // a new session is issued on every login
    const r = await login(env, ctx, await readJson(request));
    return json({ ok: true, mfa: r.mfa }, 200, { "Set-Cookie": r.cookie });
  }
  if (key === "POST /login/2fa") {
    if (!(await allowed(env, "LOGIN_LIMITER", ctx.ip, 5, url))) throw new HttpError(429, { error: "rate_limited" });
    return json({ ok: true }, 200, { "Set-Cookie": await completeMfa(request, env, ctx, await readJson(request)) });
  }
  if (key === "POST /logout") {
    const s = await loadSession(request, env, { allowMfaPending: true });
    await revokeCurrent(request, env);
    if (s) { Object.assign(ctx, s); await audit(env, ctx, "logout", "user", s.user.username); }
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }

  const s = await loadSession(request, env);
  if (!s) throw new HttpError(401, { error: "unauthorized" });
  Object.assign(ctx, s);
  if (s.user.mustChangePassword && !PASSWORD_CHANGE_ONLY.has(key)) throw new HttpError(403, { error: "password_change_required" });

  const body = method === "POST" ? await readJson(request) : null, p = url.searchParams;
  switch (key) {
    case "GET /me": return json(A.me(ctx));
    case "POST /me/password": return json(await A.changeOwnPassword(env, ctx, body));
    case "POST /me/2fa/start": return json(await A.startTwoFactor(env, ctx));
    case "POST /me/2fa/enable": return json(await A.enableTwoFactor(env, ctx, body));
    case "POST /me/2fa/disable": return json(await A.disableTwoFactor(env, ctx, body));
    case "GET /dashboard": return json(await A.dashboard(env, ctx));
    case "GET /reports": return json(await A.reports(env, ctx, p));
    case "GET /orders": return json(await A.listOrders(env, ctx, p));
    case "GET /orders/matching": return json(await A.matchingNumbers(env, ctx, p));
    case "GET /orders/export.csv":
      return new Response(await A.exportCsv(env, ctx, p), { headers: { ...BASE_HEADERS, "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"` } });
    case "POST /orders/bulk-status": return json(await A.bulkStatus(env, ctx, body));
    case "GET /customers": return json(await A.customers(env, ctx, p));
    case "GET /products": return json(await A.products(env, ctx));
    case "GET /audit": return json(await A.auditLog(env, ctx, p));
    case "GET /users": return json(await A.listUsers(env, ctx));
    case "POST /users": return json(await A.createUser(env, ctx, body));
    case "GET /backup":
      return new Response(JSON.stringify(await A.backup(env, ctx)), { headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="calmgastro-backup-${new Date().toISOString().slice(0, 10)}.json"` } });
  }
  let m = path.match(/^\/users\/(\d{1,9})$/);
  if (m && method === "POST") return json(await A.updateUser(env, ctx, m[1], body));
  m = path.match(/^\/orders\/([A-Za-z0-9-]{6,24})(?:\/(status|customer|items|notes|archive|revoke-link|anonymize))?$/);
  if (m && method === "GET" && !m[2]) return json(await A.orderDetail(env, ctx, m[1]));
  if (m && method === "POST") {
    const h = { status: A.changeStatus, customer: A.editCustomer, items: A.editItems, notes: A.addNote, archive: A.setArchived, "revoke-link": A.revokeLink, anonymize: A.anonymize }[m[2]];
    if (h) return json(await h(env, ctx, m[1], body));
  }
  throw new HttpError(404, { error: "not_found" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request.headers.get("Origin"));
    try {
      if (url.pathname === "/health") return json({ ok: true, db: !!env.DB });
      if (url.pathname.startsWith("/admin/api/")) return await adminApi(request, env, url);
      if (url.pathname.startsWith("/admin/assets/") && request.method === "GET") return await asset(env, url, url.pathname);
      // every admin page (/admin, /admin/login, /admin/orders/CG-…) is the same app shell; the data behind it needs a session
      if ((url.pathname === "/admin" || url.pathname.startsWith("/admin/")) && request.method === "GET") return await asset(env, url, "/admin/index.html");

      if (url.pathname.startsWith("/api/orders")) {
        if (request.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: { ...BASE_HEADERS, ...(cors || {}) } });
        if (!cors) return json({ error: "forbidden_origin" }, 403);
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);
        return await publicApi(request, env, url, cors);
      }
      return json({ error: "not_found" }, 404);
    } catch (e) {
      if (e instanceof HttpError) {
        if (url.pathname === "/api/orders") console.log(JSON.stringify({ ev: "order_rejected", status: e.status, error: e.body.error,
          fields: e.body.fields ? Object.keys(e.body.fields) : undefined, ua: uaFamily(request.headers.get("User-Agent")) }));
        return json(e.body, e.status, url.pathname.startsWith("/api/") ? (cors || {}) : {});
      }
      console.log("unhandled:", e && e.stack || e);
      return json({ error: "server_error" }, 500, url.pathname.startsWith("/api/") ? (cors || {}) : {});
    }
  }
};

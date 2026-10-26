/* CalmGastro orders API + admin panel (Cloudflare Worker + D1).
   Public (called from vitamik.com, CORS-restricted):
     POST /api/orders          create an order (idempotent)          → { order, token }
     POST /api/orders/view     { orderNumber, token }                 → { order }  (confirmation page)
     POST /api/orders/track    { orderNumber, phone }                 → { order }  (tracking, no address)
   Admin (same origin, session cookie):
     GET  /admin                                    panel
     POST /admin/api/login | /admin/api/logout     GET /admin/api/session
     GET  /admin/api/orders?q=&status=&from=&to=&page=
     GET  /admin/api/orders/{orderNumber}
     POST /admin/api/orders/{orderNumber}/status   { status, note, expectedStatus }
     POST /admin/api/orders/{orderNumber}/notes    { note } */
import { createOrder, loadOrder, customerView, orderToken, normalizeOrderNumber, normalizePhone, safeEqual, HttpError } from "./orders.js";
import { isAdmin, login, logoutCookie, listOrders, orderDetail, changeStatus, addNote } from "./admin.js";
import { ADMIN_HTML, ADMIN_CSS, ADMIN_JS } from "./admin-ui.js";

const MAX_BODY = 16 * 1024;
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
  try { const v = JSON.parse(raw); if (v && typeof v === "object") return v; } catch (_) {}
  throw new HttpError(400, { error: "bad_json" });
}

async function viewResponse(env, number, withAddress, extra = {}) {
  const full = await loadOrder(env.DB, number);
  if (!full) throw new HttpError(404, { error: "not_found" });
  return { order: customerView(full, { withAddress }), ...extra };
}

async function publicApi(request, env, url, cors) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const body = await readJson(request);

  if (url.pathname === "/api/orders") {
    if (body.hp) throw new HttpError(422, { error: "validation", fields: {} });     // honeypot field filled by a bot
    if (!(await allowed(env, "ORDER_LIMITER", ip, 5, url))) throw new HttpError(429, { error: "rate_limited" });
    const { replay, number } = await createOrder(env, body);
    return json(await viewResponse(env, number, true, { token: await orderToken(env, number), replay }), replay ? 200 : 201, cors);
  }

  if (!(await allowed(env, "LOOKUP_LIMITER", ip, 15, url))) throw new HttpError(429, { error: "rate_limited" });
  const number = normalizeOrderNumber(body.orderNumber);

  if (url.pathname === "/api/orders/view") {
    // Same answer for "no such order" and "wrong token", so numbers cannot be probed.
    if (!number || !safeEqual(String(body.token || ""), await orderToken(env, number))) throw new HttpError(404, { error: "not_found" });
    return json(await viewResponse(env, number, true), 200, cors);
  }
  if (url.pathname === "/api/orders/track") {
    const phone = normalizePhone(body.phone);
    const row = number && phone && await env.DB.prepare("SELECT customer_phone FROM orders WHERE order_number = ?1").bind(number).first();
    if (!row || !safeEqual(row.customer_phone, phone)) throw new HttpError(404, { error: "not_found" });
    return json(await viewResponse(env, number, false), 200, cors);
  }
  throw new HttpError(404, { error: "not_found" });
}

const ADMIN_PAGE_HEADERS = {
  ...BASE_HEADERS,
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY", "Cross-Origin-Opener-Policy": "same-origin"
};

async function adminApi(request, env, url) {
  const path = url.pathname.slice("/admin/api".length);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  if (request.method === "POST") {
    // CSRF: state-changing calls must come from this page itself (custom header + same origin)
    const origin = request.headers.get("Origin");
    if (request.headers.get("X-CG-Admin") !== "1" || (origin && origin !== url.origin)) throw new HttpError(403, { error: "forbidden" });
  }
  if (path === "/login" && request.method === "POST") {
    if (!(await allowed(env, "LOGIN_LIMITER", ip, 5, url))) throw new HttpError(429, { error: "rate_limited" });
    const set = await login(env, await readJson(request));
    return json({ ok: true }, 200, { "Set-Cookie": set });
  }
  if (path === "/logout" && request.method === "POST") return json({ ok: true }, 200, { "Set-Cookie": logoutCookie() });
  if (!(await isAdmin(request, env))) throw new HttpError(401, { error: "unauthorized" });
  if (path === "/session" && request.method === "GET") return json({ ok: true });
  if (path === "/orders" && request.method === "GET") return json(await listOrders(env, url.searchParams));
  const m = path.match(/^\/orders\/([A-Za-z0-9-]{6,24})(\/status|\/notes)?$/);
  if (m && request.method === "GET" && !m[2]) return json(await orderDetail(env, m[1]));
  if (m && request.method === "POST" && m[2] === "/status") return json(await changeStatus(env, m[1], await readJson(request)));
  if (m && request.method === "POST" && m[2] === "/notes") return json(await addNote(env, m[1], await readJson(request)));
  throw new HttpError(404, { error: "not_found" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request.headers.get("Origin"));
    try {
      if (url.pathname === "/health") return json({ ok: true, db: !!env.DB });

      if (url.pathname === "/admin" || url.pathname === "/admin/")
        return new Response(ADMIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", ...ADMIN_PAGE_HEADERS } });
      if (url.pathname === "/admin/app.js") return new Response(ADMIN_JS, { headers: { "Content-Type": "text/javascript; charset=utf-8", ...ADMIN_PAGE_HEADERS } });
      if (url.pathname === "/admin/app.css") return new Response(ADMIN_CSS, { headers: { "Content-Type": "text/css; charset=utf-8", ...ADMIN_PAGE_HEADERS } });
      if (url.pathname.startsWith("/admin/api/")) return await adminApi(request, env, url);

      if (url.pathname.startsWith("/api/orders")) {
        if (request.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: { ...BASE_HEADERS, ...(cors || {}) } });
        if (!cors) return json({ error: "forbidden_origin" }, 403);
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);
        return await publicApi(request, env, url, cors);
      }
      return json({ error: "not_found" }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json(e.body, e.status, url.pathname.startsWith("/api/") ? (cors || {}) : {});
      console.log("unhandled:", e && e.stack || e);
      return json({ error: "server_error" }, 500, url.pathname.startsWith("/api/") ? (cors || {}) : {});
    }
  }
};

/* إدارة CalmGastro: واجهة صفحة واحدة. كل البيانات تُعرض بـ textContent فقط، وكل صلاحية تُفحص في الخادم أيضاً. */
(function () {
"use strict";

/* ============================================================ أدوات */
const $ = (s, el = document) => el.querySelector(s);
const root = $("#root");
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "text") el.textContent = v;
    else if (k === "class") el.className = v;
    else if (k === "svg") el.innerHTML = v;                    // أيقونات ثابتة من هذا الملف فقط
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "selected" || k === "disabled") el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const put = (el, ...kids) => { el.append(...kids.flat(Infinity).filter(k => k != null && k !== false)); return el; };
const fmtN = n => Number(n || 0).toLocaleString("en-US");
const money = n => `${fmtN(n)} ر.س`;
const dtf = new Intl.DateTimeFormat("ar-SA-u-nu-latn-ca-gregory", { timeZone: "Asia/Riyadh", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const df = new Intl.DateTimeFormat("ar-SA-u-nu-latn-ca-gregory", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" });
const when = iso => iso ? dtf.format(new Date(iso)) : "—";
const day = iso => iso ? df.format(new Date(iso)) : "—";

const STATUS = {
  RECEIVED: "تم استلام الطلب", CONFIRMED: "تم تأكيد الطلب", PREPARING: "جاري التجهيز", SHIPPED: "تم الشحن",
  OUT_FOR_DELIVERY: "خرج للتوصيل", DELIVERED: "تم التوصيل", CANCELLED: "ملغي", FAILED: "تعذّر إكمال الطلب", ON_HOLD: "معلّق — يوجد مشكلة"
};
const ORDER = ["RECEIVED", "CONFIRMED", "PREPARING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "FAILED", "ON_HOLD"];
const badge = s => h("span", { class: "st st-" + s, text: STATUS[s] || s });
const ROLE = { super_admin: "مدير عام", order_manager: "مدير الطلبات", support_agent: "دعم العملاء" };
const ERR = {
  invalid_credentials: "بيانات الدخول غير صحيحة.", rate_limited: "محاولات كثيرة. انتظر دقيقة ثم حاول مرة أخرى.",
  forbidden: "ليست لديك صلاحية لهذا الإجراء.", transition_not_allowed: "لا يمكن الانتقال إلى هذه الحالة من الحالة الحالية بصلاحياتك.",
  status_changed: "تغيّرت حالة الطلب من جهاز آخر. تم تحديث البيانات.", order_changed: "تغيّر الطلب من جهاز آخر. تم تحديث البيانات، راجع ثم أعد الحفظ.",
  order_locked: "الطلب مقفل لأنه شُحن.", order_closed: "لا يمكن تعديل منتجات طلب ملغي أو متعذّر.", anonymized: "تم حذف بيانات هذا الطلب الشخصية ولا يمكن تعديله.",
  weak_password: "كلمة المرور ضعيفة: 12 حرفاً على الأقل، ولا تحتوي اسم المستخدم أو كلمات شائعة.", invalid_username: "اسم المستخدم: 3–32 حرفاً إنجليزياً أو أرقاماً أو . _ -",
  username_taken: "اسم المستخدم مستخدم.", last_super_admin: "لا يمكن إزالة آخر مدير عام نشط.", cannot_disable_self: "لا يمكنك تعطيل حسابك.",
  invalid_code: "الرمز غير صحيح.", invalid_setup_key: "كلمة مرور الإعداد غير صحيحة.", setup_done: "تم الإعداد مسبقاً. سجّل الدخول.",
  too_many: "الحد الأقصى 500 طلب في المرة الواحدة.", selection_changed: "تغيّر التحديد. أعد المحاولة.", nothing_selected: "لم تحدد أي طلب.",
  empty_note: "اكتب الملاحظة أولاً.", only_finished_orders: "الأرشفة للطلبات المنتهية فقط (تم التوصيل، ملغي، متعذّر).",
  validation: "تحقق من البيانات المدخلة.", not_found: "غير موجود.", password_change_required: "يجب تغيير كلمة المرور أولاً."
};
const errText = e => (e && e.data && e.data.error === "validation" && e.data.fields && e.data.fields.reason) ? "اكتب سبب تغيير السعر." : ERR[e && e.message] || "تعذّر تنفيذ العملية. حاول مرة أخرى.";

function toast(msg, bad) {
  const t = h("div", { class: "toast" + (bad ? " bad" : ""), text: msg });
  $("#toasts").append(t); setTimeout(() => t.remove(), bad ? 6000 : 3500);
}

/* نافذة تأكيد: تعيد true/false، ومع fields تعيد القيم */
function confirmBox(title, body, { okText = "تأكيد", danger = false, fields = null } = {}) {
  return new Promise(resolve => {
    const m = $("#modal"), ok = $("#modalOk"), cancel = $("#modalCancel");
    $("#modalTitle").textContent = title;
    const b = $("#modalBody"); b.textContent = "";
    (Array.isArray(body) ? body : [body]).forEach(x => put(b, typeof x === "string" ? h("p", { text: x }) : x));
    ok.textContent = okText; ok.className = "btn " + (danger ? "danger" : "primary");
    m.hidden = false; (fields && fields.querySelector("input,select,textarea") || ok).focus();
    const done = v => { m.hidden = true; ok.onclick = cancel.onclick = null; document.removeEventListener("keydown", esc); resolve(v); };
    const esc = e => { if (e.key === "Escape") done(false); };
    document.addEventListener("keydown", esc);
    ok.onclick = () => done(true); cancel.onclick = () => done(false);
  });
}

/* يمنع الضغط المكرر: الزر معطل حتى تنتهي العملية */
async function busy(btn, text, fn) {
  if (btn.disabled) return;
  const old = btn.textContent; btn.disabled = true; btn.textContent = text;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}

async function api(path, { method = "GET", body } = {}) {
  const init = { method: body ? "POST" : method, credentials: "same-origin", headers: {} };
  if (body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  if (init.method === "POST") init.headers["X-CG-Admin"] = "1";
  let r;
  try { r = await fetch("/admin/api" + path, init); } catch (_) { const e = new Error("network"); throw e; }
  let j = null; try { j = await r.json(); } catch (_) {}
  if (r.status === 401 && !["/me", "/login", "/login/2fa", "/me/password", "/setup", "/me/2fa/disable"].includes(path)) { session = null; go("/admin/login?expired=1"); throw new Error("unauthorized"); }
  if (r.status === 403 && j && j.error === "password_change_required") { go("/admin/change-password"); throw new Error("password_change_required"); }
  if (!r.ok) { const e = new Error((j && j.error) || "error"); e.status = r.status; e.data = j; throw e; }
  return j;
}

/* ============================================================ التنقل */
let session = null;          // { user, permissions, nav }
const can = p => !!session && session.permissions.includes(p);
function go(path, replace) { history[replace ? "replaceState" : "pushState"](null, "", path); route(); }
window.addEventListener("popstate", route);
document.addEventListener("click", e => {
  const a = e.target.closest("a[data-link]");
  if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) { e.preventDefault(); go(a.getAttribute("href")); }
});

const ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/></svg>',
  orders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h12l1 4H5l1-4ZM5 7h14v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7Z"/><path d="M9 11h6"/></svg>',
  customers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-4-5.7"/></svg>',
  products: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>',
  reports: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>'
};
const NAV_LABEL = { dashboard: "لوحة المعلومات", orders: "الطلبات", customers: "العملاء", products: "المنتجات", reports: "التقارير", audit: "سجل التدقيق", users: "المشرفون", settings: "حسابي والإعدادات" };

function shell(active, ...content) {
  const main = h("main", { class: "main", id: "main" }, content);
  const sh = h("div", { class: "shell" });
  const side = h("nav", { class: "side", "aria-label": "القائمة" },
    h("div", { class: "brand" }, h("span", { class: "o", text: ")" }), " ( ", h("b", { text: "Calm" }), "Gastro"),
    session.nav.map(k => h("a", { href: "/admin/" + k, "data-link": true, "aria-current": active === k ? "page" : null, onclick: () => sh.classList.remove("menu-open") },
      h("span", { svg: ICONS[k] }), NAV_LABEL[k])),
    h("div", { class: "spacer" }),
    h("div", { class: "who" }, h("b", { text: session.user.displayName || session.user.username }), h("span", { text: `${session.user.username} · ${session.user.roleName}` })),
    h("a", { href: "#", onclick: e => { e.preventDefault(); logout(); } }, h("span", { svg: ICONS.logout }), "تسجيل الخروج"));
  const top = h("div", { class: "top" },
    h("button", { type: "button", class: "btn ghost sm", "aria-label": "القائمة", text: "☰ القائمة", onclick: () => sh.classList.toggle("menu-open") }),
    h("div", { class: "brand" }, h("span", { class: "o", text: ")" }), " ( ", h("b", { text: "Calm" }), "Gastro"));
  put(sh, side, h("div", null, top, main));
  root.textContent = ""; put(root, sh);
  return main;
}

async function logout() {
  try { await api("/logout", { method: "POST" }); } catch (_) {}
  session = null; go("/admin/login");
}

async function ensureSession() {
  if (session) return true;
  try { session = await api("/me"); return true; }
  catch (e) { return false; }
}

async function route() {
  const path = location.pathname.replace(/\/+$/, "") || "/admin";
  document.title = "إدارة CalmGastro";
  if (path === "/admin/login") return pageLogin();
  if (path === "/admin/setup") return pageSetup();
  if (path === "/admin/change-password") return pageForcedPassword();
  if (!(await ensureSession())) {
    try { const s = await api("/setup"); if (s.needed) return go("/admin/setup", true); } catch (_) {}
    return go("/admin/login", true);
  }
  const m = path.match(/^\/admin\/orders\/([A-Za-z0-9-]+)$/);
  if (m) return pageOrder(m[1]);
  const page = path.split("/")[2] || "";
  const pages = { dashboard: pageDashboard, orders: pageOrders, customers: pageCustomers, products: pageProducts, reports: pageReports, audit: pageAudit, users: pageUsers, settings: pageSettings };
  if (pages[page] && session.nav.includes(page)) return pages[page]();
  return go("/admin/" + (session.nav[0] || "settings"), true);
}

/* ============================================================ الدخول والإعداد */
function authForm(title, fields, submitText, onSubmit, extra) {
  const err = h("p", { class: "err", role: "alert" });
  const btn = h("button", { type: "submit", class: "btn primary", text: submitText });
  const form = h("form", { novalidate: true },
    h("div", { class: "brand" }, h("span", { class: "o", text: ")" }), " ( ", h("b", { text: "Calm" }), "Gastro"),
    h("h1", { text: title }), extra || null, fields, err, btn);
  form.addEventListener("submit", async e => {
    e.preventDefault(); err.textContent = "";
    await busy(btn, "جارٍ التحقق…", async () => { try { await onSubmit(form); } catch (x) { if (x.message !== "unauthorized") err.textContent = errText(x); } });
  });
  root.textContent = ""; put(root, h("div", { class: "auth" }, form));
  const first = form.querySelector("input"); if (first) first.focus();
  return form;
}
const field = (label, attrs, hint) => h("label", { class: "f" }, label, h("input", attrs), hint ? h("small", { text: hint }) : null);

function pageLogin() {
  session = null;
  const expired = /expired=1/.test(location.search);
  authForm("تسجيل دخول الإدارة", [
    field("اسم المستخدم", { name: "username", autocomplete: "username", required: true, maxlength: 64, dir: "ltr" }),
    field("كلمة المرور", { name: "password", type: "password", autocomplete: "current-password", required: true, maxlength: 200 })
  ], "دخول", async f => {
    const r = await api("/login", { body: { username: f.username.value.trim(), password: f.password.value } });
    f.password.value = "";
    if (r.mfa) return pageMfa();
    session = null; go("/admin/dashboard");
  }, expired ? h("p", { class: "note-box", text: "انتهت الجلسة. سجّل الدخول مرة أخرى." }) : null);
}

function pageMfa() {
  authForm("رمز التحقق", [field("الرمز من تطبيق المصادقة", { name: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, pattern: "\\d{6}", dir: "ltr", required: true })],
    "تحقق", async f => { await api("/login/2fa", { body: { code: f.code.value.trim() } }); session = null; go("/admin/dashboard"); },
    h("p", { class: "muted small", text: "افتح تطبيق المصادقة (مثل Google Authenticator) واكتب الرمز المكوّن من 6 أرقام." }));
}

function pageSetup() {
  authForm("إعداد حساب المدير العام", [
    field("كلمة مرور الإعداد", { name: "setupKey", type: "password", required: true, autocomplete: "off" }, "كلمة مرور لوحة الطلبات الحالية. تُستخدم مرة واحدة فقط."),
    field("اسم المستخدم", { name: "username", required: true, maxlength: 32, dir: "ltr", autocomplete: "username" }, "حروف إنجليزية أو أرقام، 3–32 حرفاً."),
    field("الاسم الظاهر", { name: "displayName", maxlength: 60 }),
    field("كلمة المرور الجديدة", { name: "password", type: "password", required: true, autocomplete: "new-password" }, "12 حرفاً على الأقل."),
    field("تأكيد كلمة المرور", { name: "password2", type: "password", required: true, autocomplete: "new-password" })
  ], "إنشاء الحساب", async f => {
    if (f.password.value !== f.password2.value) throw new Error("mismatch_pw");
    await api("/setup", { body: { setupKey: f.setupKey.value, username: f.username.value.trim(), displayName: f.displayName.value.trim(), password: f.password.value } });
    toast("تم إنشاء الحساب. سجّل الدخول الآن.");
    go("/admin/login");
  }, h("p", { class: "note-box", text: "هذه الصفحة تعمل مرة واحدة فقط لإنشاء أول مدير عام. بعدها يُدار الدخول بأسماء مستخدمين وكلمات مرور مشفّرة." }));
  ERR.mismatch_pw = "كلمتا المرور غير متطابقتين.";
}

function pageForcedPassword() {
  authForm("غيّر كلمة المرور المؤقتة", [
    field("كلمة المرور الحالية (المؤقتة)", { name: "current", type: "password", required: true, autocomplete: "current-password" }),
    field("كلمة المرور الجديدة", { name: "next", type: "password", required: true, autocomplete: "new-password" }, "12 حرفاً على الأقل."),
    field("تأكيد كلمة المرور", { name: "next2", type: "password", required: true, autocomplete: "new-password" })
  ], "حفظ", async f => {
    if (f.next.value !== f.next2.value) throw new Error("mismatch_pw");
    await api("/me/password", { body: { current: f.current.value, next: f.next.value } });
    toast("تم تغيير كلمة المرور."); session = null; go("/admin/dashboard");
  });
  ERR.mismatch_pw = "كلمتا المرور غير متطابقتين.";
}

/* ============================================================ لوحة المعلومات */
async function pageDashboard() {
  const main = shell("dashboard", h("h1", { text: "لوحة المعلومات" }), h("p", { class: "muted", text: "جارٍ التحميل…" }));
  let d; try { d = await api("/dashboard"); } catch (e) { if (e.message !== "unauthorized") main.lastChild.textContent = errText(e); return; }
  const s = d.byStatus, tile = (k, v, link, hint) => h("a", { class: "tile", href: link, "data-link": true }, h("span", { class: "k", text: k }), h("div", { class: "v num", text: fmtN(v) }), hint ? h("span", { class: "s", text: hint }) : null);
  main.textContent = "";
  put(main, h("h1", { text: "لوحة المعلومات" }),
    h("div", { class: "tiles" },
      tile("طلبات اليوم", d.today, "/admin/orders?range=today"),
      tile("طلبات جديدة", s.RECEIVED || 0, "/admin/orders?status=RECEIVED", "بانتظار التأكيد"),
      tile("مؤكدة", s.CONFIRMED || 0, "/admin/orders?status=CONFIRMED"),
      tile("جاري التجهيز", s.PREPARING || 0, "/admin/orders?status=PREPARING"),
      tile("تم الشحن", s.SHIPPED || 0, "/admin/orders?status=SHIPPED"),
      tile("خرج للتوصيل", s.OUT_FOR_DELIVERY || 0, "/admin/orders?status=OUT_FOR_DELIVERY"),
      tile("تم التوصيل", s.DELIVERED || 0, "/admin/orders?status=DELIVERED"),
      tile("ملغي", s.CANCELLED || 0, "/admin/orders?status=CANCELLED"),
      tile("معلّق / متعذّر", (s.ON_HOLD || 0) + (s.FAILED || 0), "/admin/orders?status=ON_HOLD")),
    h("section", { class: "card" }, h("h2", { text: "أحدث الطلبات" }), orderTable(d.latest, { selectable: false })));
  document.title = (s.RECEIVED ? `(${s.RECEIVED}) ` : "") + "إدارة CalmGastro";
}

/* ============================================================ الطلبات */
const selected = new Set();          // التحديد يبقى عند التنقل بين الصفحات
function orderTable(orders, { selectable, onToggle } = {}) {
  if (!orders.length) return h("div", { class: "empty", text: "لا توجد طلبات مطابقة." });
  const all = selectable ? h("input", { type: "checkbox", "aria-label": "تحديد طلبات هذه الصفحة", checked: orders.every(o => selected.has(o.orderNumber)) }) : null;
  if (all) all.addEventListener("change", () => { orders.forEach(o => all.checked ? selected.add(o.orderNumber) : selected.delete(o.orderNumber)); onToggle && onToggle(); });
  return h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, selectable ? h("th", { class: "sel" }, all) : null,
      ["رقم الطلب", "العميل", "الجوال", "التاريخ", "الإجمالي", "الدفع", "الحالة", "آخر تحديث", ""].map(t => h("th", { text: t })))),
    h("tbody", null, orders.map(o => {
      const cb = selectable ? h("input", { type: "checkbox", "aria-label": "تحديد " + o.orderNumber, checked: selected.has(o.orderNumber) }) : null;
      if (cb) cb.addEventListener("change", () => { cb.checked ? selected.add(o.orderNumber) : selected.delete(o.orderNumber); onToggle && onToggle(); });
      return h("tr", null, selectable ? h("td", { class: "sel" }, cb) : null,
        h("td", null, h("a", { href: "/admin/orders/" + o.orderNumber, "data-link": true, class: "num", text: o.orderNumber })),
        h("td", { text: o.customerName }), h("td", { class: "num", text: o.phone || "" }), h("td", { text: when(o.createdAt) }),
        h("td", { text: money(o.total) }), h("td", { text: o.paymentMethod === "cod" || !o.paymentMethod ? "عند الاستلام" : o.paymentMethod }),
        h("td", null, badge(o.status), o.archived ? h("span", { class: "tag", text: " مؤرشف" }) : null),
        h("td", { text: o.updatedAt ? when(o.updatedAt) : "" }),
        h("td", null, h("a", { class: "btn ghost sm", href: "/admin/orders/" + o.orderNumber, "data-link": true, text: "عرض" })));
    }))));
}

async function pageOrders() {
  const P = new URLSearchParams(location.search);
  const main = shell("orders");
  const state = { q: P.get("q") || "", status: P.get("status") || "", payment: P.get("payment") || "", range: P.get("range") || "", from: P.get("from") || "", to: P.get("to") || "",
                  archived: P.get("archived") || "", phone: P.get("phone") || "", per: P.get("per") || "25", page: P.get("page") || "1" };
  const qs = (extra = {}) => { const u = new URLSearchParams(); Object.entries({ ...state, ...extra }).forEach(([k, v]) => { if (v && !(k === "per" && v === "25") && !(k === "page" && v === "1")) u.set(k, v); }); return u.toString(); };
  const reload = (extra = {}) => { Object.assign(state, extra); history.replaceState(null, "", "/admin/orders" + (qs() ? "?" + qs() : "")); load(); };

  const q = h("input", { type: "search", placeholder: "رقم الطلب، اسم العميل أو الجوال", "aria-label": "بحث", value: state.q });
  const st = h("select", { "aria-label": "الحالة" }, h("option", { value: "", text: "كل الحالات" }), h("option", { value: "OPEN", text: "الطلبات المفتوحة" }),
    ORDER.map(s => h("option", { value: s, text: STATUS[s], selected: state.status === s })));
  if (state.status === "OPEN") st.value = "OPEN";
  const pay = h("select", { "aria-label": "طريقة الدفع" }, h("option", { value: "", text: "كل طرق الدفع" }), h("option", { value: "cod", text: "الدفع عند الاستلام", selected: state.payment === "cod" }));
  const range = h("select", { "aria-label": "الفترة" }, [["", "كل التواريخ"], ["today", "اليوم"], ["yesterday", "أمس"], ["7d", "آخر 7 أيام"], ["30d", "آخر 30 يوماً"], ["custom", "فترة مخصصة"]]
    .map(([v, t]) => h("option", { value: v, text: t, selected: (state.range || (state.from || state.to ? "custom" : "")) === v })));
  const from = h("input", { type: "date", "aria-label": "من تاريخ", value: state.from }), to = h("input", { type: "date", "aria-label": "إلى تاريخ", value: state.to });
  const custom = h("span", { class: "row" }, "من", from, "إلى", to);
  const arch = h("select", { "aria-label": "الأرشيف" }, [["", "غير المؤرشفة"], ["1", "المؤرشفة"], ["all", "الكل"]].map(([v, t]) => h("option", { value: v, text: t, selected: state.archived === v })));
  const per = h("select", { "aria-label": "عدد الطلبات في الصفحة" }, ["25", "50", "100"].map(v => h("option", { value: v, text: v + " في الصفحة", selected: state.per === v })));
  const showCustom = () => { custom.hidden = range.value !== "custom"; };
  showCustom();
  const apply = () => reload({ q: q.value.trim(), status: st.value, payment: pay.value, range: range.value === "custom" ? "" : range.value,
    from: range.value === "custom" ? from.value : "", to: range.value === "custom" ? to.value : "", archived: arch.value, per: per.value, page: "1" });
  const form = h("form", { class: "filters", onsubmit: e => { e.preventDefault(); apply(); } }, q, st, pay, range, custom, arch, per,
    h("button", { type: "submit", class: "btn primary", text: "بحث" }),
    h("button", { type: "button", class: "btn ghost", text: "مسح", onclick: () => { selected.clear(); history.replaceState(null, "", "/admin/orders"); pageOrders(); } }));
  [st, pay, arch, per].forEach(x => x.addEventListener("change", apply));
  range.addEventListener("change", () => { showCustom(); if (range.value !== "custom") apply(); });   // الفترات الجاهزة تُطبّق فوراً

  const exportBtn = can("orders.export") ? h("a", { class: "btn ghost", text: "تصدير CSV / Excel", href: "#", onclick: e => { e.currentTarget.href = "/admin/api/orders/export.csv" + (qs({ page: "", per: "" }) ? "?" + qs({ page: "", per: "" }) : ""); } , download: "" }) : null;
  const bulk = h("div", { class: "bulkbar", hidden: true });
  const chips = h("div", { class: "chips" });
  const list = h("div", null, h("p", { class: "muted", text: "جارٍ التحميل…" }));
  const pager = h("div", { class: "pager" });
  put(main, h("div", { class: "page-head" }, h("h1", { text: "الطلبات" }), exportBtn), state.phone ? h("p", { class: "note-box" }, "طلبات العميل ", h("span", { class: "num", text: state.phone }), " ", h("a", { href: "/admin/orders", "data-link": true, text: "عرض كل الطلبات" })) : null,
    form, chips, bulk, list, pager);

  let last = null;
  function renderBulk() {
    bulk.textContent = "";
    if (!selected.size) { bulk.hidden = true; return; }
    bulk.hidden = false;
    put(bulk, h("b", { text: `تم تحديد ${fmtN(selected.size)} طلب` }),
      h("button", { type: "button", class: "btn ghost sm", text: `تحديد كل النتائج (${fmtN(last ? last.total : 0)})`, onclick: async e => {
        await busy(e.currentTarget, "جارٍ التحديد…", async () => {
          try {
            const r = await api("/orders/matching?" + qs({ page: "", per: "" }));
            r.numbers.forEach(n => selected.add(n));
            if (r.total > r.max) toast(`النتائج ${fmtN(r.total)} طلب؛ حُدد أول ${fmtN(r.max)} فقط (الحد الأقصى في المرة الواحدة).`, true);
          } catch (x) { toast(errText(x), true); }
        });
        render();
      } }),
      h("button", { type: "button", class: "btn ghost sm", text: "إلغاء تحديد الكل", onclick: () => { selected.clear(); render(); } }),
      can("orders.status.bulk") ? h("button", { type: "button", class: "btn primary sm", text: "تغيير الحالة", onclick: bulkChange }) : null);
  }
  async function bulkChange() {
    const sel = h("select", null, ORDER.map(s => h("option", { value: s, text: STATUS[s] })));
    const note = h("textarea", { placeholder: "ملاحظة (اختياري)", maxlength: 1000 });
    const vis = h("select", null, h("option", { value: "internal", text: "ملاحظة داخلية (لا يراها العميل)" }), h("option", { value: "customer", text: "رسالة يراها العميل في تتبع الطلب" }));
    const over = can("orders.status.override") ? h("label", { class: "row small" }, h("input", { type: "checkbox" }), "السماح بتغيير استثنائي (رجوع للخلف أو من حالة نهائية)") : null;
    const fields = h("div", { class: "grid2" }, h("label", { class: "f" }, "الحالة الجديدة", sel), h("label", { class: "f" }, "نوع الملاحظة", vis));
    const n = selected.size;
    if (!(await confirmBox("تغيير حالة الطلبات المحددة", [fields, note, over || "", h("p", { class: "muted small", text: "الطلبات التي لا يسمح سير العمل بنقلها ستُتخطى وتظهر في النتيجة." })], { okText: "متابعة", fields }))) return;
    const label = STATUS[sel.value];
    if (!(await confirmBox("تأكيد التحديث الجماعي", `هل أنت متأكد من تغيير حالة ${fmtN(n)} طلب إلى "${label}"؟`, { okText: `تحديث ${fmtN(n)} طلب` }))) return;
    toast("جاري تحديث الطلبات…");
    try {
      const r = await api("/orders/bulk-status", { body: { numbers: [...selected], expectedCount: n, status: sel.value, note: note.value, visibility: vis.value, override: !!(over && over.querySelector("input").checked) } });
      toast(`تم تحديث ${fmtN(r.updated)} طلب بنجاح.` + (r.skipped.length ? ` تُخطي ${fmtN(r.skipped.length)}.` : ""));
      if (r.skipped.length) await confirmBox("طلبات لم تُحدَّث", h("div", { class: "audit-mini" }, r.skipped.slice(0, 50).map(s => h("div", null, h("span", { class: "num", text: s.orderNumber }), " — ",
        s.reason === "already" ? "في هذه الحالة مسبقاً" : s.reason === "not_found" ? "غير موجود" : s.reason === "anonymized" ? "بيانات محذوفة" : `لا يمكن الانتقال من «${STATUS[s.status] || s.status}»`))), { okText: "حسناً" });
      selected.clear(); load();
    } catch (x) { if (x.message !== "unauthorized") toast("تعذر تحديث الطلبات. " + errText(x), true); }
  }
  function render() {
    if (!last) return;
    list.textContent = ""; put(list, orderTable(last.orders, { selectable: true, onToggle: renderBulk }));
    renderBulk();
    const start = last.total ? (last.page - 1) * last.per + 1 : 0, end = Math.min(last.total, last.page * last.per), pages = Math.ceil(last.total / last.per);
    pager.textContent = "";
    put(pager, h("span", { class: "muted", text: `${fmtN(start)}–${fmtN(end)} من ${fmtN(last.total)}` }),
      h("span", { class: "row" },
        h("button", { type: "button", class: "btn ghost sm", text: "السابق", disabled: last.page <= 1, onclick: () => reload({ page: String(last.page - 1) }) }),
        h("span", { class: "num", text: `${last.page} / ${Math.max(1, pages)}` }),
        h("button", { type: "button", class: "btn ghost sm", text: "التالي", disabled: last.page >= pages, onclick: () => reload({ page: String(last.page + 1) }) })));
    chips.textContent = "";
    const total = Object.values(last.counts).reduce((a, b) => a + b, 0);
    put(chips, h("button", { type: "button", class: "chip", "aria-pressed": String(!state.status), onclick: () => { st.value = ""; apply(); } }, "الكل", h("b", { class: "num", text: fmtN(total) })),
      ORDER.filter(s => last.counts[s] || s === "RECEIVED").map(s => h("button", { type: "button", class: "chip", "aria-pressed": String(state.status === s), onclick: () => { st.value = s; apply(); } }, STATUS[s], h("b", { class: "num", text: fmtN(last.counts[s] || 0) }))));
  }
  async function load() {
    try { last = await api("/orders?" + qs()); render(); }
    catch (e) { if (e.message !== "unauthorized") { list.textContent = ""; put(list, h("p", { class: "err", text: "تعذر تحميل الطلبات. " + errText(e) })); } }
  }
  load();
}

/* ============================================================ طلب واحد */
async function pageOrder(number) {
  const main = shell("orders", h("p", { class: "muted", text: "جارٍ التحميل…" }));
  let o, catalog = null;
  try { o = await api("/orders/" + encodeURIComponent(number)); } catch (e) { if (e.message !== "unauthorized") { main.textContent = ""; put(main, h("p", { class: "err", text: errText(e) }), h("a", { href: "/admin/orders", "data-link": true, text: "العودة للطلبات" })); } return; }
  const refresh = data => { o = data; render(); };
  const run = async (btn, text, fn, okMsg) => busy(btn, text, async () => {
    try { const r = await fn(); if (r) refresh(r); if (okMsg) toast(okMsg); }
    catch (e) {
      if (e.message === "unauthorized") return;
      toast(errText(e), true);
      if (["status_changed", "order_changed"].includes(e.message)) { try { refresh(await api("/orders/" + o.orderNumber)); } catch (_) {} }
    }
  });

  function render() {
    document.title = o.orderNumber + " — إدارة CalmGastro";
    main.textContent = "";
    const c = o.customer;
    put(main, h("div", { class: "page-head" },
      h("div", null, h("a", { href: "/admin/orders", "data-link": true, class: "small", text: "→ الطلبات" }), h("h1", null, "طلب ", h("span", { class: "num", text: o.orderNumber }))),
      h("div", { class: "row" }, badge(o.status), o.locked ? h("span", { class: "tag", text: "المنتجات مقفلة (تم الشحن)" }) : null, o.archived ? h("span", { class: "tag", text: "مؤرشف" }) : null, o.anonymized ? h("span", { class: "tag", text: "بيانات شخصية محذوفة" }) : null)));
    const left = h("div"), right = h("div");
    put(main, h("div", { class: "o-grid" }, left, right));

    /* معلومات الطلب */
    put(left, h("section", { class: "card" }, h("h2", { text: "معلومات الطلب" }), h("dl", { class: "kv" },
      h("dt", { text: "رقم الطلب" }), h("dd", { class: "num", text: o.orderNumber }),
      h("dt", { text: "تاريخ الإنشاء" }), h("dd", { text: when(o.createdAt) }),
      h("dt", { text: "آخر تحديث" }), h("dd", { text: when(o.updatedAt) }),
      h("dt", { text: "الحالة الحالية" }), h("dd", null, badge(o.status)),
      h("dt", { text: "طريقة الدفع" }), h("dd", { text: o.paymentMethod === "cod" ? "الدفع عند الاستلام" : o.paymentMethod }),
      h("dt", { text: "المجموع الفرعي" }), h("dd", { text: money(o.subtotal) }),
      o.discount ? [h("dt", { text: "خصم الباقات" }), h("dd", { text: "− " + money(o.discount) })] : null,
      h("dt", { text: "الشحن" }), h("dd", { text: o.shipping ? money(o.shipping) : "مجاني" }),
      h("dt", { text: "الإجمالي" }), h("dd", null, h("b", { text: money(o.total) })),
      h("dt", { text: "لغة العميل" }), h("dd", { text: o.lang === "en" ? "الإنجليزية" : "العربية" }))));

    /* المنتجات */
    put(left, itemsCard());
    /* العميل */
    put(left, customerCard(c));
    /* الحالة */
    put(right, statusCard());
    /* السجل */
    put(right, h("section", { class: "card" }, h("h2", { text: "سجل الحالات" }),
      h("ol", { class: "tl" }, o.history.map(x => h("li", null, h("span", { class: "dot", "aria-hidden": "true" }), h("div", null,
        h("b", { text: STATUS[x.to] || x.to }), x.bulk ? h("span", { class: "tag", text: " تحديث جماعي" }) : null,
        h("small", { text: `${when(x.at)} · ${x.by === "customer" ? "العميل (إنشاء الطلب)" : "بواسطة: " + x.by}` + (x.from ? ` · من «${STATUS[x.from] || x.from}»` : "") }),
        x.note ? h("small", null, h("span", { class: "tag" + (x.visibility === "customer" ? " cust" : ""), text: x.visibility === "customer" ? "يراها العميل" : "داخلية" }), " ", x.note) : null))))));
    /* ملاحظات داخلية */
    put(right, notesCard());
    /* إجراءات */
    put(right, actionsCard(c));
    if (o.audit && o.audit.length) put(right, h("section", { class: "card" }, h("h2", { text: "سجل التعديلات على الطلب" }),
      h("div", { class: "audit-mini" }, o.audit.slice(0, 40).map(a => h("div", null, h("b", { text: auditLabel(a.action) }), " — ", a.by || "",
        h("small", { class: "muted", text: " " + when(a.at) }), auditDiff(a.old, a.new))))));
  }

  function statusCard() {
    const card = h("section", { class: "card" }, h("h2", { text: "تحديث حالة الطلب" }));
    if (!o.nextStatuses.length) { put(card, h("p", { class: "muted", text: o.anonymized ? "لا يمكن تعديل هذا الطلب." : "لا توجد حالات متاحة لصلاحياتك من الحالة الحالية." })); return card; }
    // سير العمل المعتاد أولاً؛ التغييرات الاستثنائية (للمدير العام) في مجموعة منفصلة
    const normal = o.nextStatuses.filter(x => x.kind === "normal"), special = o.nextStatuses.filter(x => x.kind === "override");
    const sel = h("select", { "aria-label": "الحالة الجديدة" },
      normal.length ? h("optgroup", { label: "سير العمل" }, normal.map(x => h("option", { value: x.status, text: STATUS[x.status] }))) : null,
      special.length ? h("optgroup", { label: "تغيير استثنائي" }, special.map(x => h("option", { value: x.status, text: STATUS[x.status] + " (استثنائي)" }))) : null);
    const vis = h("select", { "aria-label": "نوع الملاحظة" }, h("option", { value: "internal", text: "ملاحظة داخلية" }), h("option", { value: "customer", text: "رسالة يراها العميل" }));
    const note = h("textarea", { placeholder: "ملاحظة (اختياري) — مثال: تم تسليم الطلب لشركة الشحن.", maxlength: 1000 });
    const btn = h("button", { type: "button", class: "btn primary", text: "تحديث الحالة" });
    btn.addEventListener("click", async () => {
      const opt = o.nextStatuses.find(x => x.status === sel.value), label = STATUS[sel.value];
      const msgs = [`هل أنت متأكد من تغيير حالة الطلب إلى "${label}"؟`];
      if (opt.kind === "override") msgs.push(h("p", { class: "warn-box", text: `تغيير استثنائي: من «${STATUS[o.status]}» إلى «${label}» خارج سير العمل المعتاد. سيُسجَّل باسمك.` }));
      if (sel.value === "CANCELLED") msgs.push(h("p", { class: "warn-box", text: "هل أنت متأكد من إلغاء الطلب؟" }));
      if (vis.value === "customer" && note.value.trim()) msgs.push(h("p", { class: "muted small", text: "ستظهر الملاحظة للعميل في صفحة تتبع الطلب." }));
      if (!(await confirmBox("تحديث حالة الطلب", msgs, { okText: "تغيير الحالة", danger: sel.value === "CANCELLED" || opt.kind === "override" }))) return;
      run(btn, "جاري تحديث الطلب...", () => api(`/orders/${o.orderNumber}/status`, { body: { status: sel.value, note: note.value, visibility: vis.value, expectedStatus: o.status, override: opt.kind === "override" } }), "تم تحديث الطلب بنجاح.");
    });
    put(card, h("div", { class: "grid2" }, h("label", { class: "f" }, "الحالة الجديدة", sel), h("label", { class: "f" }, "نوع الملاحظة", vis)), note, h("div", { class: "row", style: null }, btn));
    return card;
  }

  function customerCard(c) {
    const card = h("section", { class: "card" });
    const view = () => {
      card.textContent = "";
      put(card, h("div", { class: "page-head" }, h("h2", { text: "العميل والتوصيل" }), o.can.edit_customer ? h("button", { type: "button", class: "btn ghost sm", text: "تعديل", onclick: edit }) : null),
        h("dl", { class: "kv" },
          h("dt", { text: "الاسم" }), h("dd", { text: c.name }), h("dt", { text: "الجوال" }), h("dd", { class: "num", text: c.phone }),
          h("dt", { text: "المدينة" }), h("dd", { text: c.city }), h("dt", { text: "الحي" }), h("dd", { text: c.district }),
          h("dt", { text: "العنوان" }), h("dd", { text: c.address }), h("dt", { text: "ملاحظات التوصيل" }), h("dd", { text: c.notes || "—" })));
    };
    const edit = () => {
      const f = {}, mk = (k, label, attrs) => { f[k] = h(k === "notes" ? "textarea" : "input", { value: c[k] || "", maxlength: k === "address" ? 200 : k === "notes" ? 500 : 60, ...attrs }); return h("label", { class: "f" }, label, f[k]); };
      const err = h("p", { class: "err", role: "alert" });
      const save = h("button", { type: "button", class: "btn primary", text: "حفظ" });
      card.textContent = "";
      put(card, h("h2", { text: "تعديل بيانات العميل" }), h("div", { class: "grid2" }, mk("name", "الاسم"), mk("phone", "الجوال", { dir: "ltr", inputmode: "tel" }), mk("city", "المدينة"), mk("district", "الحي")),
        mk("address", "العنوان"), mk("notes", "ملاحظات التوصيل"), err, h("div", { class: "row" }, save, h("button", { type: "button", class: "btn ghost", text: "إلغاء", onclick: view })));
      save.addEventListener("click", async () => {
        const changed = Object.keys(f).filter(k => f[k].value.trim() !== String(c[k] || "").trim());
        if (!changed.length) return view();
        const labels = { name: "الاسم", phone: "الجوال", city: "المدينة", district: "الحي", address: "العنوان", notes: "ملاحظات التوصيل" };
        const lines = changed.map(k => h("p", { class: "small" }, h("b", { text: labels[k] + ": " }), `${c[k] || "—"} ← ${f[k].value.trim() || "—"}`));
        if (changed.some(k => k === "phone" || k === "address")) lines.unshift(h("p", { class: "warn-box", text: "تعديل الجوال أو العنوان يغيّر بيانات التوصيل والتحقق في تتبع الطلب." }));
        if (!(await confirmBox("هل أنت متأكد من حفظ التعديلات؟", lines, { okText: "حفظ التعديلات" }))) return;
        await busy(save, "جاري الحفظ…", async () => {
          try { refresh(await api(`/orders/${o.orderNumber}/customer`, { body: { customer: Object.fromEntries(changed.map(k => [k, f[k].value])), expectedUpdatedAt: o.updatedAt } })); toast("تم حفظ التعديلات."); }
          catch (e) { if (e.message === "unauthorized") return; err.textContent = e.data && e.data.fields ? Object.entries(e.data.fields).map(([k, v]) => `${labels[k] || k}: ${v === "invalid_phone" ? "رقم جوال سعودي غير صحيح" : "مطلوب"}`).join(" · ") : errText(e); if (e.message === "order_changed") refresh(await api("/orders/" + o.orderNumber)); }
        });
      });
    };
    view();
    return card;
  }

  function itemsCard() {
    const card = h("section", { class: "card" });
    const view = () => {
      card.textContent = "";
      put(card, h("div", { class: "page-head" }, h("h2", { text: `المنتجات (${o.boxes} علب)` }),
        o.can.edit_items && !["CANCELLED", "FAILED"].includes(o.status) ? h("button", { type: "button", class: "btn ghost sm", text: "تعديل المنتجات", onclick: edit }) : null),
        h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["المنتج", "الكمية", "سعر الوحدة", "المجموع"].map(t => h("th", { text: t })))),
          h("tbody", null, o.items.map(i => h("tr", null, h("td", { class: "wrap", text: i.name }), h("td", { class: "num", text: i.quantity }),
            h("td", null, money(i.unitPrice), i.priceOverridden ? h("span", { class: "tag", text: " سعر معدّل" }) : null), h("td", { text: money(i.lineTotal) })))))));
    };
    const edit = async () => {
      if (o.locked && !(await confirmBox("الطلب تم شحنه", h("p", { class: "warn-box", text: "هذا الطلب تم شحنه. تعديل المنتجات أو القيمة قد يؤثر على عملية الشحن. هل تريد المتابعة؟" }), { okText: "متابعة التعديل", danger: true }))) return;
      if (!catalog) { try { catalog = await api("/products"); } catch (e) { toast(errText(e), true); return; } }
      const rows = o.items.map(i => ({ id: i.id, name: i.name, productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice, origPrice: i.unitPrice }));
      const tbody = h("tbody"), reason = h("input", { placeholder: "سبب تغيير السعر (إلزامي عند تغيير السعر)", maxlength: 200, style: null });
      const err = h("p", { class: "err", role: "alert" });
      const draw = () => {
        tbody.textContent = "";
        rows.forEach((r, idx) => {
          const qty = h("input", { type: "number", min: 1, max: 99, value: r.quantity, "aria-label": "الكمية" }); qty.addEventListener("input", () => { r.quantity = Number(qty.value); });
          const price = o.can.edit_price ? h("input", { type: "number", min: 0, value: r.unitPrice, "aria-label": "سعر الوحدة" }) : null;
          if (price) price.addEventListener("input", () => { r.unitPrice = Number(price.value); });
          tbody.append(h("tr", null, h("td", { class: "wrap", text: r.name }), h("td", null, qty), h("td", null, price || money(r.unitPrice)),
            h("td", null, h("button", { type: "button", class: "btn danger sm", text: "حذف", onclick: () => { rows.splice(idx, 1); draw(); } }))));
        });
      };
      const addSel = h("select", { "aria-label": "إضافة منتج" }, h("option", { value: "", text: "إضافة منتج…" }), catalog.bundles.map(b => h("option", { value: b.id, text: `${b.title} · ${b.program} — ${money(b.price)}` })));
      addSel.addEventListener("change", () => { const b = catalog.bundles.find(x => x.id === addSel.value); if (b) { rows.push({ productId: b.id, name: `${b.title} · ${b.program}`, quantity: 1, unitPrice: b.price, origPrice: b.price, isNew: true }); draw(); } addSel.value = ""; });
      const save = h("button", { type: "button", class: "btn primary", text: "حفظ المنتجات" });
      card.textContent = "";
      put(card, h("h2", { text: "تعديل المنتجات" }), o.locked ? h("p", { class: "warn-box", text: "الطلب تم شحنه: سيُسجَّل هذا التعديل كتعديل بعد الشحن." }) : null,
        h("div", { class: "table-wrap items-edit" }, h("table", null, h("thead", null, h("tr", null, ["المنتج", "الكمية", "سعر الوحدة", ""].map(t => h("th", { text: t })))), tbody)),
        h("div", { class: "row", style: null }, addSel), o.can.edit_price ? reason : h("p", { class: "muted small", text: "تغيير الأسعار متاح للمدير العام فقط." }),
        h("p", { class: "muted small", text: "يعيد الخادم حساب المجموع والخصم والشحن بعد الحفظ." }), err,
        h("div", { class: "row" }, save, h("button", { type: "button", class: "btn ghost", text: "إلغاء", onclick: view })));
      draw();
      save.addEventListener("click", async () => {
        err.textContent = "";
        if (!rows.length) { err.textContent = "يجب أن يحتوي الطلب على منتج واحد على الأقل."; return; }
        if (rows.some(r => !Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > 99)) { err.textContent = "الكمية بين 1 و 99."; return; }
        const priceChanged = rows.some(r => r.unitPrice !== r.origPrice);
        if (priceChanged && reason.value.trim().length < 3) { err.textContent = "اكتب سبب تغيير السعر."; reason.focus(); return; }
        const msgs = ["سيعيد النظام حساب إجمالي الطلب بعد الحفظ. هل تريد المتابعة؟"];
        if (priceChanged) msgs.unshift(h("p", { class: "warn-box", text: "تغيير قيمة الطلب سيؤثر على إجمالي الطلب. هل تريد المتابعة؟" }));
        if (!(await confirmBox("حفظ تعديل المنتجات", msgs, { okText: "حفظ" }))) return;
        await busy(save, "جاري الحفظ…", async () => {
          try {
            refresh(await api(`/orders/${o.orderNumber}/items`, { body: { items: rows.map(r => ({ id: r.id, productId: r.productId, quantity: r.quantity, unitPrice: o.can.edit_price ? r.unitPrice : undefined })),
              reason: reason.value, force: o.locked, expectedUpdatedAt: o.updatedAt } }));
            toast("تم تحديث المنتجات وإعادة حساب الإجمالي.");
          } catch (e) { if (e.message !== "unauthorized") err.textContent = errText(e); }
        });
      });
    };
    view();
    return card;
  }

  function notesCard() {
    const card = h("section", { class: "card" }, h("h2", { text: "ملاحظات داخلية" }), h("p", { class: "muted small", text: "لا يراها العميل." }),
      h("div", { class: "notes" }, o.notes.length ? o.notes.map(n => h("div", null, n.note, h("small", { text: `${n.by} · ${when(n.at)}` }))) : h("p", { class: "muted", text: "لا توجد ملاحظات." })));
    if (o.can.notes) {
      const t = h("textarea", { placeholder: "مثال: العميل طلب الاتصال قبل التوصيل.", maxlength: 1000 });
      const b = h("button", { type: "button", class: "btn ghost", text: "إضافة ملاحظة" });
      b.addEventListener("click", () => { if (!t.value.trim()) return toast(ERR.empty_note, true); run(b, "جاري الحفظ…", () => api(`/orders/${o.orderNumber}/notes`, { body: { note: t.value } }), "تمت إضافة الملاحظة."); });
      put(card, t, h("div", { class: "row" }, b));
    }
    return card;
  }

  function actionsCard(c) {
    const wa = c.phoneIntl && !o.anonymized ? "https://wa.me/" + c.phoneIntl + "?text=" + encodeURIComponent(`مرحباً ${c.name}، بخصوص طلبك رقم ${o.orderNumber} من CalmGastro.`) : null;
    const card = h("section", { class: "card" }, h("h2", { text: "إجراءات" }), h("div", { class: "actions" },
      wa ? h("a", { class: "btn ghost sm", href: wa, target: "_blank", rel: "noopener noreferrer", text: "واتساب العميل" }) : null,
      !o.anonymized ? h("a", { class: "btn ghost sm", href: "tel:" + c.phone, text: "اتصال" }) : null,
      c.location ? h("a", { class: "btn ghost sm", href: `https://www.google.com/maps?q=${c.location.lat},${c.location.lng}`, target: "_blank", rel: "noopener noreferrer", text: "الموقع على الخريطة" }) : null));
    const acts = card.lastChild;
    if (o.can.revoke_link) put(acts, h("button", { type: "button", class: "btn ghost sm", text: "إلغاء رابط الطلب الآمن", onclick: async e => {
      const btn = e.currentTarget;
      if (!(await confirmBox("إلغاء رابط الطلب", "سيتوقف الرابط الآمن الذي حصل عليه العميل عن العمل، ويبقى التتبع برقم الطلب والجوال متاحاً. متابعة؟", { okText: "إلغاء الرابط", danger: true }))) return;
      run(btn, "جاري…", () => api(`/orders/${o.orderNumber}/revoke-link`, { body: {} }), "تم إلغاء الرابط.");
    } }));
    if (o.can.archive && ["DELIVERED", "CANCELLED", "FAILED"].includes(o.status)) put(acts, h("button", { type: "button", class: "btn ghost sm", text: o.archived ? "إلغاء الأرشفة" : "أرشفة", onclick: e => run(e.currentTarget, "جاري…", () => api(`/orders/${o.orderNumber}/archive`, { body: { archived: !o.archived } }), o.archived ? "أُعيد الطلب من الأرشيف." : "تمت أرشفة الطلب.") }));
    if (o.can.anonymize) put(acts, h("button", { type: "button", class: "btn danger sm", text: "حذف البيانات الشخصية", onclick: async e => {
      const btn = e.currentTarget, input = h("input", { placeholder: o.orderNumber, dir: "ltr" }), reason = h("input", { placeholder: "السبب (مثال: طلب العميل حذف بياناته)" });
      if (!(await confirmBox("حذف البيانات الشخصية للطلب", [h("p", { class: "warn-box", text: "لا يُحذف الطلب نفسه. يُمسح الاسم والجوال والعنوان نهائياً وتبقى المبالغ والسجل. لا يمكن التراجع." }), "اكتب رقم الطلب للتأكيد:", input, reason], { okText: "حذف البيانات", danger: true }))) return;
      run(btn, "جاري…", () => api(`/orders/${o.orderNumber}/anonymize`, { body: { confirm: input.value.trim().toUpperCase(), reason: reason.value } }), "تم حذف البيانات الشخصية.");
    } }));
    return card;
  }

  render();
}

/* ============================================================ سجل التدقيق */
const AUDIT = {
  login_success: "تسجيل دخول", login_failed: "محاولة دخول فاشلة", login_blocked_locked: "محاولة دخول أثناء القفل", login_mfa_failed: "رمز تحقق خاطئ",
  login_password_ok_mfa_required: "كلمة مرور صحيحة (بانتظار الرمز)", logout: "تسجيل خروج", setup_completed: "إعداد أول مدير عام",
  password_changed: "تغيير كلمة المرور", password_change_failed: "فشل تغيير كلمة المرور", two_factor_enabled: "تفعيل التحقق بخطوتين", two_factor_disabled: "إيقاف التحقق بخطوتين",
  admin_user_created: "إنشاء مشرف", admin_user_updated: "تعديل مشرف",
  order_status_changed: "تغيير حالة طلب", order_cancelled: "إلغاء طلب", bulk_status_update: "تحديث جماعي للحالات",
  order_customer_changed: "تعديل بيانات العميل", order_item_added: "إضافة منتج", order_item_removed: "حذف منتج", order_item_quantity_changed: "تغيير كمية",
  order_item_price_changed: "تغيير سعر", order_totals_recalculated: "إعادة حساب الإجمالي", order_note_added: "ملاحظة داخلية",
  order_archived: "أرشفة طلب", order_unarchived: "إلغاء أرشفة", order_link_revoked: "إلغاء رابط الطلب", order_anonymized: "حذف بيانات شخصية",
  orders_exported: "تصدير الطلبات", backup_downloaded: "تنزيل نسخة احتياطية"
};
const auditLabel = a => AUDIT[a] || a;
const KEY_AR = { status: "الحالة", note: "ملاحظة", visibility: "الظهور", override: "استثنائي", field: "الحقل", value: "القيمة", product: "المنتج", quantity: "الكمية",
  unitPrice: "سعر الوحدة", subtotal: "المجموع", discount: "الخصم", shipping: "الشحن", total: "الإجمالي", reason: "السبب", role: "الدور", username: "المستخدم",
  failures: "المحاولات", to: "إلى", requested: "المطلوب", updated: "تم تحديثه", orders: "الطلبات", skipped: "تُخطّي", tokenVersion: "إصدار الرابط", forcedAfter: "بعد حالة",
  rows: "عدد الصفوف", mfa: "تحقق بخطوتين", active: "نشط", unlocked: "فك القفل", passwordReset: "كلمة مرور مؤقتة", twoFactorReset: "إعادة ضبط التحقق", displayName: "الاسم" };
const FIELD_AR = { name: "الاسم", phone: "الجوال", city: "المدينة", district: "الحي", address: "العنوان", notes: "ملاحظات التوصيل" };
const VAL_AR = v => STATUS[v] || ROLE[v] || FIELD_AR[v] || { internal: "داخلية", customer: "يراها العميل", true: "نعم", false: "لا" }[String(v)] || v;
function auditDiff(oldV, newV) {
  const p = v => { try { return JSON.parse(v); } catch (_) { return v; } };
  const o = p(oldV), n = p(newV), fmt = v => v == null ? "" : typeof v === "object" ? Object.entries(v).filter(([k, x]) => x !== undefined && x !== null && x !== "" && k !== "filter").map(([k, x]) => `${KEY_AR[k] || k}: ${Array.isArray(x) ? x.map(VAL_AR).join("، ") : typeof x === "object" ? JSON.stringify(x) : VAL_AR(x)}`).join(" · ") : String(v);
  if (o == null && n == null) return null;
  return h("small", { class: "muted", style: null }, o != null ? h("span", { text: " قبل: " + fmt(o) }) : null, n != null ? h("span", { text: " · بعد: " + fmt(n) }) : null);
}

async function pageAudit() {
  const main = shell("audit");
  const P = new URLSearchParams(location.search), state = { q: P.get("q") || "", action: P.get("action") || "", page: Number(P.get("page") || 1) };
  const q = h("input", { type: "search", placeholder: "رقم طلب، مستخدم أو إجراء", value: state.q, "aria-label": "بحث" });
  const act = h("select", { "aria-label": "الإجراء" }, h("option", { value: "", text: "كل الإجراءات" }), Object.entries(AUDIT).map(([k, v]) => h("option", { value: k, text: v, selected: state.action === k })));
  const box = h("div"), pager = h("div", { class: "pager" });
  put(main, h("h1", { text: "سجل التدقيق" }), h("p", { class: "muted small", text: "كل الإجراءات الحساسة مسجلة ولا يمكن تعديلها أو حذفها." }),
    h("form", { class: "filters", onsubmit: e => { e.preventDefault(); state.q = q.value.trim(); state.action = act.value; state.page = 1; load(); } }, q, act, h("button", { type: "submit", class: "btn primary", text: "بحث" })), box, pager);
  async function load() {
    history.replaceState(null, "", "/admin/audit?" + new URLSearchParams(Object.entries(state).filter(([, v]) => v && v !== 1)).toString());
    let d; try { d = await api("/audit?" + new URLSearchParams({ q: state.q, action: state.action, page: state.page })); } catch (e) { if (e.message !== "unauthorized") box.textContent = errText(e); return; }
    box.textContent = "";
    put(box, d.entries.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["الوقت", "المستخدم", "الإجراء", "العنصر", "التفاصيل", "IP"].map(t => h("th", { text: t })))),
      h("tbody", null, d.entries.map(e => h("tr", null, h("td", { text: when(e.at) }), h("td", { text: e.by || "—" }), h("td", { text: auditLabel(e.action) }),
        h("td", null, e.entityType === "order" && e.entityId ? h("a", { href: "/admin/orders/" + e.entityId, "data-link": true, class: "num", text: e.entityId }) : (e.entityId || "")),
        h("td", { class: "wrap" }, auditDiff(e.old, e.new)), h("td", { class: "num small", text: e.ip || "" })))))) : h("div", { class: "empty", text: "لا توجد سجلات." }));
    const pages = Math.ceil(d.total / d.per); pager.textContent = "";
    put(pager, h("span", { class: "muted", text: `${fmtN(d.total)} سجل` }), h("span", { class: "row" },
      h("button", { type: "button", class: "btn ghost sm", text: "السابق", disabled: state.page <= 1, onclick: () => { state.page--; load(); } }),
      h("span", { class: "num", text: `${state.page} / ${Math.max(1, pages)}` }),
      h("button", { type: "button", class: "btn ghost sm", text: "التالي", disabled: state.page >= pages, onclick: () => { state.page++; load(); } })));
  }
  load();
}

/* ============================================================ العملاء والمنتجات */
async function pageCustomers() {
  const main = shell("customers");
  let page = 1;
  const q = h("input", { type: "search", placeholder: "الاسم أو الجوال", "aria-label": "بحث" }), box = h("div"), pager = h("div", { class: "pager" });
  put(main, h("h1", { text: "العملاء" }), h("p", { class: "muted small", text: "العملاء مجمّعون برقم الجوال من طلباتهم." }),
    h("form", { class: "filters", onsubmit: e => { e.preventDefault(); page = 1; load(); } }, q, h("button", { type: "submit", class: "btn primary", text: "بحث" })), box, pager);
  async function load() {
    let d; try { d = await api("/customers?" + new URLSearchParams({ q: q.value.trim(), page })); } catch (e) { if (e.message !== "unauthorized") box.textContent = errText(e); return; }
    box.textContent = "";
    put(box, d.customers.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["الاسم", "الجوال", "المدينة", "عدد الطلبات", "إجمالي المشتريات", "آخر طلب", ""].map(t => h("th", { text: t })))),
      h("tbody", null, d.customers.map(c => h("tr", null, h("td", { text: c.name }), h("td", { class: "num", text: c.phone }), h("td", { text: c.city }), h("td", { class: "num", text: c.orders }),
        h("td", { text: money(c.spent) }), h("td", { text: day(c.lastOrder) }), h("td", null, h("a", { class: "btn ghost sm", href: "/admin/orders?phone=" + c.phone, "data-link": true, text: "طلباته" }))))))) : h("div", { class: "empty", text: "لا يوجد عملاء." }));
    const pages = Math.ceil(d.total / d.per); pager.textContent = "";
    put(pager, h("span", { class: "muted", text: `${fmtN(d.total)} عميل` }), h("span", { class: "row" },
      h("button", { type: "button", class: "btn ghost sm", text: "السابق", disabled: page <= 1, onclick: () => { page--; load(); } }),
      h("button", { type: "button", class: "btn ghost sm", text: "التالي", disabled: page >= pages, onclick: () => { page++; load(); } })));
  }
  load();
}

async function pageProducts() {
  const main = shell("products", h("h1", { text: "المنتجات" }));
  let d; try { d = await api("/products"); } catch (e) { if (e.message !== "unauthorized") put(main, h("p", { class: "err", text: errText(e) })); return; }
  const p = d.pricing;
  put(main, h("p", { class: "note-box", text: "الأسعار والعروض تُقرأ من بيانات المنتج في الموقع نفسه (product-data في index.html)، والخادم يحسب الطلبات منها. تعديلها يكون هناك فقط." }),
    h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["المعرّف", "العرض", "البرنامج", "عدد العلب", "السعر", "المباع (لغير الملغي)"].map(t => h("th", { text: t })))),
      h("tbody", null, d.bundles.map(b => h("tr", null, h("td", { class: "num", text: b.id }), h("td", { text: b.title }), h("td", { text: b.program }), h("td", { class: "num", text: b.boxes }), h("td", { text: money(b.price) }), h("td", { class: "num", text: fmtN(b.sold) }))))))
    , h("section", { class: "card", style: null }, h("h2", { text: "قواعد التسعير والطلب" }), h("dl", { class: "kv" },
      h("dt", { text: "سعر العلبة فوق أكبر باقة" }), h("dd", { text: p.boxPriceAfterBundles ? money(p.boxPriceAfterBundles) : "—" }),
      h("dt", { text: "الحد الأقصى للعلب في الطلب" }), h("dd", { class: "num", text: p.maxBoxesPerOrder }),
      h("dt", { text: "الحد الأقصى لكل عرض" }), h("dd", { class: "num", text: p.maxQtyPerLine }),
      h("dt", { text: "الشحن" }), h("dd", { text: p.shippingCost ? money(p.shippingCost) : "مجاني" }),
      h("dt", { text: "طرق الدفع" }), h("dd", { text: p.paymentMethods.map(x => x === "cod" ? "الدفع عند الاستلام" : x).join("، ") }),
      h("dt", { text: "التوفر" }), h("dd", { text: p.inStock ? "متوفر — الطلبات مفتوحة" : "غير متوفر — الطلبات متوقفة" }))));
}

/* ============================================================ التقارير (رسوم بيانية بسلسلة واحدة لكل رسم) */
function columns(series, key, { title, fmt = fmtN } = {}) {
  const W = 720, H = 220, padL = 44, padB = 26, padT = 18, max = Math.max(1, ...series.map(s => s[key]));
  // محور بخطوات مستديرة (1 / 2 / 5 × 10ⁿ)
  const raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw))), tick = [1, 2, 5, 10].find(m => m * mag >= raw) * mag;
  const ticks = Math.max(1, Math.ceil(max / tick)), nice = ticks * tick;
  const bw = Math.min(24, (W - padL) / series.length - 2), step = (W - padL) / series.length;
  const ns = "http://www.w3.org/2000/svg", el = (t, a) => { const e = document.createElementNS(ns, t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); return e; };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": title });
  const grid = el("g", { class: "grid" }), axis = el("g", { class: "axis" });
  for (let i = 0; i <= ticks; i++) {
    const y = padT + (H - padT - padB) * (1 - i / ticks);
    grid.append(el("line", { x1: padL, x2: W, y1: y, y2: y }));
    const v = tick * i, t = el("text", { x: padL - 6, y: y + 4, "text-anchor": "end" });
    t.textContent = v >= 1000 ? (Math.round(v / 100) / 10) + "K" : String(Math.round(v * 10) / 10); axis.append(t);
  }
  svg.append(grid, axis);
  const wrap = h("div", { class: "chart" }), tip = h("div", { class: "tip", hidden: true });
  let peak = series.reduce((a, s, i) => s[key] > series[a][key] ? i : a, 0);
  series.forEach((s, i) => {
    const x = padL + i * step + (step - bw) / 2, hgt = (H - padT - padB) * s[key] / nice, y = H - padB - hgt;
    const r = Math.min(4, hgt / 2);
    // عمود بزاوية علوية مستديرة 4px وقاعدة مستقيمة
    const path = hgt > 0 ? `M${x},${H - padB} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H - padB} Z` : "";
    const hit = el("rect", { class: "hit", x: padL + i * step, y: padT, width: step, height: H - padT - padB });
    const bar = el("path", { class: "bar", d: path });
    const show = () => { tip.hidden = false; tip.textContent = `${s.date}: ${fmt(s[key])}`; tip.style.left = ((x + bw / 2) / W * 100) + "%"; tip.style.top = (y / H * 100) + "%"; };
    hit.addEventListener("mouseenter", show); hit.addEventListener("mouseleave", () => { tip.hidden = true; });
    svg.append(hit, bar);
    const every = Math.ceil(series.length / 8);
    // تاريخ كل بضعة أيام، وآخر يوم دائماً، بدون أن يتداخل مع التاريخ الذي قبله
    if ((i % every === 0 && series.length - 1 - i >= every / 2) || i === series.length - 1) {
      const t = el("text", { x: x + bw / 2, y: H - 8, "text-anchor": "middle" }); t.textContent = s.date.slice(5); axis.append(t);
    }
    if (i === peak && s[key] > 0) { const t = el("text", { class: "lbl", x: x + bw / 2, y: y - 5, "text-anchor": "middle" }); t.textContent = fmt(s[key]); svg.append(t); }
  });
  wrap.append(svg, tip);
  return wrap;
}
function hbars(rows, { label, value, fmt = fmtN }) {
  const max = Math.max(1, ...rows.map(value));
  return h("div", { class: "hbars" }, rows.map(r => h("div", { class: "hbar", title: `${label(r)}: ${fmt(value(r))}` },
    h("span", { text: label(r) }), h("span", { class: "track" }, h("span", { class: "fill", style: null, "data-w": value(r) / max })), h("b", { class: "num", text: fmt(value(r)) }))));
}
function dataTable(head, rows) {
  return h("details", { class: "data" }, h("summary", { text: "عرض البيانات كجدول" }), h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, head.map(t => h("th", { text: t })))), h("tbody", null, rows.map(r => h("tr", null, r.map(c => h("td", { text: c }))))))));
}
async function pageReports() {
  const main = shell("reports");
  const P = new URLSearchParams(location.search), days = P.get("days") || "30";
  const sel = h("select", { "aria-label": "الفترة" }, [["7", "آخر 7 أيام"], ["30", "آخر 30 يوماً"], ["90", "آخر 90 يوماً"]].map(([v, t]) => h("option", { value: v, text: t, selected: v === days })));
  sel.addEventListener("change", () => go("/admin/reports?days=" + sel.value));
  put(main, h("div", { class: "page-head" }, h("h1", { text: "التقارير" }), sel), h("p", { class: "muted", text: "جارٍ التحميل…" }));
  let d; try { d = await api("/reports?days=" + days); } catch (e) { if (e.message !== "unauthorized") main.lastChild.textContent = errText(e); return; }
  main.lastChild.remove();
  const T = d.totals, tile = (k, n, rev) => h("div", { class: "tile" }, h("span", { class: "k", text: k }), h("div", { class: "v num", text: fmtN(n) }), h("span", { class: "s", text: "الإيرادات: " + money(rev) }));
  put(main, h("div", { class: "tiles" }, tile("كل الطلبات", T.all.n, T.all.revenue), tile("اليوم", T.today.n, T.today.revenue), tile("آخر 7 أيام", T.week.n, T.week.revenue), tile("آخر 30 يوماً", T.month.n, T.month.revenue)),
    h("p", { class: "muted small", text: "الإيرادات لا تشمل الطلبات الملغاة أو المتعذّرة. المبالغ عند الاستلام (قبل التحصيل الفعلي)." }));
  const ordersChart = columns(d.series, "orders", { title: "الطلبات يومياً" }), revChart = columns(d.series, "revenue", { title: "الإيرادات يومياً", fmt: money });
  put(main, h("section", { class: "card" }, h("h2", { text: "الطلبات يومياً" }), ordersChart, dataTable(["اليوم", "الطلبات"], d.series.map(s => [s.date, s.orders]))),
    h("section", { class: "card" }, h("h2", { text: "الإيرادات يومياً (ر.س)" }), revChart, dataTable(["اليوم", "الإيرادات"], d.series.map(s => [s.date, money(s.revenue)]))));
  const st = ORDER.filter(s => d.byStatus[s]).map(s => ({ s, n: d.byStatus[s] }));
  const prods = d.products;
  put(main, h("div", { class: "o-grid" },
    h("section", { class: "card" }, h("h2", { text: "الطلبات حسب الحالة" }), st.length ? hbars(st, { label: r => STATUS[r.s], value: r => r.n }) : h("p", { class: "muted", text: "لا توجد طلبات في الفترة." })),
    h("section", { class: "card" }, h("h2", { text: "الأكثر مبيعاً (بعدد العلب)" }), prods.length ? hbars(prods, { label: r => r.name, value: r => r.boxes }) : h("p", { class: "muted", text: "لا توجد مبيعات في الفترة." }),
      prods.length ? dataTable(["المنتج", "الكمية", "العلب", "الإيرادات"], prods.map(p => [p.name, p.quantity, p.boxes, money(p.revenue)])) : null)));
  // عرض الأعمدة الأفقية بعد الإدراج (بدون أنماط مضمّنة في HTML)
  main.querySelectorAll(".fill[data-w]").forEach(f => { f.style.width = (Number(f.dataset.w) * 100) + "%"; });
}

/* ============================================================ المشرفون */
async function pageUsers() {
  const main = shell("users", h("h1", { text: "المشرفون" }));
  const box = h("div"); put(main, box);
  const load = async () => { let d; try { d = await api("/users"); } catch (e) { if (e.message !== "unauthorized") box.textContent = errText(e); return; } draw(d); };
  function draw(d) {
    box.textContent = "";
    put(box, h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["المستخدم", "الاسم", "الدور", "الحالة", "التحقق بخطوتين", "آخر دخول", "إجراءات"].map(t => h("th", { text: t })))),
      h("tbody", null, d.users.map(u => {
        const role = h("select", { "aria-label": "الدور", disabled: u.id === session.user.id }, d.roles.map(r => h("option", { value: r, text: ROLE[r], selected: u.role === r })));
        role.addEventListener("change", async () => {
          if (!(await confirmBox("تغيير الدور", `تغيير دور ${u.username} إلى «${ROLE[role.value]}»؟ سيُسجَّل خروجه من كل الأجهزة.`, { okText: "تغيير" }))) { role.value = u.role; return; }
          try { draw(await api(`/users/${u.id}`, { body: { role: role.value } })); toast("تم تغيير الدور."); } catch (e) { toast(errText(e), true); role.value = u.role; }
        });
        const act = (text, body, msg, danger) => h("button", { type: "button", class: "btn sm " + (danger ? "danger" : "ghost"), text, onclick: async e => {
          if (!(await confirmBox(text, msg, { okText: text, danger }))) return;
          await busy(e.currentTarget, "…", async () => { try { draw(await api(`/users/${u.id}`, { body })); toast("تم."); } catch (x) { toast(errText(x), true); } });
        } });
        return h("tr", null, h("td", { class: "num", text: u.username }), h("td", { text: u.displayName }), h("td", null, role),
          h("td", null, u.active ? "نشط" : "معطّل", u.locked ? h("span", { class: "tag", text: " مقفل مؤقتاً" }) : null, u.mustChangePassword ? h("span", { class: "tag", text: " كلمة مرور مؤقتة" }) : null),
          h("td", { text: u.twoFactor ? "مفعّل" : "غير مفعّل" }), h("td", { text: when(u.lastLogin) }),
          h("td", null, h("div", { class: "actions" },
            u.id !== session.user.id ? act(u.active ? "تعطيل" : "تفعيل", { active: !u.active }, u.active ? `تعطيل ${u.username}؟ سيُسجَّل خروجه فوراً.` : `تفعيل ${u.username}؟`, u.active) : null,
            u.locked ? act("فك القفل", { unlock: true }, `فك قفل ${u.username}؟`) : null,
            u.twoFactor && u.id !== session.user.id ? act("إعادة ضبط التحقق بخطوتين", { resetTwoFactor: true }, `إيقاف التحقق بخطوتين لـ ${u.username}؟ سيحتاج لتفعيله من جديد.`, true) : null,
            u.id !== session.user.id ? h("button", { type: "button", class: "btn ghost sm", text: "كلمة مرور مؤقتة", onclick: async () => {
              const pw = h("input", { type: "password", autocomplete: "new-password", placeholder: "12 حرفاً على الأقل" });
              if (!(await confirmBox("تعيين كلمة مرور مؤقتة", [h("p", { text: `سيُطلب من ${u.username} تغييرها عند الدخول، ويُسجَّل خروجه من كل الأجهزة.` }), pw], { okText: "تعيين", fields: pw }))) return;
              try { draw(await api(`/users/${u.id}`, { body: { password: pw.value } })); toast("تم تعيين كلمة المرور المؤقتة."); } catch (x) { toast(errText(x), true); }
            } }) : null)));
      })))));
    // حساب جديد
    const f = { username: h("input", { dir: "ltr", maxlength: 32, autocomplete: "off" }), displayName: h("input", { maxlength: 60 }), password: h("input", { type: "password", autocomplete: "new-password" }),
      role: h("select", null, d.roles.map(r => h("option", { value: r, text: ROLE[r], selected: r === "support_agent" }))) };
    const err = h("p", { class: "err", role: "alert" }), btn = h("button", { type: "button", class: "btn primary", text: "إنشاء الحساب" });
    btn.addEventListener("click", async () => {
      err.textContent = "";
      if (!(await confirmBox("إنشاء مشرف جديد", `إنشاء حساب ${f.username.value.trim()} بدور «${ROLE[f.role.value]}»؟`, { okText: "إنشاء" }))) return;
      await busy(btn, "جاري الإنشاء…", async () => {
        try { draw(await api("/users", { body: { username: f.username.value.trim(), displayName: f.displayName.value.trim(), password: f.password.value, role: f.role.value } })); toast("تم إنشاء الحساب. أعطِ كلمة المرور المؤقتة للمستخدم بشكل آمن."); }
        catch (e) { if (e.message !== "unauthorized") err.textContent = errText(e); }
      });
    });
    put(box, h("section", { class: "card", style: null }, h("h2", { text: "إضافة مشرف" }),
      h("div", { class: "grid2" }, h("label", { class: "f" }, "اسم المستخدم", f.username), h("label", { class: "f" }, "الاسم الظاهر", f.displayName),
        h("label", { class: "f" }, "الدور", f.role), h("label", { class: "f" }, "كلمة مرور مؤقتة", f.password, h("small", { text: "12 حرفاً على الأقل؛ يُطلب تغييرها عند أول دخول." }))),
      err, btn,
      h("p", { class: "muted small", text: "مدير عام: كل الصلاحيات. مدير الطلبات: الطلبات والتعديل والتحديث الجماعي والتقارير والتصدير. دعم العملاء: البحث والعرض والملاحظات وتأكيد الطلبات الجديدة أو تعليقها فقط." })));
  }
  load();
}

/* ============================================================ حسابي والإعدادات */
async function pageSettings() {
  const main = shell("settings", h("h1", { text: "حسابي والإعدادات" }));
  // كلمة المرور
  const cur = h("input", { type: "password", autocomplete: "current-password" }), nx = h("input", { type: "password", autocomplete: "new-password" }), nx2 = h("input", { type: "password", autocomplete: "new-password" });
  const perr = h("p", { class: "err", role: "alert" }), pbtn = h("button", { type: "button", class: "btn primary", text: "تغيير كلمة المرور" });
  pbtn.addEventListener("click", () => busy(pbtn, "جاري الحفظ…", async () => {
    perr.textContent = "";
    if (nx.value !== nx2.value) { perr.textContent = "كلمتا المرور غير متطابقتين."; return; }
    try { await api("/me/password", { body: { current: cur.value, next: nx.value } }); cur.value = nx.value = nx2.value = ""; toast("تم تغيير كلمة المرور، وسُجّل الخروج من الأجهزة الأخرى."); }
    catch (e) { if (e.message !== "unauthorized") perr.textContent = errText(e); }
  }));
  put(main, h("section", { class: "card" }, h("h2", { text: "كلمة المرور" }),
    h("div", { class: "grid2" }, h("label", { class: "f" }, "الحالية", cur), h("label", { class: "f" }, "الجديدة", nx, h("small", { text: "12 حرفاً على الأقل" })), h("label", { class: "f" }, "تأكيد الجديدة", nx2)), perr, pbtn));
  // التحقق بخطوتين
  const tf = h("section", { class: "card" }, h("h2", { text: "التحقق بخطوتين (تطبيق المصادقة)" }));
  put(main, tf);
  const drawTf = () => {
    tf.textContent = ""; put(tf, h("h2", { text: "التحقق بخطوتين (تطبيق المصادقة)" }));
    if (session.user.totpEnabled) {
      const pw = h("input", { type: "password", autocomplete: "current-password" }), code = h("input", { inputmode: "numeric", maxlength: 6, dir: "ltr" });
      const b = h("button", { type: "button", class: "btn danger", text: "إيقاف التحقق بخطوتين" });
      b.addEventListener("click", () => busy(b, "…", async () => {
        try { await api("/me/2fa/disable", { body: { password: pw.value, code: code.value.trim() } }); session.user.totpEnabled = false; toast("تم إيقاف التحقق بخطوتين."); drawTf(); }
        catch (e) { toast(errText(e), true); }
      }));
      put(tf, h("p", { class: "ok-msg", text: "✓ مفعّل. يُطلب رمز من تطبيق المصادقة عند كل دخول." }), h("div", { class: "grid2" }, h("label", { class: "f" }, "كلمة المرور", pw), h("label", { class: "f" }, "الرمز الحالي", code)), b);
      return;
    }
    const start = h("button", { type: "button", class: "btn primary", text: "تفعيل التحقق بخطوتين" });
    start.addEventListener("click", () => busy(start, "…", async () => {
      let r; try { r = await api("/me/2fa/start", { body: {} }); } catch (e) { toast(errText(e), true); return; }
      const qr = window.qrcode ? (() => { const q = window.qrcode(0, "M"); q.addData(r.otpauth); q.make(); return h("img", { src: q.createDataURL(5, 2), alt: "رمز QR لإعداد تطبيق المصادقة", width: 200, height: 200 }); })() : null;
      const code = h("input", { inputmode: "numeric", maxlength: 6, dir: "ltr", autocomplete: "one-time-code" }), ok = h("button", { type: "button", class: "btn primary", text: "تأكيد التفعيل" });
      ok.addEventListener("click", () => busy(ok, "…", async () => {
        try { await api("/me/2fa/enable", { body: { code: code.value.trim() } }); session.user.totpEnabled = true; toast("تم تفعيل التحقق بخطوتين."); drawTf(); }
        catch (e) { toast(errText(e), true); }
      }));
      tf.textContent = "";
      put(tf, h("h2", { text: "إعداد التحقق بخطوتين" }), h("p", { text: "1. امسح الرمز بتطبيق المصادقة (Google Authenticator أو Microsoft Authenticator)، أو أدخل المفتاح يدوياً:" }),
        qr, h("p", { class: "num", text: r.secret.replace(/(.{4})/g, "$1 ").trim() }), h("p", { text: "2. اكتب الرمز المكوّن من 6 أرقام الظاهر في التطبيق:" }), code, h("div", { class: "row" }, ok));
      code.focus();
    }));
    put(tf, h("p", { class: "muted", text: "يضيف حماية قوية: حتى لو عُرفت كلمة المرور لا يمكن الدخول بدون الرمز من جوالك." }), start);
  };
  drawTf();
  // النسخ الاحتياطي
  if (can("settings.manage")) put(main, h("section", { class: "card" }, h("h2", { text: "النسخ الاحتياطي والاستعادة" }),
    h("p", { text: "قاعدة البيانات (Cloudflare D1) تحتفظ تلقائياً بإمكانية الاستعادة لأي لحظة خلال آخر 7 أيام (Time Travel)." }),
    h("p", { text: "ننصح بتنزيل نسخة كاملة أسبوعياً وحفظها في مكان آمن (لا تحتوي كلمات المرور أو مفاتيح التحقق)." }),
    h("a", { class: "btn primary", href: "/admin/api/backup", download: "", text: "تنزيل نسخة احتياطية كاملة (JSON)" })));
}

/* ============================================================ البداية */
route();
})();

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
  validation: "تحقق من البيانات المدخلة.", not_found: "غير موجود.", password_change_required: "يجب تغيير كلمة المرور أولاً.",
  insufficient_stock: "المخزون المتوفر لا يكفي لهذه العملية.", reservation_mismatch: "كمية الحجز لا تطابق الطلب. حدّث الصفحة.",
  delivered_inventory_locked: "لا يمكن تغيير كمية طلب تم تسليمه. أعده أولاً بتغيير استثنائي للحالة.", not_initialized: "سجّل الرصيد الافتتاحي للمخزون أولاً.",
  already_initialized: "الرصيد الافتتاحي مسجّل مسبقاً.", opening_stock_too_small: "الرصيد الافتتاحي أقل من الطلبات المُسلَّمة.",
  adjustment_exceeds_available: "لا يمكن إنقاص أكثر من المتوفر غير المحجوز.", cost_already_set: "تكلفة هذه الدفعة مسجّلة مسبقاً.",
  no_shortage: "لا يوجد نقص في هذا الطلب.", order_not_open: "الطلب ليس مفتوحاً.", already_voided: "السجل ملغي مسبقاً.", record_changed: "عدّل شخص آخر هذا السجل للتو. حدّث الصفحة وراجع القيم قبل الحفظ.",
  expense_voided: "لا يمكن تعديل مصروف ملغي.", purchase_voided: "لا يمكن تعديل شراء ملغي.", not_a_purchase: "هذه الدفعة تسوية وليست شراء؛ صحّحها بتسوية معاكسة.",
  opening_cannot_void: "لا يُلغى الرصيد الافتتاحي؛ عدّل كميته أو سعره.", purchase_used: "لا يمكن إلغاء شراء استُخدم منه؛ عدّل كميته.",
  quantity_below_used: "لا يمكن أن تقل الكمية عن المستخدم منها.", edit_exceeds_available: "لا يمكن إنقاص المخزون بهذا القدر: الباقي محجوز لطلبات مفتوحة.", catalog_unavailable: "تعذّر قراءة أسعار الموقع الآن. حاول بعد قليل."
};
const errText = e => (e && e.data && e.data.error === "validation" && e.data.fields && e.data.fields.reason) ? "اكتب سبب تغيير السعر."
  : e && e.message === "inventory_shortage" ? `لا يمكن تسليم الطلب: ينقصه ${e.data.shortage} علبة في المخزون. خصّص المخزون أولاً (المخزون ← طلبات النقص).`
  : ERR[e && e.message] || "تعذّر تنفيذ العملية. حاول مرة أخرى.";

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
  inventory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9 12 4l9 5v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9Z"/><path d="M8 20v-7h8v7M8 16h8"/></svg>',
  expenses: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>'
};
const NAV_LABEL = { dashboard: "لوحة المعلومات", orders: "الطلبات", inventory: "المخزون", expenses: "المصاريف والأرباح", customers: "العملاء", products: "المنتجات", reports: "التقارير", audit: "سجل التدقيق", users: "المشرفون", settings: "حسابي والإعدادات" };

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
  if (path === "/admin/orders/new") return can("orders.create") ? pageNewOrder() : go("/admin/orders", true);
  if (path === "/admin/orders/import") return can("orders.create") ? pageImportOrders() : go("/admin/orders", true);
  const m = path.match(/^\/admin\/orders\/([A-Za-z0-9-]+)$/);
  if (m) return pageOrder(m[1]);
  const page = path.split("/")[2] || "";
  const pages = { dashboard: pageDashboard, orders: pageOrders, inventory: pageInventory, expenses: pageExpenses, customers: pageCustomers, products: pageProducts, reports: pageReports, audit: pageAudit, users: pageUsers, settings: pageSettings };
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

/* ============================================================ فلتر المدينة (مشترك) */
// المدينة يكتبها العميل بحرية؛ الخادم يجمع طرق الكتابة المختلفة (الرياض / رياض / Riyadh) تحت مفتاح واحد
let citiesCache = null;            // { at, list } — refreshed every minute so cities from new orders appear without reloading
async function cityOptions() {
  if (!citiesCache || Date.now() - citiesCache.at > 60000) {
    try { citiesCache = { at: Date.now(), list: (await api("/cities")).cities }; } catch (e) { if (e.message === "unauthorized") throw e; return citiesCache ? citiesCache.list : []; }
  }
  return citiesCache.list;
}
function citySelect(current, onChange) {
  const sel = h("select", { "aria-label": "المدينة", class: "city-filter" }, h("option", { value: "", text: "كل المدن" }));
  if (current) sel.append(h("option", { value: current, text: "…", selected: true }));
  cityOptions().then(list => {
    sel.textContent = "";
    put(sel, h("option", { value: "", text: "كل المدن" }), list.map(c => h("option", { value: c.key, text: `${c.name} (${fmtN(c.orders)})`, selected: c.key === current })));
    if (current && !list.some(c => c.key === current)) sel.append(h("option", { value: current, text: "مدينة بدون طلبات", selected: true }));
  }).catch(() => {});
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}
const cityName = async key => { const c = (await cityOptions()).find(x => x.key === key); return c ? c.name : ""; };
const withCity = (path, city) => city ? path + (path.includes("?") ? "&" : "?") + "city=" + encodeURIComponent(city) : path;

/* ============================================================ لوحة المعلومات */
async function pageDashboard() {
  const city = new URLSearchParams(location.search).get("city") || "";
  const head = h("div", { class: "page-head" }, h("h1", { text: "لوحة المعلومات" }), citySelect(city, v => go(withCity("/admin/dashboard", v))));
  const main = shell("dashboard", head, h("p", { class: "muted", text: "جارٍ التحميل…" }));
  let d; try { d = await api(withCity("/dashboard", city)); } catch (e) { if (e.message !== "unauthorized") main.lastChild.textContent = errText(e); return; }
  const s = d.byStatus, tile = (k, v, link, hint) => h("a", { class: "tile", href: withCity(link, city), "data-link": true }, h("span", { class: "k", text: k }), h("div", { class: "v num", text: fmtN(v) }), hint ? h("span", { class: "s", text: hint }) : null);
  main.textContent = "";
  const note = city ? h("p", { class: "note-box" }, "معروض لمدينة: ", h("b", { class: "js-city-name", text: "…" }), " · ", h("a", { href: "/admin/dashboard", "data-link": true, text: "عرض كل المدن" })) : null;
  if (note) cityName(city).then(n => { note.querySelector(".js-city-name").textContent = n || "مدينة بدون طلبات"; });
  put(main, head, note,
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
    d.inventory ? h("section", { class: "card" }, h("div", { class: "page-head" }, h("h2", { text: "المخزون" }), h("div", { class: "row" }, can("inventory.purchase.create") && d.inventory.initialized ? h("a", { class: "btn primary sm", href: "/admin/inventory?tab=receive", "data-link": true, text: "+ إضافة مخزون" }) : null,
        h("a", { class: "btn ghost sm", href: "/admin/inventory", "data-link": true, text: "إدارة المخزون" }))),
      stockTiles(d.inventory, { onAck: async id => { try { await api(`/inventory/alerts/${id}/ack`, { body: {} }); pageDashboard(); } catch (e) { toast(errText(e), true); } } })) : null,
    h("section", { class: "card" }, h("h2", { text: "أحدث الطلبات" }), orderTable(d.latest, { selectable: false })));
  if (can("finance.view")) financeSection(main);
  if (!city) document.title = (s.RECEIVED ? `(${s.RECEIVED}) ` : "") + "إدارة CalmGastro";
}

/* ============================================================ الطلبات */
const selected = new Set();          // التحديد يبقى عند التنقل بين الصفحات
function orderTable(orders, { selectable, onToggle } = {}) {
  if (!orders.length) return h("div", { class: "empty", text: "لا توجد طلبات مطابقة." });
  const all = selectable ? h("input", { type: "checkbox", "aria-label": "تحديد طلبات هذه الصفحة", checked: orders.every(o => selected.has(o.orderNumber)) }) : null;
  if (all) all.addEventListener("change", () => { orders.forEach(o => all.checked ? selected.add(o.orderNumber) : selected.delete(o.orderNumber)); onToggle && onToggle(); });
  return h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, selectable ? h("th", { class: "sel" }, all) : null,
      ["رقم الطلب", "العميل", "الجوال", "المدينة", "التاريخ", "الإجمالي", "الدفع", "الحالة", "آخر تحديث", ""].map(t => h("th", { text: t })))),
    h("tbody", null, orders.map(o => {
      const cb = selectable ? h("input", { type: "checkbox", "aria-label": "تحديد " + o.orderNumber, checked: selected.has(o.orderNumber) }) : null;
      if (cb) cb.addEventListener("change", () => { cb.checked ? selected.add(o.orderNumber) : selected.delete(o.orderNumber); onToggle && onToggle(); });
      return h("tr", null, selectable ? h("td", { class: "sel" }, cb) : null,
        h("td", null, h("a", { href: "/admin/orders/" + o.orderNumber, "data-link": true, class: "num", text: o.orderNumber })),
        h("td", { text: o.customerName }), h("td", { class: "num", text: o.phone || "" }), h("td", { text: o.city || "" }), h("td", { text: when(o.createdAt) }),
        h("td", { text: money(o.total) }), h("td", { text: o.paymentMethod === "cod" || !o.paymentMethod ? "عند الاستلام" : o.paymentMethod }),
        h("td", null, badge(o.status), o.archived ? h("span", { class: "tag", text: " مؤرشف" }) : null,
          o.source === "ADMIN" ? h("span", { class: "tag cust", text: " لوحة التحكم" }) : null, o.inventoryStatus === "SHORTAGE" ? h("span", { class: "inv inv-SHORTAGE", text: "نقص مخزون" }) : null),
        h("td", { text: o.updatedAt ? when(o.updatedAt) : "" }),
        h("td", null, h("a", { class: "btn ghost sm", href: "/admin/orders/" + o.orderNumber, "data-link": true, text: "عرض" })));
    }))));
}

async function pageOrders() {
  const P = new URLSearchParams(location.search);
  const main = shell("orders");
  const state = { q: P.get("q") || "", status: P.get("status") || "", payment: P.get("payment") || "", range: P.get("range") || "", from: P.get("from") || "", to: P.get("to") || "",
                  archived: P.get("archived") || "", phone: P.get("phone") || "", city: P.get("city") || "", per: P.get("per") || "25", page: P.get("page") || "1",
                  source: P.get("source") || "", inv: P.get("inv") || "", pay: P.get("pay") || "" };
  const qs = (extra = {}) => { const u = new URLSearchParams(); Object.entries({ ...state, ...extra }).forEach(([k, v]) => { if (v && !(k === "per" && v === "25") && !(k === "page" && v === "1")) u.set(k, v); }); return u.toString(); };
  const reload = (extra = {}) => { Object.assign(state, extra); history.replaceState(null, "", "/admin/orders" + (qs() ? "?" + qs() : "")); load(); };

  const q = h("input", { type: "search", placeholder: "رقم الطلب، اسم العميل أو الجوال", "aria-label": "بحث", value: state.q });
  const st = h("select", { "aria-label": "الحالة" }, h("option", { value: "", text: "كل الحالات" }), h("option", { value: "OPEN", text: "الطلبات المفتوحة" }),
    ORDER.map(s => h("option", { value: s, text: STATUS[s], selected: state.status === s })));
  if (state.status === "OPEN") st.value = "OPEN";
  const pay = h("select", { "aria-label": "طريقة الدفع" }, h("option", { value: "", text: "كل طرق الدفع" }), h("option", { value: "cod", text: "الدفع عند الاستلام", selected: state.payment === "cod" }));
  const city = citySelect(state.city, () => apply());
  const range = h("select", { "aria-label": "الفترة" }, [["", "كل التواريخ"], ["today", "اليوم"], ["yesterday", "أمس"], ["7d", "آخر 7 أيام"], ["30d", "آخر 30 يوماً"], ["custom", "فترة مخصصة"]]
    .map(([v, t]) => h("option", { value: v, text: t, selected: (state.range || (state.from || state.to ? "custom" : "")) === v })));
  const from = h("input", { type: "date", "aria-label": "من تاريخ", value: state.from }), to = h("input", { type: "date", "aria-label": "إلى تاريخ", value: state.to });
  const custom = h("span", { class: "row" }, "من", from, "إلى", to);
  const arch = h("select", { "aria-label": "الأرشيف" }, [["", "غير المؤرشفة"], ["1", "المؤرشفة"], ["all", "الكل"]].map(([v, t]) => h("option", { value: v, text: t, selected: state.archived === v })));
  const srcSel = h("select", { "aria-label": "مصدر الطلب" }, [["", "كل المصادر"], ["WEBSITE", "الموقع"], ["ADMIN", "لوحة التحكم"]].map(([v, t]) => h("option", { value: v, text: t, selected: state.source === v })));
  const invSel = h("select", { "aria-label": "حالة المخزون" }, [["", "كل حالات المخزون"], ["RESERVED", "محجوز"], ["SHORTAGE", "نقص مخزون"], ["COMMITTED", "مُستهلك"], ["RELEASED", "أُلغي الحجز"]].map(([v, t]) => h("option", { value: v, text: t, selected: state.inv === v })));
  const paySel = h("select", { "aria-label": "حالة الدفع" }, [["", "كل حالات الدفع"], ["collected", "تم التحصيل"], ["outstanding", "لم يُحصَّل بعد"]].map(([v, t]) => h("option", { value: v, text: t, selected: state.pay === v })));
  const per = h("select", { "aria-label": "عدد الطلبات في الصفحة" }, ["25", "50", "100"].map(v => h("option", { value: v, text: v + " في الصفحة", selected: state.per === v })));
  const showCustom = () => { custom.hidden = range.value !== "custom"; };
  showCustom();
  const apply = () => reload({ q: q.value.trim(), status: st.value, payment: pay.value, city: city.value, range: range.value === "custom" ? "" : range.value,
    from: range.value === "custom" ? from.value : "", to: range.value === "custom" ? to.value : "", archived: arch.value, per: per.value, page: "1",
    source: srcSel.value, inv: invSel.value, pay: paySel.value });
  const form = h("form", { class: "filters", onsubmit: e => { e.preventDefault(); apply(); } }, q, st, pay, city, range, custom, srcSel, invSel, paySel, arch, per,
    h("button", { type: "submit", class: "btn primary", text: "بحث" }),
    h("button", { type: "button", class: "btn ghost", text: "مسح", onclick: () => { selected.clear(); history.replaceState(null, "", "/admin/orders"); pageOrders(); } }));
  [st, pay, arch, per, srcSel, invSel, paySel].forEach(x => x.addEventListener("change", apply));
  range.addEventListener("change", () => { showCustom(); if (range.value !== "custom") apply(); });   // الفترات الجاهزة تُطبّق فوراً

  const exportBtn = can("orders.export") ? h("a", { class: "btn ghost", text: "تصدير CSV / Excel", href: "#", onclick: e => { e.currentTarget.href = "/admin/api/orders/export.csv" + (qs({ page: "", per: "" }) ? "?" + qs({ page: "", per: "" }) : ""); } , download: "" }) : null;
  const bulk = h("div", { class: "bulkbar", hidden: true });
  const chips = h("div", { class: "chips" });
  const list = h("div", null, h("p", { class: "muted", text: "جارٍ التحميل…" }));
  const pager = h("div", { class: "pager" });
  const newBtn = can("orders.create") ? [h("a", { class: "btn primary", href: "/admin/orders/new", "data-link": true, text: "+ طلب جديد" }),
    h("a", { class: "btn ghost", href: "/admin/orders/import", "data-link": true, text: "إدخال عدة طلبات" })] : null;
  put(main, h("div", { class: "page-head" }, h("h1", { text: "الطلبات" }), h("div", { class: "row" }, newBtn, exportBtn)), state.phone ? h("p", { class: "note-box" }, "طلبات العميل ", h("span", { class: "num", text: state.phone }), " ", h("a", { href: "/admin/orders", "data-link": true, text: "عرض كل الطلبات" })) : null,
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
      h("dt", { text: "المصدر" }), h("dd", null, h("span", { class: "tag" + (o.source === "ADMIN" ? " cust" : ""), text: SOURCE[o.source] || o.source })),
      o.source === "ADMIN" ? [h("dt", { text: "أنشأه" }), h("dd", { text: o.createdBy })] : null,
      h("dt", { text: "طريقة الدفع" }), h("dd", { text: o.paymentMethod === "cod" ? "الدفع عند الاستلام" : o.paymentMethod }),
      h("dt", { text: "حالة الدفع" }), h("dd", { text: { COLLECTED: `تم التحصيل (${money(o.payment.collected)})`, PENDING: `لم يُحصَّل بعد — المستحق ${money(o.payment.outstanding)}`, NONE: "لا شيء مستحق" }[o.payment.status] }),
      h("dt", { text: "المجموع الفرعي" }), h("dd", { text: money(o.subtotal) }),
      o.discount - (o.manualDiscount || 0) ? [h("dt", { text: "خصم الباقات" }), h("dd", { text: "− " + money(o.discount - (o.manualDiscount || 0)) })] : null,
      o.manualDiscount ? [h("dt", { text: "خصم يدوي" }), h("dd", { text: `− ${money(o.manualDiscount)} (${o.manualDiscountReason})` })] : null,
      h("dt", { text: "الشحن" }), h("dd", { text: o.shipping ? money(o.shipping) : "مجاني" }),
      h("dt", { text: "الإجمالي" }), h("dd", null, h("b", { text: money(o.total) })),
      h("dt", { text: "لغة العميل" }), h("dd", { text: o.lang === "en" ? "الإنجليزية" : "العربية" }))));

    /* المنتجات */
    put(left, itemsCard());
    /* العميل */
    put(left, customerCard(c));
    /* الحالة */
    put(right, statusCard());
    /* المخزون */
    put(right, orderInventoryCard(o, async () => refresh(await api("/orders/" + o.orderNumber))));
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
  orders_exported: "تصدير الطلبات", backup_downloaded: "تنزيل نسخة احتياطية",
  order_created_by_admin: "طلب من لوحة التحكم", expense_created: "إضافة مصروف", expense_edited: "تعديل مصروف", expense_voided: "إلغاء مصروف",
  stock_received: "إضافة مخزون (شراء)", purchase_edited: "تعديل شراء مخزون", purchase_voided: "إلغاء شراء مخزون", batch_cost_set: "إدخال تكلفة دفعة",
  stock_adjusted: "تسوية مخزون", inventory_initialized: "الرصيد الافتتاحي", inventory_settings_changed: "إعدادات المخزون", shortage_allocated: "حجز لطلب نقص"
};
const auditLabel = a => AUDIT[a] || a;
const KEY_AR = { status: "الحالة", note: "ملاحظة", visibility: "الظهور", override: "استثنائي", field: "الحقل", value: "القيمة", product: "المنتج", quantity: "الكمية",
  unitPrice: "سعر الوحدة", subtotal: "المجموع", discount: "الخصم", shipping: "الشحن", total: "الإجمالي", reason: "السبب", role: "الدور", username: "المستخدم",
  failures: "المحاولات", to: "إلى", requested: "المطلوب", updated: "تم تحديثه", orders: "الطلبات", skipped: "تُخطّي", tokenVersion: "إصدار الرابط", forcedAfter: "بعد حالة",
  rows: "عدد الصفوف", mfa: "تحقق بخطوتين", active: "نشط", unlocked: "فك القفل", passwordReset: "كلمة مرور مؤقتة", twoFactorReset: "إعادة ضبط التحقق", displayName: "الاسم",
  amount: "المبلغ", category: "الفئة", date: "التاريخ", description: "الوصف", orderNumber: "الطلب", platform: "المنصة", campaign: "الحملة", reference: "المرجع",
  paymentMethod: "طريقة الدفع", notes: "ملاحظات", version: "الإصدار", batch: "الدفعة", receivedDate: "تاريخ الشراء", quantityOrdered: "الكمية في الفاتورة",
  supplier: "المورد", location: "الموقع", unitCost: "سعر الوحدة", totalCost: "الإجمالي (ر.س)", newOnHand: "الموجود بعد", onHand: "الموجود" };
const FIELD_AR = { name: "الاسم", phone: "الجوال", city: "المدينة", district: "الحي", address: "العنوان", notes: "ملاحظات التوصيل" };
const VAL_AR = v => STATUS[v] || ROLE[v] || FIELD_AR[v] || { DELIVERY: "التوصيل والشحن", ADVERTISING: "الإعلانات", OTHER: "أخرى" }[v] || { internal: "داخلية", customer: "يراها العميل", true: "نعم", false: "لا" }[String(v)] || v;
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
        h("td", null, e.entityType === "order" && e.entityId ? h("a", { href: "/admin/orders/" + e.entityId, "data-link": true, class: "num", text: e.entityId })
          : e.entityType === "expense" && e.entityId ? "مصروف #" + e.entityId : e.entityType === "inventory_batch" && e.entityId ? "شراء (دفعة) #" + e.entityId : (e.entityId || "")),
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
  const P = new URLSearchParams(location.search), days = P.get("days") || "30", city = P.get("city") || "", stv = P.get("st") || "valid";
  const link = (dd, c, s = stv) => withCity("/admin/reports?days=" + dd + (s && s !== "valid" ? "&st=" + s : ""), c);
  const sel = h("select", { "aria-label": "الفترة" }, [["7", "آخر 7 أيام"], ["30", "آخر 30 يوماً"], ["90", "آخر 90 يوماً"]].map(([v, t]) => h("option", { value: v, text: t, selected: v === days })));
  sel.addEventListener("change", () => go(link(sel.value, city)));
  // حالة الطلبات المحسوبة في التقارير: الافتراضي يستبعد الملغاة والمتعذّرة (الطلبات التجريبية الملغاة لا تظهر)
  const stSel = h("select", { "aria-label": "حالة الطلبات" },
    h("optgroup", { label: "مجموعات" }, [["valid", "بدون الملغاة والمتعذّرة"], ["delivered", "المُسلَّمة فقط"], ["open", "المفتوحة (قيد التنفيذ)"], ["all", "كل الحالات (مع الملغاة)"]]
      .map(([v, t]) => h("option", { value: v, text: t, selected: v === stv }))),
    h("optgroup", { label: "حالة واحدة" }, ORDER.map(s => h("option", { value: s, text: STATUS[s], selected: s === stv }))));
  stSel.addEventListener("change", () => go(link(days, city, stSel.value)));
  put(main, h("div", { class: "page-head" }, h("h1", { text: "التقارير" }), h("div", { class: "row" }, stSel, citySelect(city, v => go(link(days, v))), sel,
      can("finance.view") ? h("a", { class: "btn ghost sm", href: "#spending", text: "الإيرادات والمصروفات والربح ↓", onclick: e => { e.preventDefault(); const t = $("#spending"); if (t) t.scrollIntoView({ behavior: "smooth" }); } }) : null)),
    h("p", { class: "muted", text: "جارٍ التحميل…" }));
  let d; try { d = await api(withCity("/reports?days=" + days + (stv !== "valid" ? "&st=" + encodeURIComponent(stv) : ""), city)); } catch (e) { if (e.message !== "unauthorized") main.lastChild.textContent = errText(e); return; }
  main.lastChild.remove();
  if (city) {
    const sc = d.cities.find(c => c.key === city);
    put(main, h("p", { class: "note-box" }, "التقارير معروضة لمدينة: ", h("b", { text: sc ? sc.name : (await cityName(city)) || "مدينة بدون طلبات" }), " · ",
      h("a", { href: link(days, ""), "data-link": true, text: "عرض كل المدن" })));
  }
  const T = d.totals, tile = (k, n, rev) => h("div", { class: "tile" }, h("span", { class: "k", text: k }), h("div", { class: "v num", text: fmtN(n) }), h("span", { class: "s", text: "الإيرادات: " + money(rev) }));
  put(main, h("div", { class: "tiles" }, tile("كل الطلبات", T.all.n, T.all.revenue), tile("اليوم", T.today.n, T.today.revenue), tile("آخر 7 أيام", T.week.n, T.week.revenue), tile("آخر 30 يوماً", T.month.n, T.month.revenue)),
    h("p", { class: "muted small", text: `معروض: ${(d.statusOptions.find(o => o.key === d.status) || {}).label || STATUS[d.status] || d.status}. الإيرادات لا تشمل الملغاة أو المتعذّرة أبداً. اختر «المُسلَّمة فقط» لإيرادات الطلبات التي تم توصيلها فعلاً (الدفع عند الاستلام).` }));
  const ordersChart = columns(d.series, "orders", { title: "الطلبات يومياً" }), revChart = columns(d.series, "revenue", { title: "الإيرادات يومياً", fmt: money });
  put(main, h("section", { class: "card" }, h("h2", { text: "الطلبات يومياً" }), ordersChart, dataTable(["اليوم", "الطلبات"], d.series.map(s => [s.date, s.orders]))),
    h("section", { class: "card" }, h("h2", { text: "الإيرادات يومياً (ر.س)" }), revChart, dataTable(["اليوم", "الإيرادات"], d.series.map(s => [s.date, money(s.revenue)]))));
  const st = ORDER.filter(s => d.byStatus[s]).map(s => ({ s, n: d.byStatus[s] }));
  const prods = d.products;
  put(main, h("div", { class: "o-grid" },
    h("section", { class: "card" }, h("h2", { text: "الطلبات حسب الحالة" }), st.length ? hbars(st, { label: r => STATUS[r.s], value: r => r.n }) : h("p", { class: "muted", text: "لا توجد طلبات في الفترة." })),
    h("section", { class: "card" }, h("h2", { text: "الأكثر مبيعاً (بعدد العلب)" }), prods.length ? hbars(prods, { label: r => r.name, value: r => r.boxes }) : h("p", { class: "muted", text: "لا توجد مبيعات في الفترة." }),
      prods.length ? dataTable(["المنتج", "الكمية", "العلب", "الإيرادات"], prods.map(p => [p.name, p.quantity, p.boxes, money(p.revenue)])) : null)));
  // كل المدن في الفترة (لا يضيّقها فلتر المدينة) للمقارنة؛ الضغط على مدينة يعرض تقاريرها
  const cities = d.cities, totalN = cities.reduce((a, x) => a + x.orders, 0), PERIOD = { 7: "آخر 7 أيام", 30: "آخر 30 يوماً", 90: "آخر 90 يوماً" }[days] || "";
  put(main, h("section", { class: "card" }, h("h2", { text: `الطلبات حسب المدينة (${PERIOD})` }),
    cities.length ? [
      hbars(cities.slice(0, 12), { label: r => r.name, value: r => r.orders }),
      cities.length > 12 ? h("p", { class: "muted small", text: `أعلى 12 مدينة من ${fmtN(cities.length)}. الجدول أدناه فيه كل المدن.` }) : null,
      h("div", { class: "table-wrap" }, h("table", { class: "city-table" },
        h("thead", null, h("tr", null, ["المدينة", "الطلبات", "العلب", "الإيرادات", "النسبة من الطلبات"].map(t => h("th", { text: t })))),
        h("tbody", null, cities.map(c => {
          return h("tr", { "aria-current": c.key === city ? "true" : null },
            h("td", null, h("a", { href: link(days, c.key), "data-link": true, text: c.name })), h("td", { class: "num", text: fmtN(c.orders) }),
            h("td", { class: "num", text: fmtN(c.boxes) }), h("td", { text: money(c.revenue) }), h("td", { class: "num", text: Math.round(c.orders / Math.max(1, totalN) * 100) + "%" }));
        }))))
    ] : h("p", { class: "muted", text: "لا توجد طلبات في الفترة." })));
  // عرض الأعمدة الأفقية بعد الإدراج (بدون أنماط مضمّنة في HTML)
  main.querySelectorAll(".fill[data-w]").forEach(f => { f.style.width = (Number(f.dataset.w) * 100) + "%"; });
  if (can("finance.view")) { spendingSection(main); if (location.hash === "#spending") $("#spending").scrollIntoView(); }
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
/* ============================================================ المخزون والمصاريف والأرباح */
const sarF = n => n == null ? "—" : `${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })} ر.س`;
const INV = { RESERVED: "محجوز", SHORTAGE: "نقص مخزون", COMMITTED: "مُستهلك (تم التسليم)", RELEASED: "أُلغي الحجز" };
const invBadge = s => s ? h("span", { class: "inv inv-" + s, text: INV[s] || s }) : h("span", { class: "muted small", text: "—" });
const LEVEL = { NONE: "طبيعي", LOW: "مخزون منخفض", CRITICAL: "مخزون حرج", OUT: "نفد المخزون" };
const TX = { OPENING_BALANCE: "رصيد افتتاحي", PURCHASE_RECEIPT: "استلام مخزون", RESERVATION: "حجز لطلب", RELEASE: "إلغاء حجز", SALE: "بيع (تسليم)",
  ADJUSTMENT: "تسوية يدوية", RETURN: "مرتجع إلى المخزون", WRITE_OFF: "شطب", COST_UPDATE: "تحديث تكلفة" };
const SOURCE = { WEBSITE: "الموقع", ADMIN: "لوحة التحكم" };
const ADJ = { DAMAGED: "تالف", EXPIRED: "منتهي الصلاحية", COUNT_CORRECTION: "تصحيح جرد", LOST: "مفقود", FOUND: "وجدنا وحدات إضافية", OTHER: "سبب آخر" };
const PLATFORM = { META: "Meta (فيسبوك/إنستغرام)", GOOGLE: "Google", TIKTOK: "TikTok", SNAPCHAT: "Snapchat", OTHER: "أخرى" };
const SETTING_LABEL = { RESERVE_AVAILABLE: "احجز المتوفر وسجّل الباقي نقصاً", RESERVE_NONE: "لا تحجز شيئاً إن لم يكتمل الطلب", RESTOCK: "يعود للمخزون بنفس التكلفة",
  WRITE_OFF: "يُشطب (لا يعود للبيع)", FIFO: "الوارد أولاً يُصرف أولاً (FIFO)", ON_ORDER_CREATED: "عند استلام الطلب" };
const reqId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9-]/g, "");
const todayRiyadh = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
// the unit (علبة / ر.س) is shown small next to the number instead of in the large digits font
const tileValue = v => { const m = String(v).match(/^(.*?)\s(علبة|ر\.س)$/); return m ? h("div", { class: "v num" }, m[1], " ", h("small", { class: "u", text: m[2] })) : h("div", { class: "v num", text: v }); };
const tile2 = (k, v, s, cls) => h("div", { class: "tile" + (cls ? " " + cls : "") }, h("span", { class: "k", text: k }), tileValue(v), s ? h("span", { class: "s", text: s }) : null);
const tbl = (head, rows) => rows.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, head.map(t => h("th", { text: t })))),
  h("tbody", null, rows.map(r => h("tr", null, r.map(c => c instanceof Node ? h("td", null, c) : h("td", { text: c == null ? "—" : String(c) }))))))) : h("div", { class: "empty", text: "لا توجد بيانات." });
const fieldErr = e => e && e.data && e.data.fields ? Object.entries(e.data.fields).map(([k, v]) => `${k}: ${v}`).join(" · ") : errText(e);

/* بطاقة المخزون (لوحة المعلومات + صفحة المخزون) */
function stockTiles(s, { onAck } = {}) {
  if (!s || !s.initialized) return h("div", { class: "note-box" }, "لم يُسجَّل الرصيد الافتتاحي للمخزون بعد. ", can("inventory.manage") ? h("a", { href: "/admin/inventory", "data-link": true, text: "سجّله الآن" }) : "اطلب من المدير العام تسجيله.");
  const warn = s.level !== "NONE";
  const msg = { LOW: `مخزون منخفض: ${s.available} علب متاحة فقط (حد التنبيه ${s.lowStockThreshold}).`, CRITICAL: `مخزون حرج: ${s.available} علب متاحة فقط.`, OUT: "نفد المخزون المتاح: الطلبات الجديدة ستُسجَّل كطلبات نقص." }[s.level];
  return h("div", null,
    warn ? h("div", { class: "stock-alert lvl-" + s.level, role: "alert" }, h("b", { text: LEVEL[s.level] }), " — ", msg,
      s.alert && onAck ? h("button", { type: "button", class: "btn ghost sm", text: "تم الاطلاع", onclick: () => onAck(s.alert.id) }) : null) : null,
    h("div", { class: "tiles" },
      tile2("المتوفر للبيع", fmtN(s.available) + " علبة", "الموجود ناقص المحجوز", warn ? "tile-warn" : ""),
      tile2("محجوز لطلبات مفتوحة", fmtN(s.reserved) + " علبة"),
      tile2("تم بيعه (مُسلَّم)", fmtN(s.sold) + " علبة"),
      tile2("الموجود فعلياً", fmtN(s.onHand) + " علبة", "في المستودع"),
      tile2("حد التنبيه", fmtN(s.lowStockThreshold) + " علبة", "حرج عند " + s.criticalStockThreshold),
      tile2("طلبات نقص", fmtN(s.shortageOrders), s.shortageUnits ? `ينقصها ${s.shortageUnits} علبة` : "لا يوجد", s.shortageOrders ? "tile-warn" : ""),
      s.stockValue !== undefined ? tile2("قيمة المخزون", sarF(s.stockValue), (s.costingMethod || "FIFO") + (s.stockValueComplete ? "" : " · بعض الدفعات بلا تكلفة")) : null));
}

/* قسم الأرباح في لوحة المعلومات */
function rangePicker(state, onChange) {
  const r = h("select", { "aria-label": "الفترة" }, [["today", "اليوم"], ["week", "هذا الأسبوع"], ["month", "هذا الشهر"], ["last_month", "الشهر الماضي"], ["year", "هذه السنة"], ["all", "كل الفترات"], ["custom", "فترة مخصصة"]]
    .map(([v, t]) => h("option", { value: v, text: t, selected: state.range === v })));
  const f = h("input", { type: "date", value: state.from || "", "aria-label": "من" }), t = h("input", { type: "date", value: state.to || "", "aria-label": "إلى" });
  const custom = h("span", { class: "row" }, "من", f, "إلى", t, h("button", { type: "button", class: "btn ghost sm", text: "عرض", onclick: () => onChange({ range: "custom", from: f.value, to: t.value }) }));
  custom.hidden = state.range !== "custom";
  r.addEventListener("change", () => { custom.hidden = r.value !== "custom"; if (r.value !== "custom") onChange({ range: r.value }); });
  return h("span", { class: "row" }, r, custom);
}
async function financeSection(box) {
  const state = { range: "month", source: "" };
  const head = h("div", { class: "page-head" }, h("h2", { text: "الأرباح والمصاريف" }));
  const body = h("div", null, h("p", { class: "muted", text: "جارٍ التحميل…" }));
  const src = h("select", { "aria-label": "مصدر الطلبات" }, [["", "كل المصادر"], ["WEBSITE", "طلبات الموقع"], ["ADMIN", "طلبات لوحة التحكم"]].map(([v, t]) => h("option", { value: v, text: t })));
  const load = async () => {
    const qs = new URLSearchParams({ range: state.range }); if (state.range === "custom") { qs.set("from", state.from || ""); qs.set("to", state.to || ""); } if (state.source) qs.set("source", state.source);
    let d; try { d = await api("/finance/summary?" + qs); } catch (e) { if (e.message !== "unauthorized") body.textContent = errText(e); return; }
    const F = d.financial, S = d.sales, P = d.product;
    body.textContent = "";
    put(body,
      h("p", { class: "muted small", text: `الفترة: ${d.period.range === "all" ? "كل الفترات" : d.period.from + " → " + d.period.to} · الإيراد = الطلبات التي تم تسليمها في الفترة (الدفع عند الاستلام). الطلبات الملغاة والمتعذرة لا تُحسب.` }),
      h("div", { class: "tiles" },
        tile2("الإيرادات", sarF(F.grossRevenue), `${S.deliveredInPeriod} طلب مُسلَّم`),
        tile2("تكلفة البضاعة المباعة", sarF(F.cogs), F.cogsMissingOrders ? `${F.cogsMissingOrders} طلب بدفعة بلا تكلفة` : "FIFO"),
        tile2("إجمالي الربح", sarF(F.grossProfit), "الإيرادات − التكلفة"),
        tile2("التوصيل", sarF(F.deliveryExpenses)), tile2("الإعلانات", sarF(F.advertisingExpenses)), tile2("مصاريف أخرى", sarF(F.otherExpenses)),
        tile2("المصاريف التشغيلية", sarF(F.operatingExpenses)),
        d.spending.inventoryPurchases != null ? tile2("قيمة شراء المخزون", sarF(d.spending.inventoryPurchases), "تفاصيلها في التقارير — لا تُطرح من الربح") : null,
        F.stockLosses ? tile2("خسائر المخزون", sarF(F.stockLosses), "تالف / شطب") : null,
        tile2("صافي الربح", sarF(F.netProfit), "إجمالي الربح − المصاريف", F.netProfit < 0 ? "tile-warn" : "tile-good")),
      F.expensesNote ? h("p", { class: "note-box", text: "مع اختيار مصدر واحد تُحسب فقط المصاريف المرتبطة بطلبات هذا المصدر؛ المصاريف العامة تظهر في «كل المصادر»." }) : null,
      h("h3", { text: "المبيعات (طلبات أُنشئت في الفترة)" }),
      h("div", { class: "tiles" }, tile2("كل الطلبات", fmtN(S.orders)), tile2("ناجحة (مُسلَّمة)", fmtN(S.successful)), tile2("ملغاة", fmtN(S.cancelled)), tile2("متعذّرة", fmtN(S.failed)), tile2("قيد التنفيذ", fmtN(S.pending))),
      h("h3", { text: "المنتج" }),
      h("div", { class: "tiles" }, tile2("الوحدات المباعة", fmtN(P.unitsSold)), tile2("متوسط سعر البيع", sarF(P.averageSellingPrice), "للعلبة"),
        tile2("متوسط تكلفة الوحدة", sarF(P.averageUnitCost), "للعلبة"), tile2("قيمة المخزون الحالية", sarF(P.inventoryValue), P.inventoryValueComplete ? "حالياً" : "بعض الدفعات بلا تكلفة")));
  };
  src.addEventListener("change", () => { state.source = src.value; load(); });
  put(head, h("div", { class: "row" }, rangePicker(state, v => { Object.assign(state, v); load(); }), src));
  const card = h("section", { class: "card" }, head, body);
  onFinanceChange(card, load);
  put(box, card);
  load();
}

/* ---------- صفحة المخزون ---------- */
async function pageInventory() {
  const P = new URLSearchParams(location.search), tab = P.get("tab") || "overview";
  const main = shell("inventory", h("p", { class: "muted", text: "جارٍ التحميل…" }));
  const qs = new URLSearchParams(); ["page", "type", "order"].forEach(k => P.get(k) && qs.set(k, P.get(k)));
  let d; try { d = await api("/inventory" + (qs.toString() ? "?" + qs : "")); } catch (e) { if (e.message !== "unauthorized") main.lastChild.textContent = errText(e); return; }
  main.textContent = "";
  if (!d.summary.initialized) return openingWizard(main, d.summary);
  const s = d.summary, ack = async id => { try { await api(`/inventory/alerts/${id}/ack`, { body: {} }); pageInventory(); } catch (e) { toast(errText(e), true); } };
  const TABS = [["overview", "نظرة عامة"], ["receive", "إضافة مخزون"], ["batches", "دفعات المخزون"], ["tx", "سجل الحركات"], ["shortages", `طلبات النقص (${d.shortages.length})`], ["adjust", "التسويات"], ["settings", "الإعدادات"]];
  put(main, h("div", { class: "page-head" }, h("h1", { text: "المخزون" }), h("div", { class: "row" },
      h("span", { class: "tag", text: "طريقة التكلفة: " + (SETTING_LABEL[s.costingMethod] || s.costingMethod) }),
      d.canCreatePurchase ? h("a", { class: "btn primary", href: "/admin/inventory?tab=receive", "data-link": true, text: "+ إضافة مخزون" }) : null)),
    h("nav", { class: "chips", "aria-label": "أقسام المخزون" }, TABS.map(([k, t]) => h("a", { class: "chip" + (k === tab ? " on" : ""), href: "/admin/inventory?tab=" + k, "data-link": true, "aria-current": k === tab ? "page" : null, text: t }))));
  const box = h("div"); put(main, box);
  if (tab === "overview") {
    put(box, stockTiles(s, { onAck: ack }));
    const last = d.receipts[0];
    put(box, h("section", { class: "card add-strip" },
      h("div", null, h("h2", { text: "إضافة مخزون جديد" }),
        h("p", { class: "muted small", text: last ? `آخر إضافة: ${fmtN(last.quantity)} علبة بتاريخ ${last.receivedAt} (${last.source === "OPENING" ? "الرصيد الافتتاحي" : "بواسطة " + last.by}).` : "لا توجد إضافات بعد." })),
      d.canCreatePurchase ? h("a", { class: "btn primary", href: "/admin/inventory?tab=receive", "data-link": true, text: "+ إضافة مخزون" }) : null));
    put(box, h("section", { class: "card" }, h("h2", { text: "كيف تُحسب الأرقام" }),
      h("ul", { class: "small" },
        h("li", { text: "المتوفر = الموجود فعلياً − المحجوز للطلبات المفتوحة. التنبيه يعتمد على المتوفر." }),
        h("li", { text: "طلب جديد (من الموقع أو لوحة التحكم) يحجز علبه فوراً ولا يُخصم نهائياً. التسليم يحوّل الحجز إلى بيع، والإلغاء أو تعذّر التسليم يعيده للمتوفر." }),
        h("li", { text: "التكلفة: الوارد أولاً يُصرف أولاً (FIFO). تُحفظ تكلفة كل طلب عند تسليمه ولا تُعاد حسابها عند فتح الصفحات." }),
        h("li", { text: "كل حركة لها سطر في «سجل الحركات» برصيد قبل وبعد، ولا يمكن تعديل السجل أو حذفه." })),
      h("button", { type: "button", class: "btn ghost sm", text: "فحص تطابق الأرصدة", onclick: async e => busy(e.currentTarget, "جارٍ الفحص…", async () => {
        try { const r = await api("/inventory/reconcile"); toast(r.ok ? "الأرصدة متطابقة مع سجل الحركات والدفعات." : "يوجد اختلاف: " + JSON.stringify(r.checks), !r.ok); } catch (x) { toast(errText(x), true); } }) })));
  } else if (tab === "receive") {
    if (d.canCreatePurchase) put(box, receiptCard(d));
    purchasesSection(box);
  } else if (tab === "batches") {
    put(box, h("section", { class: "card" }, h("h2", { text: "دفعات المخزون" }), h("p", { class: "muted small", text: "كل استلام دفعة مستقلة بتكلفتها؛ لا تُدمج الدفعات. تُصرف الأقدم أولاً." }),
      tbl(["الدفعة", "تاريخ الاستلام", "النوع", "المستلم", "المتبقي", ...(d.canSeeCosts ? ["تكلفة الوحدة", "إجمالي التكلفة", "قيمة المتبقي"] : []), "الحالة", "المورد / المرجع", ""],
        d.batches.map(b => ["#" + b.batchNo, b.receivedAt, { OPENING: "رصيد افتتاحي", PURCHASE: "شراء", ADJUSTMENT: "تسوية" }[b.source] || b.source, fmtN(b.quantityReceived), fmtN(b.quantityRemaining),
          ...(d.canSeeCosts ? [b.costKnown ? sarF(b.unitCost) : "غير مُدخلة", b.costKnown ? sarF(b.totalCost) : "—", b.costKnown ? sarF(b.stockValue) : "—"] : []),
          { FULL: "كاملة", PARTIAL: "مستخدمة جزئياً", DEPLETED: "نفدت", VOIDED: "ملغاة" }[b.status], [b.supplier, b.reference].filter(Boolean).join(" · ") || "—",
          d.canEditPurchase && b.source !== "ADJUSTMENT" && b.status !== "VOIDED" ? h("a", { class: "btn ghost sm", href: "/admin/inventory?tab=receive&edit=" + b.id, "data-link": true, text: d.canSeeCosts && !b.costKnown ? "إدخال السعر" : "تعديل" }) : ""]))));
  } else if (tab === "tx") {
    const type = h("select", { "aria-label": "نوع الحركة" }, h("option", { value: "", text: "كل الحركات" }), Object.entries(TX).map(([k, t]) => h("option", { value: k, text: t, selected: P.get("type") === k })));
    const ord = h("input", { type: "search", placeholder: "رقم الطلب", value: P.get("order") || "" });
    const apply = () => { const u = new URLSearchParams({ tab: "tx" }); if (type.value) u.set("type", type.value); if (ord.value.trim()) u.set("order", ord.value.trim()); go("/admin/inventory?" + u); };
    type.addEventListener("change", apply);
    const pages = Math.max(1, Math.ceil(d.transactionsTotal / d.per));
    put(box, h("section", { class: "card" }, h("h2", { text: "سجل حركات المخزون" }),
      h("form", { class: "filters", onsubmit: e => { e.preventDefault(); apply(); } }, type, ord, h("button", { type: "submit", class: "btn primary", text: "بحث" })),
      tbl(["التاريخ", "الحركة", "الطلب", "الكمية", "المتوفر قبل → بعد", "الموجود قبل → بعد", "المحجوز قبل → بعد", ...(d.canSeeCosts ? ["التكلفة"] : []), "المرجع / ملاحظة", "بواسطة"],
        d.transactions.map(t => [when(t.at), TX[t.type] || t.type, t.orderNumber ? h("a", { href: "/admin/orders/" + t.orderNumber, "data-link": true, class: "num", text: t.orderNumber }) : "—",
          fmtN(t.quantity), `${t.availableBefore} → ${t.availableAfter}`, `${t.onHandBefore} → ${t.onHandAfter}`, `${t.reservedBefore} → ${t.reservedAfter}`,
          ...(d.canSeeCosts ? [t.cost == null ? "—" : sarF(t.cost)] : []), [ADJ[t.reference] || t.reference, t.notes].filter(Boolean).join(" · ") || "—", t.actor === "customer" ? "العميل (الموقع)" : t.actor])),
      pages > 1 ? h("div", { class: "pager" }, Array.from({ length: Math.min(pages, 20) }, (_, i) => h("a", { class: "btn ghost sm" + (i + 1 === d.page ? " on" : ""), href: `/admin/inventory?tab=tx&page=${i + 1}` + (P.get("type") ? "&type=" + P.get("type") : ""), "data-link": true, text: String(i + 1) }))) : null));
  } else if (tab === "shortages") {
    put(box, h("section", { class: "card" }, h("h2", { text: "طلبات النقص" }),
      h("p", { class: "muted small", text: "طلبات استُلمت ولم يكن المتوفر كافياً. معلومات داخلية لا تظهر للعميل. عند وصول مخزون اضغط «حجز المتوفر» — لا تتغير حالة الطلب تلقائياً." }),
      tbl(["الطلب", "التاريخ", "العميل", "المصدر", "المطلوب", "المتوفر وقت الطلب", "محجوز", "النقص", "المتوفر الآن", "حالة الطلب", ""],
        d.shortages.map(x => [h("a", { href: "/admin/orders/" + x.orderNumber, "data-link": true, class: "num", text: x.orderNumber }), when(x.orderDate), x.customer, SOURCE[x.source] || x.source,
          fmtN(x.requested), fmtN(x.availableAtOrder), fmtN(x.reserved), h("b", { class: "danger-text", text: fmtN(x.shortage) }), fmtN(x.currentAvailable), badge(x.orderStatus),
          d.canManage && x.canAllocate ? h("button", { type: "button", class: "btn primary sm", text: "حجز المتوفر", onclick: e => busy(e.currentTarget, "جارٍ الحجز…", async () => {
            try { const r = await api(`/orders/${x.orderNumber}/allocate`, { body: {} }); toast(r.status === "RESERVED" ? "تم حجز كامل الكمية." : `تم حجز جزء؛ ما زال ينقص ${r.shortage}.`); pageInventory(); } catch (er) { toast(errText(er), true); } }) }) : ""]))));
  } else if (tab === "adjust") {
    if (d.canManage) put(box, adjustCard(d));
    put(box, h("section", { class: "card" }, h("h2", { text: "التسويات السابقة" }),
      tbl(["التاريخ", "الكمية", "قبل", "بعد", "السبب", "ملاحظات", "بواسطة"], d.adjustments.map(a => [when(a.at), (a.quantity > 0 ? "+" : "") + a.quantity, a.oldOnHand, a.newOnHand, ADJ[a.reason] || a.reason, a.notes || "—", a.by]))));
  } else if (tab === "settings") {
    put(box, settingsCard(d));
  }

}

function adjustCard(d) {
  const id = reqId(), sign = h("select", { "aria-label": "نوع التسوية" }, h("option", { value: "-1", text: "إنقاص (−)" }), h("option", { value: "1", text: "زيادة (+)" }));
  const qty = h("input", { type: "number", min: 1, step: 1, inputmode: "numeric" }), reason = h("select", null, h("option", { value: "", text: "اختر السبب" }), Object.entries(ADJ).map(([k, t]) => h("option", { value: k, text: t })));
  const notes = h("textarea", { maxlength: 500, placeholder: "مثال: الجرد الفعلي 95 والنظام 100" }), cost = h("input", { inputmode: "decimal", placeholder: "اختياري — تكلفة الوحدات المضافة" });
  const costWrap = h("label", { class: "f" }, "إجمالي تكلفة الوحدات المضافة (ر.س)", cost);
  const err = h("p", { class: "err", role: "alert" }), btn = h("button", { type: "button", class: "btn primary", text: "تسجيل التسوية" });
  const sync = () => { costWrap.hidden = sign.value !== "1"; }; sign.addEventListener("change", sync); sync();
  btn.addEventListener("click", async () => {
    const n = Number(qty.value) * Number(sign.value), s = d.summary;
    err.textContent = "";
    if (!Number.isInteger(n) || !n || !reason.value) { err.textContent = "أدخل الكمية واختر السبب."; return; }
    if (!(await confirmBox("تأكيد التسوية", [h("p", { text: `الموجود الآن ${s.onHand} علبة → بعد التسوية ${s.onHand + n} علبة (${n > 0 ? "+" : ""}${n}). السبب: ${ADJ[reason.value]}.` }),
      h("p", { class: "muted small", text: "تُسجَّل كحركة في السجل باسمك ولا يمكن حذفها؛ للتصحيح سجّل تسوية معاكسة." })], { okText: "تسجيل", danger: n < 0 }))) return;
    await busy(btn, "جارٍ التسجيل…", async () => {
      try { await api("/inventory/adjustments", { body: { quantity: n, reason: reason.value, notes: notes.value, totalCost: n > 0 ? cost.value : null, requestId: id } }); toast("تم تسجيل التسوية."); pageInventory(); }
      catch (e) { err.textContent = e.message === "adjustment_exceeds_available" ? `لا يمكن إنقاص أكثر من المتوفر غير المحجوز (${(e.data && e.data.available) ?? d.summary.available} علبة). ألغِ أو عدّل الطلبات المحجوزة أولاً.` : fieldErr(e); }
    });
  });
  return h("section", { class: "card" }, h("h2", { text: "تسوية يدوية (جرد / تالف)" }),
    h("div", { class: "grid2" }, h("label", { class: "f" }, "النوع", sign), h("label", { class: "f" }, "الكمية", qty), h("label", { class: "f" }, "السبب (إلزامي)", reason), costWrap),
    h("label", { class: "f" }, "ملاحظات", notes), err, h("div", { class: "row" }, btn));
}

function settingsCard(d) {
  const s = d.summary.settings, canM = d.canManage;
  const low = h("input", { type: "number", min: 0, step: 1, value: s.lowStockThreshold, disabled: !canM }), crit = h("input", { type: "number", min: 0, step: 1, value: s.criticalStockThreshold, disabled: !canM });
  const sel = (key, cur) => h("select", { disabled: !canM }, d.settingOptions[key].map(v => h("option", { value: v, text: SETTING_LABEL[v] || v, selected: v === cur })));
  const cm = sel("costing_method", s.costingMethod), rb = sel("reservation_behavior", s.reservationBehavior), sp = sel("shortage_policy", s.shortagePolicy), rp = sel("return_policy", s.returnPolicy);
  const err = h("p", { class: "err", role: "alert" }), btn = canM ? h("button", { type: "button", class: "btn primary", text: "حفظ الإعدادات" }) : null;
  if (btn) btn.addEventListener("click", () => busy(btn, "جارٍ الحفظ…", async () => {
    try { await api("/inventory/settings", { body: { low_stock_threshold: Number(low.value), critical_stock_threshold: Number(crit.value), costing_method: cm.value, reservation_behavior: rb.value, shortage_policy: sp.value, return_policy: rp.value } }); toast("تم حفظ إعدادات المخزون."); pageInventory(); }
    catch (e) { err.textContent = e.data && e.data.fields && e.data.fields.critical_stock_threshold ? "الحد الحرج يجب ألا يتجاوز حد التنبيه." : fieldErr(e); }
  }));
  return h("section", { class: "card" }, h("h2", { text: "إعدادات المخزون" }),
    h("div", { class: "grid2" }, h("label", { class: "f" }, "حد التنبيه (مخزون منخفض)", low, h("small", { text: "يُقارن بالمتوفر (الموجود − المحجوز)" })),
      h("label", { class: "f" }, "الحد الحرج", crit), h("label", { class: "f" }, "طريقة احتساب التكلفة", cm), h("label", { class: "f" }, "متى يُحجز المخزون", rb),
      h("label", { class: "f" }, "عند عدم كفاية المخزون", sp), h("label", { class: "f" }, "طلب مُسلَّم أُعيد (تغيير استثنائي)", rp)),
    err, btn ? h("div", { class: "row" }, btn) : h("p", { class: "muted small", text: "التعديل للمدير العام فقط." }));
}

/* تسجيل الرصيد الافتتاحي ومطابقته مع الطلبات الموجودة (مرة واحدة) */
function openingWizard(main, s) {
  put(main, h("h1", { text: "المخزون — الرصيد الافتتاحي" }));
  if (!can("inventory.manage")) { put(main, h("p", { class: "note-box", text: "لم يُسجَّل الرصيد الافتتاحي بعد. يسجّله المدير العام." })); return; }
  const qty = h("input", { type: "number", min: 0, step: 1, value: 24 }), date = h("input", { type: "date", value: s.suggestedOpeningDate, max: s.suggestedOpeningDate });
  const cost = h("input", { inputmode: "decimal", placeholder: "اختياري — يمكن إدخالها لاحقاً" }), notes = h("textarea", { maxlength: 500, value: "رصيد افتتاحي فعلي" });
  const out = h("div"), err = h("p", { class: "err", role: "alert" });
  const pv = h("button", { type: "button", class: "btn primary", text: "معاينة المطابقة" });
  const body = () => ({ quantity: Number(qty.value), date: date.value, totalCost: cost.value || null, notes: notes.value });
  pv.addEventListener("click", () => busy(pv, "جارٍ الحساب…", async () => {
    err.textContent = ""; out.textContent = "";
    let r; try { r = await api("/inventory/init", { body: { ...body(), preview: true } }); } catch (e) { err.textContent = e.data && e.data.fields && e.data.fields.date ? `التاريخ يجب أن يسبق أول طلب (${e.data.firstOrderDay}).` : fieldErr(e); return; }
    const apply = h("button", { type: "button", class: "btn primary", text: "اعتماد الرصيد الافتتاحي", disabled: r.unreconciled.length > 0 });
    apply.addEventListener("click", async () => {
      if (!(await confirmBox("اعتماد الرصيد الافتتاحي", [`${r.openingQuantity} علبة بتاريخ ${r.openingDate}. بعد الاعتماد: متوفر ${r.available}، محجوز ${r.reserved}، مباع ${r.sold}.`, h("p", { class: "warn-box", text: "يُسجَّل مرة واحدة فقط ولا يمكن التراجع عنه؛ أي تصحيح لاحق يكون بتسوية." })], { okText: "اعتماد" }))) return;
      await busy(apply, "جارٍ الاعتماد…", async () => { try { await api("/inventory/init", { body: body() }); toast("تم تسجيل الرصيد الافتتاحي ومطابقة الطلبات."); pageInventory(); } catch (e) { toast(fieldErr(e), true); } });
    });
    const EFF = { RESERVED: "محجوز", SHORTAGE: "نقص", CONSUMED: "مُستهلك (مُسلَّم)", NONE: "لا أثر (ملغي/متعذّر)", UNRECONCILED: "لا يكفي المخزون" };
    put(out, h("section", { class: "card" }, h("h2", { text: "نتيجة المطابقة (لم يُحفظ شيء بعد)" }),
      h("div", { class: "tiles" }, tile2("الرصيد الافتتاحي", fmtN(r.openingQuantity)), tile2("مُستهلك (طلبات مُسلَّمة)", fmtN(r.sold)), tile2("محجوز (طلبات مفتوحة)", fmtN(r.reserved)),
        tile2("المتوفر بعد المطابقة", fmtN(r.available), null, r.available <= 10 ? "tile-warn" : ""), tile2("طلبات نقص", fmtN(r.shortageOrders.length))),
      h("p", { class: "muted small", text: `راجعنا ${r.ordersReviewed} طلباً: ${r.reservedOrders} محجوز، ${r.consumedOrders} مُستهلك، ${r.releasedOrders} بلا أثر.` }),
      r.unreconciled.length ? h("p", { class: "warn-box", text: "الرصيد الافتتاحي أقل من الطلبات المُسلَّمة: " + r.unreconciled.map(x => x.orderNumber).join("، ") }) : null,
      tbl(["الطلب", "الحالة", "العلب", "الأثر", "محجوز", "المتوفر بعده"], r.orders.map(o => [o.orderNumber, badge(o.status), o.units, EFF[o.effect] || o.effect, o.reserved ?? "—", o.availableAfter ?? "—"])),
      h("div", { class: "row" }, apply)));
  }));
  put(main, h("div", { class: "steps-box" },
      h("div", { class: "on" }, h("b", { text: "1" }), h("span", { text: "الرصيد الافتتاحي — مرة واحدة الآن" })),
      h("div", null, h("b", { text: "2" }), h("span", { text: "بعدها: «+ إضافة مخزون» كلما وصلتك كمية جديدة (يومياً أو أكثر من مرة في اليوم)" }))),
    h("section", { class: "card" }, h("p", { text: "سجّل كمية المخزون الفعلية قبل أول طلب. سيُراجع النظام كل الطلبات الموجودة حسب حالتها الحالية: المُسلَّمة تُخصم، المفتوحة تُحجز، والملغاة والمتعذرة لا تؤثر. بعد الاعتماد يظهر زر «+ إضافة مخزون» لكل كمية جديدة تصلك." }),
    h("div", { class: "grid2" }, h("label", { class: "f" }, "الكمية الافتتاحية (علبة)", qty), h("label", { class: "f" }, "تاريخ الرصيد الافتتاحي", date, h("small", { text: `يجب أن يسبق أول طلب (${s.firstOrderDay || "لا توجد طلبات"})` })),
      h("label", { class: "f" }, "إجمالي تكلفة شراء هذه الكمية (ر.س)", cost), h("label", { class: "f" }, "ملاحظات", notes)),
    err, h("div", { class: "row" }, pv)), out);
}

/* ---------- تحديث تلقائي للتقارير ----------
   كل حفظ لمصروف أو شراء (إضافة / تعديل / إلغاء) يبلّغ الصفحات المفتوحة في هذا المتصفح، فتعيد قراءة الأرقام من الخادم.
   الأرقام تُحسب دائماً من السجلات نفسها؛ لا يُخزَّن أي إجمالي في الواجهة. */
const finChannel = () => typeof BroadcastChannel === "function" ? new BroadcastChannel("cg-finance") : null;
function financeChanged() { const c = finChannel(); if (c) { c.postMessage(Date.now()); c.close(); } }
function onFinanceChange(el, fn) {
  const c = finChannel(); let t = 0, last = Date.now();
  const stop = () => { if (c) c.close(); window.removeEventListener("focus", onFocus); };
  const run = () => { if (!el.isConnected) return stop(); clearTimeout(t); t = setTimeout(() => { last = Date.now(); fn(); }, 150); };
  const onFocus = () => { if (Date.now() - last > 30000) run(); };       // رجوع للصفحة بعد تعديل من جهاز آخر
  if (c) c.onmessage = run;
  window.addEventListener("focus", onFocus);
}
const FIELD_LABEL = { amount: "المبلغ", date: "التاريخ", description: "الوصف", orderNumber: "رقم الطلب", category: "الفئة", platform: "المنصة", quantity: "الكمية",
  unitCost: "سعر الوحدة", totalCost: "الإجمالي", receivedDate: "تاريخ الشراء", quantityOrdered: "الكمية في الفاتورة", reason: "السبب", amountRange: "نطاق المبلغ",
  valueRange: "نطاق القيمة", range: "الفترة" };
const FIELD_PROBLEM = { invalid: "غير صحيح", required: "مطلوب", not_found: "غير موجود", too_large: "أكبر من الحد المسموح", must_be_before_first_order: "يجب أن يسبق أول طلب" };
const fieldsText = e => e && e.data && e.data.fields ? "تحقق من: " + Object.entries(e.data.fields).map(([k, v]) => `${FIELD_LABEL[k] || k} (${FIELD_PROBLEM[v] || v})`).join("، ") : errText(e);
const purchaseErr = e => e && e.message === "quantity_below_used" ? `لا يمكن أن تقل الكمية عن ${e.data.used} علبة — هذا ما استُخدم منها في طلبات أو تسويات.`
  : e && e.message === "edit_exceeds_available" ? `لا يمكن إنقاص المخزون بهذا القدر: المتوفر غير المحجوز ${e.data && e.data.available != null ? e.data.available : "أقل من المطلوب"} علبة، والباقي محجوز لطلبات مفتوحة.`
  : e && e.message === "purchase_used" ? `لا يمكن إلغاء شراء استُخدم منه ${e.data.used} علبة. عدّل كميته بدلاً من ذلك.`
  : fieldsText(e);
const num = v => Number(String(v ?? "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[,\s]/g, ""));
// قائمة «قبل ← بعد» لنافذة التأكيد
const changeList = rows => h("ul", { class: "change-list" }, rows.map(([l, o, n]) => h("li", null, h("b", { text: l + ": " }), h("span", { class: "old", text: o === "" || o == null ? "—" : String(o) }), " ← ", h("span", { text: n === "" || n == null ? "—" : String(n) }))));

/* ---------- صفحة المصاريف ---------- */
async function pageExpenses() {
  const P = new URLSearchParams(location.search);
  const state = Object.fromEntries(["range", "from", "to", "category", "status", "min", "max", "q", "edit"].map(k => [k, P.get(k) || ""]));
  if (!state.range) state.range = "month";
  if (P.get("voided") === "1" && !state.status) state.status = "all";
  const main = shell("expenses", h("p", { class: "muted", text: "جارٍ التحميل…" }));
  const qs = new URLSearchParams(Object.entries(state).filter(([k, v]) => v && k !== "edit"));
  let d; try { d = await api("/expenses?" + qs); } catch (e) { if (e.message !== "unauthorized") main.lastChild.textContent = fieldsText(e); return; }
  main.textContent = "";
  const nav = v => { const u = new URLSearchParams(Object.entries({ ...state, edit: "", ...v }).filter(([, x]) => x)); go("/admin/expenses?" + u); };
  const cat = h("select", { "aria-label": "الفئة" }, h("option", { value: "", text: "كل الفئات" }), d.categories.map(c => h("option", { value: c.id, text: c.name, selected: state.category === c.id })));
  const st = h("select", { "aria-label": "حالة السجل" }, [["", "الفعّالة"], ["voided", "الملغاة"], ["all", "الكل (مع الملغاة)"]].map(([v, t]) => h("option", { value: v, text: t, selected: state.status === v || (v === "" && state.status === "active") })));
  const min = h("input", { inputmode: "decimal", class: "w-num", placeholder: "من مبلغ", "aria-label": "أقل مبلغ", value: state.min });
  const max = h("input", { inputmode: "decimal", class: "w-num", placeholder: "إلى مبلغ", "aria-label": "أعلى مبلغ", value: state.max });
  const q = h("input", { type: "search", placeholder: "بحث في الوصف، المرجع، الملاحظات", "aria-label": "بحث", value: state.q });
  const filtered = ["category", "status", "min", "max", "q"].some(k => state[k]);
  put(main, h("div", { class: "page-head" }, h("h1", { text: "المصاريف التشغيلية" }),
      h("a", { class: "btn ghost sm", href: "/admin/reports#spending", "data-link": true, text: "التقرير: المصاريف ومشتريات المخزون" })),
    h("form", { class: "filters", onsubmit: ev => { ev.preventDefault(); nav({ category: cat.value, status: st.value, min: min.value.trim(), max: max.value.trim(), q: q.value.trim() }); } },
      rangePicker(state, v => nav(v)), cat, st, min, max, q, h("button", { type: "submit", class: "btn primary", text: "تطبيق" }),
      filtered ? h("a", { href: "/admin/expenses?range=" + state.range, "data-link": true, class: "small", text: "مسح الفلاتر" }) : null),
    h("p", { class: "note-box" }, `${fmtN(d.total)} مصروف · الإجمالي `, h("b", { text: sarF(d.sum) }), d.voidedCount ? ` (لا يشمل ${d.voidedCount} ملغي)` : ""));
  const formBox = h("div"); put(main, formBox);
  const editing = state.edit && d.canEdit ? d.expenses.find(x => String(x.id) === state.edit && !x.voided) : null;
  if (editing) put(formBox, expenseForm(d, editing, nav)); else if (d.canCreate) put(formBox, expenseForm(d, null, nav));
  put(main, h("section", { class: "card" }, h("h2", { text: "السجل" }),
    d.expenses.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["التاريخ", "الفئة", "المبلغ", "الوصف", "الطلب", "المنصة / الحملة", "المرجع", "السجل", ""].map(t => h("th", { text: t })))),
      h("tbody", null, d.expenses.map(e => h("tr", { class: e.voided ? "row-voided" : String(e.id) === state.edit ? "row-editing" : null },
        h("td", { class: "num", text: e.date }), h("td", { text: e.categoryName }), h("td", null, h("b", { text: sarF(e.amount) })),
        h("td", { class: "wrap" }, e.description, e.notes ? h("div", { class: "muted small", text: e.notes }) : null),
        h("td", null, e.orderNumber ? h("a", { href: "/admin/orders/" + e.orderNumber, "data-link": true, class: "num", text: e.orderNumber }) : "—"),
        h("td", { text: [PLATFORM[e.platform] || "", e.campaign].filter(Boolean).join(" · ") || "—" }), h("td", { text: e.reference || "—" }),
        h("td", { class: "small" }, h("div", { text: "أضافه " + e.createdBy }), e.updatedBy ? h("div", { class: "muted", text: `عدّله ${e.updatedBy} · ${when(e.updatedAt)}` }) : null),
        h("td", null, e.voided ? h("span", { class: "tag", title: e.voidedBy ? `${e.voidedBy} · ${when(e.voidedAt)}` : null, text: "ملغي: " + (e.voidReason || "") })
          : h("div", { class: "row nowrap" },
            d.canEdit ? h("a", { class: "btn ghost sm", href: "/admin/expenses?" + new URLSearchParams(Object.entries({ ...state, edit: e.id }).filter(([, x]) => x)), "data-link": true, text: "تعديل", "aria-label": "تعديل المصروف " + e.id }) : null,
            d.canVoid ? h("button", { type: "button", class: "btn danger sm", text: "إلغاء", "aria-label": "إلغاء المصروف " + e.id, onclick: () => voidIt(e) }) : null)))))))
      : h("div", { class: "empty", text: filtered ? "لا توجد مصاريف تطابق الفلاتر." : "لا توجد مصاريف في هذه الفترة." })));
  if (editing) formBox.scrollIntoView({ block: "start" });
  async function voidIt(e) {
    const r = h("input", { maxlength: 200, placeholder: "مثال: مُسجّل مرتين" });
    if (!(await confirmBox("إلغاء المصروف", [`${e.categoryName} · ${sarF(e.amount)} · ${e.date}`, h("label", { class: "f" }, "سبب الإلغاء (إلزامي)", r),
      h("p", { class: "muted small", text: "لا يُحذف المصروف؛ يبقى في السجل مع السبب ويخرج من كل الإجماليات والتقارير." })], { okText: "إلغاء المصروف", danger: true }))) return;
    try { await api(`/expenses/${e.id}/void`, { body: { reason: r.value, version: e.version } }); toast("تم إلغاء المصروف وتحدّثت التقارير."); financeChanged(); nav({}); }
    catch (x) { toast(x.data && x.data.fields ? "اكتب سبب الإلغاء (3 أحرف على الأقل)." : errText(x), true); }
  }
}

/* إضافة مصروف، أو تعديله مع تعبئة القيم الحالية (cur) */
function expenseForm(d, cur, nav) {
  const editing = !!cur;
  const cats = d.categories.slice(); if (editing && !cats.some(c => c.id === cur.category)) cats.push({ id: cur.category, name: cur.categoryName });
  const f = { category: h("select", null, cats.map(c => h("option", { value: c.id, text: c.name, selected: editing && c.id === cur.category }))),
    amount: h("input", { inputmode: "decimal", placeholder: "مثال: 1200", value: editing ? cur.amount : "" }),
    date: h("input", { type: "date", value: editing ? cur.date : todayRiyadh(), max: todayRiyadh() }),
    description: h("input", { maxlength: 200, placeholder: "مثال: فاتورة شركة الشحن — نوفمبر", value: editing ? cur.description : "" }),
    orderNumber: h("input", { placeholder: "اختياري — CG-2026-000123", dir: "ltr", value: editing ? cur.orderNumber || "" : "" }),
    platform: h("select", null, h("option", { value: "", text: "—" }), d.platforms.map(p => h("option", { value: p, text: PLATFORM[p], selected: editing && cur.platform === p }))),
    campaign: h("input", { maxlength: 120, value: editing ? cur.campaign : "" }), reference: h("input", { maxlength: 120, value: editing ? cur.reference : "" }),
    paymentMethod: h("input", { maxlength: 60, placeholder: "اختياري", value: editing ? cur.paymentMethod : "" }), notes: h("textarea", { maxlength: 500, value: editing ? cur.notes : "" }) };
  const adsOnly = [h("label", { class: "f" }, "المنصة", f.platform), h("label", { class: "f" }, "اسم الحملة", f.campaign)];
  const orderOnly = h("label", { class: "f" }, "رقم الطلب (لتكلفة توصيل طلب محدد)", f.orderNumber);
  const sync = () => { adsOnly.forEach(x => { x.hidden = f.category.value !== "ADVERTISING"; }); orderOnly.hidden = f.category.value === "ADVERTISING"; };
  f.category.addEventListener("change", sync); sync();
  const err = h("p", { class: "err", role: "alert" }), btn = h("button", { type: "button", class: "btn primary", text: editing ? "حفظ التعديل" : "إضافة المصروف" });
  btn.addEventListener("click", async () => {
    err.textContent = "";
    const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]));
    if (!(num(body.amount) > 0)) { err.textContent = "أدخل المبلغ (رقم أكبر من صفر)."; return; }
    if (!body.date || body.date > todayRiyadh()) { err.textContent = "أدخل تاريخاً صحيحاً لا يتجاوز اليوم."; return; }
    if (body.description.length < 2) { err.textContent = "اكتب وصف المصروف."; return; }
    if (editing) {
      const catName = id => (cats.find(c => c.id === id) || {}).name || id;
      const rows = [["الفئة", catName(cur.category), catName(body.category), cur.category !== body.category], ["المبلغ", sarF(cur.amount), sarF(num(body.amount)), num(body.amount) !== cur.amount],
        ["التاريخ", cur.date, body.date], ["الوصف", cur.description, body.description], ["رقم الطلب", cur.orderNumber || "", body.orderNumber.toUpperCase(), (cur.orderNumber || "") !== body.orderNumber.toUpperCase()],
        ["المنصة", PLATFORM[cur.platform] || "", PLATFORM[body.platform] || ""], ["الحملة", cur.campaign, body.campaign], ["المرجع", cur.reference, body.reference],
        ["طريقة الدفع", cur.paymentMethod, body.paymentMethod], ["ملاحظات", cur.notes, body.notes]]
        .filter(r => r.length === 4 ? r[3] : (r[1] || "") !== (r[2] || "")).map(r => r.slice(0, 3));
      if (!rows.length) { toast("لا توجد تغييرات للحفظ."); return; }
      if (!(await confirmBox(`تأكيد تعديل المصروف #${cur.id}`, [changeList(rows), h("p", { class: "muted small", text: "القيم السابقة تُحفظ في سجل التدقيق باسمك، وتتحدّث التقارير فوراً." })], { okText: "حفظ التعديل" }))) return;
    }
    await busy(btn, "جارٍ الحفظ…", async () => {
      try {
        if (editing) await api(`/expenses/${cur.id}`, { body: { ...body, version: cur.version } });
        else await api("/expenses", { body });
        toast(editing ? "تم حفظ التعديل وتحدّثت التقارير." : "تمت إضافة المصروف."); financeChanged(); nav({});
      } catch (e) { err.textContent = e.message === "record_changed" ? "عدّل شخص آخر هذا المصروف للتو. أعد فتحه وراجع القيم قبل الحفظ." : fieldsText(e); }
    });
  });
  return h("section", { class: "card" + (editing ? " edit-card" : "") }, h("h2", { text: editing ? `تعديل مصروف #${cur.id}` : "إضافة مصروف" }),
    editing ? h("p", { class: "muted small", text: `أضافه ${cur.createdBy} · ${when(cur.createdAt)}` + (cur.updatedBy ? ` · آخر تعديل: ${cur.updatedBy} · ${when(cur.updatedAt)}` : "") }) : null,
    h("div", { class: "grid2" }, h("label", { class: "f" }, "الفئة", f.category), h("label", { class: "f" }, "المبلغ (ر.س)", f.amount), h("label", { class: "f" }, "التاريخ", f.date),
      h("label", { class: "f" }, "الوصف", f.description), orderOnly, ...adsOnly, h("label", { class: "f" }, "المرجع / رقم الفاتورة", f.reference), h("label", { class: "f" }, "طريقة الدفع", f.paymentMethod)),
    h("label", { class: "f" }, "ملاحظات", f.notes), err,
    h("div", { class: "row" }, btn, editing ? h("button", { type: "button", class: "btn ghost", text: "إلغاء التعديل", onclick: () => nav({}) }) : null));
}

/* ---------- إضافة مخزون (شراء): الكمية × سعر الوحدة = الإجمالي (يحسبه النظام) ---------- */
function receiptCard(d) {
  const id = reqId(), fin = d.canSeeCosts;
  const f = { quantity: h("input", { type: "number", min: 1, step: 1, inputmode: "numeric", placeholder: "مثال: 20" }),
    unitCost: h("input", { inputmode: "decimal", placeholder: "مثال: 35 (اختياري)" }), invoiceTotal: h("input", { inputmode: "decimal", placeholder: "اختياري — يحسب سعر الوحدة" }),
    receivedDate: h("input", { type: "date", value: todayRiyadh(), max: todayRiyadh() }), quantityOrdered: h("input", { type: "number", min: 1, step: 1 }),
    supplier: h("input", { maxlength: 120 }), reference: h("input", { maxlength: 120, placeholder: "رقم فاتورة / أمر شراء" }), location: h("input", { maxlength: 120, placeholder: "اختياري" }), notes: h("textarea", { maxlength: 500 }) };
  const out = h("p", { class: "note-box" }), err = h("p", { class: "err", role: "alert" });
  const calc = () => {
    const q = num(f.quantity.value), u = num(f.unitCost.value), t = num(f.invoiceTotal.value);
    if (!fin) { out.textContent = "تُضاف الكمية للمخزون؛ تكلفة الشراء يدخلها من لديه صلاحية المالية."; return; }
    if (q > 0 && f.unitCost.value !== "" && u > 0) {
      const total = Math.round(q * u * 100) / 100;
      out.textContent = `الإجمالي = ${fmtN(q)} × ${sarF(u)} = ${sarF(total)} (يحسبه النظام)` + (f.invoiceTotal.value !== "" && Math.abs(total - t) >= 0.01 ? ` · يختلف عن إجمالي الفاتورة (${sarF(t)}) بسبب تقريب سعر الوحدة.` : "");
    } else out.textContent = q > 0 ? "بدون سعر الآن: تُضاف الكمية للمخزون، ويمكن إدخال سعر الوحدة لاحقاً بتعديل الشراء." : "أدخل الكمية وسعر الوحدة؛ الإجمالي يُحسب تلقائياً.";
  };
  // من إجمالي الفاتورة إلى سعر الوحدة (مقرّب للهللة)
  f.invoiceTotal.addEventListener("input", () => { const q = num(f.quantity.value), t = num(f.invoiceTotal.value); if (q > 0 && t > 0) f.unitCost.value = String(Math.round(t / q * 100) / 100); calc(); });
  f.quantity.addEventListener("input", calc); f.unitCost.addEventListener("input", calc); calc();
  const btn = h("button", { type: "button", class: "btn primary", text: "إضافة إلى المخزون" });
  btn.addEventListener("click", async () => {
    err.textContent = "";
    const q = num(f.quantity.value);
    if (!Number.isInteger(q) || q < 1) { err.textContent = "أدخل الكمية (عدد صحيح أكبر من صفر)."; return; }
    if (f.unitCost.value !== "" && !(num(f.unitCost.value) > 0)) { err.textContent = "سعر الوحدة يجب أن يكون رقماً أكبر من صفر."; return; }
    if (!(await confirmBox("تأكيد إضافة المخزون", [h("p", { text: `إضافة ${q} علبة بتاريخ ${f.receivedDate.value}.` }), out.cloneNode(true)], { okText: "إضافة" }))) return;
    await busy(btn, "جارٍ الإضافة…", async () => {
      try {
        const r = await api("/inventory/receipts", { body: { quantity: q, unitCost: f.unitCost.value || null, receivedDate: f.receivedDate.value, quantityOrdered: f.quantityOrdered.value || null,
          supplier: f.supplier.value, reference: f.reference.value, location: f.location.value, notes: f.notes.value, requestId: id } });
        toast(r.replay ? "سُجّلت هذه الإضافة مسبقاً." : `تمت إضافة ${r.quantity} علبة` + (r.totalCost != null ? ` · القيمة ${sarF(r.totalCost)}` : "") + ".");
        financeChanged(); go("/admin/inventory?tab=receive", true);
      } catch (e) { err.textContent = fieldsText(e); }
    });
  });
  return h("section", { class: "card" }, h("h2", { text: "إضافة مخزون (شراء)" }),
    h("div", { class: "grid3" }, h("label", { class: "f" }, "الكمية (علبة)", f.quantity),
      fin ? h("label", { class: "f" }, "سعر الوحدة (ر.س)", f.unitCost) : null, h("label", { class: "f" }, "تاريخ الشراء / الاستلام", f.receivedDate)),
    fin ? h("label", { class: "f narrow" }, "أو إجمالي الفاتورة (ر.س)", f.invoiceTotal) : null,
    out,
    h("details", null, h("summary", { text: "تفاصيل إضافية (اختياري): المورد، المرجع، المستودع، ملاحظات" }),
      h("div", { class: "grid2" }, h("label", { class: "f" }, "المورد", f.supplier), h("label", { class: "f" }, "المرجع / رقم الفاتورة", f.reference),
        h("label", { class: "f" }, "الموقع / المستودع", f.location), h("label", { class: "f" }, "الكمية في الفاتورة", f.quantityOrdered)),
      h("label", { class: "f" }, "ملاحظات", f.notes)),
    err, h("div", { class: "row" }, btn));
}

/* ---------- سجل المشتريات: بحث وتصفية، تعديل، إلغاء ---------- */
async function purchasesSection(box) {
  const P = new URLSearchParams(location.search);
  const state = Object.fromEntries(["range", "from", "to", "supplier", "product", "status", "source", "min", "max", "q", "edit"].map(k => [k, P.get(k) || ""]));
  if (!state.range) state.range = "all";
  const nav = v => { const u = new URLSearchParams(Object.entries({ tab: "receive", ...state, edit: "", ...v }).filter(([, x]) => x)); go("/admin/inventory?" + u); };
  const editBox = h("div"), card = h("section", { class: "card", id: "purchases" }, h("h2", { text: "سجل المشتريات" }), h("p", { class: "muted", text: "جارٍ التحميل…" }));
  put(box, editBox, card);
  const qs = new URLSearchParams(Object.entries(state).filter(([k, v]) => v && k !== "edit"));
  let d; try { d = await api("/inventory/purchases?" + qs); } catch (e) { if (e.message !== "unauthorized") card.lastChild.textContent = fieldsText(e); return; }
  card.lastChild.remove();
  const fin = d.canSeeCosts, sel = (label, key, opts) => h("select", { "aria-label": label }, opts.map(([v, t]) => h("option", { value: v, text: t, selected: state[key] === v })));
  const supplier = sel("المورد", "supplier", [["", "كل الموردين"], ...d.suppliers.map(s => [s, s])]);
  const product = sel("المنتج", "product", [["", "كل المنتجات"], ...d.products.map(p => [p.id, p.name])]);
  const status = sel("حالة السجل", "status", [["", "الفعّالة"], ["voided", "الملغاة"], ["all", "الكل (مع الملغاة)"]]);
  const source = sel("النوع", "source", [["", "كل الأنواع"], ["PURCHASE", "مشتريات"], ["OPENING", "الرصيد الافتتاحي"]]);
  const min = h("input", { inputmode: "decimal", class: "w-num", placeholder: "من قيمة", "aria-label": "أقل قيمة", value: state.min });
  const max = h("input", { inputmode: "decimal", class: "w-num", placeholder: "إلى قيمة", "aria-label": "أعلى قيمة", value: state.max });
  const q = h("input", { type: "search", placeholder: "بحث: مرجع، مورد، ملاحظات", "aria-label": "بحث في المشتريات", value: state.q });
  const filtered = ["supplier", "product", "status", "source", "min", "max", "q"].some(k => state[k]) || state.range !== "all";
  put(card,
    h("form", { class: "filters", onsubmit: ev => { ev.preventDefault(); nav({ supplier: supplier.value, product: product.value, status: status.value, source: source.value, min: fin ? min.value.trim() : "", max: fin ? max.value.trim() : "", q: q.value.trim() }); } },
      rangePicker(state, v => nav(v)), source, product, supplier, status, fin ? min : null, fin ? max : null, q, h("button", { type: "submit", class: "btn primary", text: "تطبيق" }),
      filtered ? h("a", { href: "/admin/inventory?tab=receive", "data-link": true, class: "small", text: "مسح الفلاتر" }) : null),
    h("p", { class: "note-box" }, `${fmtN(d.total)} عملية · ${fmtN(d.units)} علبة`, fin ? [" · القيمة ", h("b", { text: sarF(d.value) })] : null,
      fin && d.missingCost ? ` · ${d.missingCost} بلا سعر (غير محسوبة)` : "", " — الملغاة لا تُحسب."),
    d.purchases.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["التاريخ", "النوع", "المنتج", "الكمية", "استُخدم منها", ...(fin ? ["سعر الوحدة", "الإجمالي"] : []), "المورد", "المرجع", "السجل", ""].map(t => h("th", { text: t })))),
      h("tbody", null, d.purchases.map(b => h("tr", { class: b.voided ? "row-voided" : String(b.id) === state.edit ? "row-editing" : null },
        h("td", { class: "num", text: b.receivedAt }), h("td", { text: b.source === "OPENING" ? "رصيد افتتاحي" : "شراء #" + b.batchNo }), h("td", { text: b.productName }),
        h("td", { class: "num", text: fmtN(b.quantityReceived) }), h("td", { class: "num", text: fmtN(b.used) }),
        ...(fin ? [h("td", { text: b.costKnown ? sarF(b.unitCost) + (b.unitCostExact ? "" : " تقريباً") : "لم يُدخل" }), h("td", null, h("b", { text: b.costKnown ? sarF(b.totalCost) : "—" }))] : []),
        h("td", { text: b.supplier || "—" }), h("td", { text: b.reference || "—" }),
        h("td", { class: "small" }, h("div", { text: "أضافه " + b.createdBy }), b.updatedBy ? h("div", { class: "muted", text: `عدّله ${b.updatedBy} · ${when(b.updatedAt)}` }) : null),
        h("td", null, b.voided ? h("span", { class: "tag", title: `${b.voidedBy || ""} · ${when(b.voidedAt)}`, text: "ملغي: " + (b.voidReason || "") })
          : h("div", { class: "row nowrap" },
            d.canEditPurchase ? h("a", { class: "btn ghost sm", href: "/admin/inventory?" + new URLSearchParams(Object.entries({ tab: "receive", ...state, edit: b.id }).filter(([, x]) => x)), "data-link": true,
              text: fin && !b.costKnown ? "إدخال السعر" : "تعديل", "aria-label": "تعديل الشراء " + b.id }) : null,
            d.canVoidPurchase && b.source === "PURCHASE" ? h("button", { type: "button", class: "btn danger sm", text: "إلغاء", "aria-label": "إلغاء الشراء " + b.id, disabled: b.used > 0,
              title: b.used > 0 ? "استُخدم منه — عدّل الكمية بدلاً من الإلغاء" : null, onclick: () => voidIt(b) }) : null)))))))
      : h("div", { class: "empty", text: filtered ? "لا توجد مشتريات تطابق الفلاتر." : "لا توجد مشتريات بعد." }));
  const editing = state.edit && d.canEditPurchase ? d.purchases.find(x => String(x.id) === state.edit && !x.voided) : null;
  if (editing) { put(editBox, purchaseEditCard(d, editing, nav)); editBox.scrollIntoView({ block: "start" }); }
  async function voidIt(b) {
    const r = h("input", { maxlength: 200, placeholder: "مثال: أُدخلت مرتين" });
    if (!(await confirmBox(`إلغاء الشراء #${b.batchNo}`, [`${fmtN(b.quantityReceived)} علبة بتاريخ ${b.receivedAt}` + (fin && b.costKnown ? ` · ${sarF(b.totalCost)}` : "") + ".",
      h("label", { class: "f" }, "سبب الإلغاء (إلزامي)", r),
      h("p", { class: "muted small", text: `تخرج ${b.quantityReceived} علبة من المخزون وتخرج قيمتها من التقارير. لا يُحذف السجل؛ يبقى مع السبب في السجل وفي سجل التدقيق.` })], { okText: "إلغاء الشراء", danger: true }))) return;
    try { await api(`/inventory/purchases/${b.id}/void`, { body: { reason: r.value, version: b.version } }); toast("تم إلغاء الشراء وتحدّثت التقارير والمخزون."); financeChanged(); nav({}); }
    catch (x) { toast(x.data && x.data.fields ? "اكتب سبب الإلغاء (3 أحرف على الأقل)." : x.message === "opening_cannot_void" ? "لا يُلغى الرصيد الافتتاحي؛ عدّل كميته." : purchaseErr(x), true); }
  }
}

function purchaseEditCard(d, b, nav) {
  const fin = d.canSeeCosts, initUnit = b.costKnown ? String(b.unitCost) : "";
  const f = { quantity: h("input", { type: "number", min: Math.max(1, b.used), step: 1, value: b.quantityReceived }), unitCost: h("input", { inputmode: "decimal", value: initUnit, placeholder: "مثال: 35" }),
    receivedDate: h("input", { type: "date", value: b.receivedAt.slice(0, 10), max: todayRiyadh() }), supplier: h("input", { maxlength: 120, value: b.supplier, list: "cgSuppliers" }),
    reference: h("input", { maxlength: 120, value: b.reference }), location: h("input", { maxlength: 120, value: b.location }),
    quantityOrdered: h("input", { type: "number", min: 1, step: 1, value: b.quantityOrdered ?? "" }), notes: h("textarea", { maxlength: 500, value: b.notes }) };
  const total = h("output", { class: "big-out" }), how = h("small", { class: "muted" }), err = h("p", { class: "err", role: "alert" });
  const calc = () => { const q = num(f.quantity.value), u = num(f.unitCost.value), ok_ = q > 0 && u > 0;
    total.textContent = ok_ ? sarF(Math.round(q * u * 100) / 100) : "—"; how.textContent = ok_ ? `الكمية ${fmtN(q)} × سعر الوحدة ${fmtN(u)}` : "الكمية × سعر الوحدة"; };
  f.quantity.addEventListener("input", calc); f.unitCost.addEventListener("input", calc); calc();
  const btn = h("button", { type: "button", class: "btn primary", text: "حفظ التعديل" });
  btn.addEventListener("click", async () => {
    err.textContent = "";
    const q = num(f.quantity.value), u = f.unitCost.value.trim();
    if (!Number.isInteger(q) || q < 1) { err.textContent = "الكمية عدد صحيح أكبر من صفر."; return; }
    if (q < b.used) { err.textContent = `لا يمكن أن تقل الكمية عن ${b.used} علبة (المستخدم منها).`; return; }
    if (fin && b.costKnown && u === "") { err.textContent = "سعر الوحدة مطلوب (لا يمكن مسح تكلفة معروفة)."; return; }
    if (fin && u !== "" && !(num(u) > 0)) { err.textContent = "سعر الوحدة يجب أن يكون رقماً أكبر من صفر."; return; }
    if (!f.receivedDate.value || f.receivedDate.value > todayRiyadh()) { err.textContent = "التاريخ لا يتجاوز اليوم."; return; }
    const body = { version: b.version, quantity: q, receivedDate: f.receivedDate.value, supplier: f.supplier.value.trim(), reference: f.reference.value.trim(),
      location: f.location.value.trim(), quantityOrdered: f.quantityOrdered.value || null, notes: f.notes.value.trim() };
    const unitChanged = fin && u !== initUnit;
    if (fin && u !== "" && (unitChanged || q !== b.quantityReceived)) body.unitCost = u;
    const newTotal = fin && u !== "" ? Math.round(q * num(u) * 100) / 100 : b.totalCost;
    const rows = [["الكمية", fmtN(b.quantityReceived), fmtN(q), q !== b.quantityReceived], ...(fin ? [["سعر الوحدة", b.costKnown ? sarF(b.unitCost) : "", u ? sarF(num(u)) : "", unitChanged],
      ["الإجمالي", b.costKnown ? sarF(b.totalCost) : "", newTotal != null ? sarF(newTotal) : "", (newTotal ?? null) !== (b.totalCost ?? null)]] : []),
      ["التاريخ", b.receivedAt.slice(0, 10), body.receivedDate], ["المورد", b.supplier, body.supplier], ["المرجع", b.reference, body.reference], ["الموقع", b.location, body.location],
      ["الكمية في الفاتورة", b.quantityOrdered ?? "", body.quantityOrdered ?? ""], ["ملاحظات", b.notes, body.notes]]
      .filter(r => r.length === 4 ? r[3] : String(r[1] ?? "") !== String(r[2] ?? "")).map(r => r.slice(0, 3));
    if (!rows.length) { toast("لا توجد تغييرات للحفظ."); return; }
    const effects = [q !== b.quantityReceived ? `يتغير المخزون الموجود بمقدار ${q > b.quantityReceived ? "+" : ""}${q - b.quantityReceived} علبة (حركة في سجل الحركات).` : null,
      fin && b.used && (unitChanged || q !== b.quantityReceived) && u ? `تُحدَّث تكلفة ${b.used} علبة مستخدمة من هذا الشراء، وتكلفة الطلبات المُسلَّمة منها.` : null].filter(Boolean);
    if (!(await confirmBox(`تأكيد تعديل ${b.source === "OPENING" ? "الرصيد الافتتاحي" : "الشراء #" + b.batchNo}`, [changeList(rows), ...effects.map(x => h("p", { class: "small", text: x })),
      h("p", { class: "muted small", text: "القيم السابقة تُحفظ في سجل التدقيق باسمك، وتتحدّث التقارير فوراً." })], { okText: "حفظ التعديل" }))) return;
    await busy(btn, "جارٍ الحفظ…", async () => {
      try { await api(`/inventory/purchases/${b.id}`, { body }); toast("تم حفظ التعديل وتحدّثت التقارير والمخزون."); financeChanged(); nav({}); }
      catch (e) { err.textContent = e.message === "record_changed" ? "عدّل شخص آخر هذا الشراء للتو. أعد فتحه وراجع القيم قبل الحفظ." : purchaseErr(e); }
    });
  });
  if (!document.getElementById("cgSuppliers")) document.body.append(h("datalist", { id: "cgSuppliers" }, d.suppliers.map(s => h("option", { value: s }))));
  return h("section", { class: "card edit-card" }, h("h2", { text: b.source === "OPENING" ? "تعديل الرصيد الافتتاحي" : `تعديل الشراء #${b.batchNo}` }),
    h("p", { class: "muted small", text: `المنتج: ${b.productName} · أضافه ${b.createdBy} · ${when(b.createdAt)}` + (b.updatedBy ? ` · آخر تعديل: ${b.updatedBy} · ${when(b.updatedAt)}` : "") }),
    b.used ? h("p", { class: "note-box", text: `استُخدم من هذا الشراء ${b.used} علبة (طلبات أو تسويات)، فلا تقل الكمية عن ${b.used}.` }) : null,
    fin && b.costKnown && !b.unitCostExact ? h("p", { class: "note-box", text: "سُجّل هذا الشراء بإجمالي لا ينقسم بالتساوي على الكمية؛ عند تعديل الكمية أو السعر يُعتمد سعر الوحدة المعروض ويُحسب الإجمالي منه." }) : null,
    h("div", { class: "grid3" }, h("label", { class: "f" }, "الكمية (علبة)", f.quantity), fin ? h("label", { class: "f" }, "سعر الوحدة (ر.س)", f.unitCost) : null,
      fin ? h("div", { class: "f" }, h("span", { text: "الإجمالي (يُحسب تلقائياً)" }), total, how) : null),
    h("div", { class: "grid2" }, h("label", { class: "f" }, "تاريخ الشراء / الاستلام", f.receivedDate), h("label", { class: "f" }, "المورد", f.supplier),
      h("label", { class: "f" }, "المرجع / رقم الفاتورة", f.reference), h("label", { class: "f" }, "الموقع / المستودع", f.location), h("label", { class: "f" }, "الكمية في الفاتورة", f.quantityOrdered)),
    h("label", { class: "f" }, "ملاحظات", f.notes), err,
    h("div", { class: "row" }, btn, h("button", { type: "button", class: "btn ghost", text: "إلغاء التعديل", onclick: () => nav({}) })));
}

/* ---------- التقارير: الإيرادات مقابل المصروفات → صافي الربح ---------- */
function spendingSection(box) {
  const state = { range: "all" };                       // منذ البداية: يشمل الرصيد الافتتاحي ولو كان تاريخه في شهر سابق
  const body = h("div", null, h("p", { class: "muted", text: "جارٍ التحميل…" }));
  const card = h("section", { class: "card", id: "spending" },
    h("div", { class: "page-head" }, h("h2", { text: "الإيرادات والمصروفات وصافي الربح" }), h("div", { class: "row" }, rangePicker(state, v => { Object.assign(state, v); load(); }))), body);
  const load = async () => {
    const qs = new URLSearchParams({ range: state.range }); if (state.range === "custom") { qs.set("from", state.from || ""); qs.set("to", state.to || ""); }
    let d; try { d = await api("/finance/summary?" + qs); } catch (e) { if (e.message !== "unauthorized") body.textContent = fieldsText(e); return; }
    const C = d.comparison, X = d.spending, P = X.purchases, rq = "?range=" + state.range + (state.range === "custom" ? `&from=${state.from}&to=${state.to}` : "");
    const max = Math.max(1, C.revenue, C.totalExpenses), bar = (label, v, cls) => h("div", { class: "cmp-row" }, h("span", { class: "cmp-l", text: label }),
      h("span", { class: "cmp-track" }, h("span", { class: "cmp-fill " + cls, "data-w": v / max })), h("b", { class: "cmp-v", text: sarF(v) }));
    body.textContent = "";
    put(body,
      h("p", { class: "muted small", text: `الفترة: ${d.period.range === "all" ? "كل الفترات (منذ البداية)" : d.period.from + " → " + d.period.to} · الإيرادات = الطلبات المُسلَّمة (الدفع عند الاستلام) · الملغاة لا تُحسب.` }),
      h("div", { class: "tiles" },
        tile2("الإيرادات", sarF(C.revenue), `${fmtN(d.sales.deliveredInPeriod)} طلب مُسلَّم`),
        tile2("إجمالي المصروفات", sarF(C.totalExpenses), "التشغيلية + شراء المخزون"),
        tile2("صافي الربح", sarF(C.netProfit), C.margin == null ? "الإيرادات − إجمالي المصروفات" : `هامش ${C.margin}% من الإيرادات`, C.netProfit < 0 ? "tile-warn" : "tile-good tile-total")),
      h("div", { class: "cmp" }, bar("الإيرادات", C.revenue, "rev"), bar("المصروفات", C.totalExpenses, "exp")),
      h("div", { class: "tiles" },
        tile2("المصاريف التشغيلية", sarF(X.operatingExpenses), `${fmtN(X.operatingCount)} مصروف`),
        tile2("قيمة شراء المخزون", sarF(X.inventoryPurchases), `${fmtN(P.count)} عملية · ${fmtN(P.units)} علبة`)),
      P.missingCost ? h("p", { class: "warn-box", text: `${P.missingCost} عملية شراء بلا سعر وحدة — قيمتها غير محسوبة في المصروفات. أدخل السعر من «سجل المشتريات».` }) : null,
      h("div", { class: "note-box cmp-note" },
        h("p", null, "مخزون اشتريته ولم يُبع بعد: ", h("b", { text: sarF(C.unsoldStockValue) }), " — دُفع ثمنه ضمن المصروفات، ويعود إيراداً عند بيعه."),
        h("p", null, "صافي الربح المحاسبي (يحسب تكلفة العلب المباعة فقط بدل كل المشتريات): ", h("b", { text: sarF(C.accrualNetProfit) })),
        C.openOrders.count ? h("p", null, `طلبات مفتوحة لم تُسلَّم بعد: ${fmtN(C.openOrders.count)} طلب بقيمة `, h("b", { text: sarF(C.openOrders.value) }), " — تُضاف للإيرادات عند التسليم.") : null),
      h("h3", { text: "المقارنة شهرياً" }),
      tbl(["الشهر", "طلبات مُسلَّمة", "الإيرادات", "المصاريف التشغيلية", "شراء المخزون", "إجمالي المصروفات", "صافي الربح"],
        C.monthly.length ? [...C.monthly.map(m => [m.month, fmtN(m.orders), sarF(m.revenue), sarF(m.operating), sarF(m.purchases), sarF(m.totalExpenses),
          h("b", { class: m.net < 0 ? "danger-text" : "good-text", text: sarF(m.net) })]),
          [h("b", { text: "الإجمالي" }), fmtN(d.sales.deliveredInPeriod), h("b", { text: sarF(C.revenue) }), sarF(C.operatingExpenses), sarF(C.inventoryPurchases), h("b", { text: sarF(C.totalExpenses) }),
            h("b", { class: C.netProfit < 0 ? "danger-text" : "good-text", text: sarF(C.netProfit) })]] : []),
      h("div", { class: "o-grid" },
        h("div", null, h("h3", { text: "المصاريف التشغيلية حسب الفئة" }),
          tbl(["الفئة", "العدد", "المبلغ"], [...X.byCategory.map(c => [c.name, fmtN(c.count), sarF(c.amount)]), ...(X.byCategory.length ? [[h("b", { text: "الإجمالي" }), fmtN(X.operatingCount), h("b", { text: sarF(X.operatingExpenses) })]] : [])])),
        h("div", null, h("h3", { text: "قيمة شراء المخزون" }),
          tbl(["النوع", "العدد", "العلب", "القيمة"], P.count ? [["مشتريات", fmtN(P.purchased.count), fmtN(P.purchased.units), sarF(P.purchased.value)],
            ...(P.opening.count ? [["الرصيد الافتتاحي", fmtN(P.opening.count), fmtN(P.opening.units), sarF(P.opening.value)]] : []),
            [h("b", { text: "الإجمالي" }), fmtN(P.count), fmtN(P.units), h("b", { text: sarF(X.inventoryPurchases) })]] : []))),
      h("div", { class: "row" }, h("a", { class: "btn ghost sm", href: "/admin/expenses" + rq, "data-link": true, text: "تفاصيل المصاريف" }),
        can("inventory.view") ? h("a", { class: "btn ghost sm", href: "/admin/inventory?tab=receive&" + rq.slice(1), "data-link": true, text: "سجل المشتريات" }) : null));
    body.querySelectorAll(".cmp-fill[data-w]").forEach(f => { f.style.width = (Number(f.dataset.w) * 100) + "%"; });
  };
  onFinanceChange(card, load);
  put(box, card);
  load();
}

/* ---------- طلب جديد من لوحة التحكم ---------- */
async function pageNewOrder() {
  const main = shell("orders");
  const key = "admin-" + reqId();
  const f = { name: h("input", { maxlength: 60, required: true }), phone: h("input", { dir: "ltr", inputmode: "tel", placeholder: "05XXXXXXXX", required: true }), city: h("input", { maxlength: 60 }),
    district: h("input", { maxlength: 60 }), address: h("input", { maxlength: 200 }), notes: h("textarea", { maxlength: 500, placeholder: "ملاحظات التوصيل (يراها فريق التوصيل)" }) };
  f.city.setAttribute("list", cityList());
  const qty = h("input", { type: "number", min: 1, step: 1, value: 1, inputmode: "numeric", "aria-label": "عدد العلب" });
  const status = h("select", null, h("option", { value: "RECEIVED", text: STATUS.RECEIVED }), (can("orders.status") || can("orders.status.limited")) ? h("option", { value: "CONFIRMED", text: STATUS.CONFIRMED }) : null);
  const disc = h("input", { type: "number", min: 0, step: 1, value: 0 }), discReason = h("input", { maxlength: 200, placeholder: "سبب الخصم" });
  const note = h("textarea", { maxlength: 1000, placeholder: "ملاحظة داخلية — مثال: تواصل العميل عبر واتساب وطلب المساعدة." });
  const save = h("label", { class: "row small", hidden: true }, h("input", { type: "checkbox" }), "تحديث بيانات العميل المحفوظة بهذا العنوان");
  const search = h("input", { type: "search", placeholder: "ابحث عن عميل بالجوال أو الاسم", "aria-label": "بحث عن عميل" }), results = h("div", { class: "cust-results" });
  let timer = 0;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(async () => {
    results.textContent = "";
    if (search.value.trim().length < 2) return;
    try { const r = await api("/customers/search?q=" + encodeURIComponent(search.value.trim()));
      put(results, r.customers.length ? r.customers.map(c => h("button", { type: "button", class: "btn ghost sm", text: `${c.name} · ${c.phone} · ${c.city}`, onclick: () => {
        f.name.value = c.name; f.phone.value = c.phone; f.city.value = c.city; f.district.value = c.district; f.address.value = c.address; results.textContent = ""; save.hidden = false; toast("تم ملء بيانات العميل المحفوظة."); } }))
        : h("span", { class: "muted small", text: "لا يوجد عميل مطابق — أدخل بياناته وسيُنشأ له سجل." }));
    } catch (_) {}
  }, 300); });
  const out = h("div"), err = h("p", { class: "err", role: "alert" }), pv = h("button", { type: "button", class: "btn primary", text: "مراجعة الطلب" });
  const body = extra => ({ quantity: Number(qty.value), status: status.value, customer: Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])),
    discount: can("orders.discount") ? Number(disc.value || 0) : 0, discountReason: discReason.value, internalNote: note.value, saveProfile: save.querySelector("input").checked, idempotencyKey: key, ...extra });
  const L = { name: "الاسم", phone: "رقم الجوال", city: "المدينة", district: "الحي", address: "العنوان", quantity: "الكمية", discount: "الخصم", discountReason: "سبب الخصم" };
  pv.addEventListener("click", () => busy(pv, "جارٍ الحساب…", async () => {
    err.textContent = ""; out.textContent = "";
    let r; try { r = await api("/orders/new", { body: body({ preview: true }) }); } catch (e) { err.textContent = e.data && e.data.fields ? "تحقق من: " + Object.keys(e.data.fields).map(k => L[k] || k).join("، ") : errText(e); return; }
    const T = r.totals, S = r.stock, short = S.initialized && S.shortage > 0;
    const create = h("button", { type: "button", class: "btn primary", text: short ? "إنشاء كطلب نقص" : "إنشاء الطلب" });
    create.addEventListener("click", () => busy(create, "جارٍ الإنشاء…", async () => {
      try { const c = await api("/orders/new", { body: body({ allowShortage: short }) }); toast(c.replay ? "هذا الطلب أُنشئ مسبقاً." : "تم إنشاء الطلب " + c.orderNumber); go("/admin/orders/" + c.orderNumber); }
      catch (e) { toast(e.message === "insufficient_stock" ? `تغيّر المخزون: المتوفر الآن ${e.data.available}. راجع الطلب مرة أخرى.` : errText(e), true); }
    }));
    put(out, h("section", { class: "card" }, h("h2", { text: "ملخص الطلب قبل الإنشاء" }),
      h("dl", { class: "kv" },
        h("dt", { text: "العميل" }), h("dd", { text: `${f.name.value} · ${f.phone.value}` + (r.customer.existing ? " (عميل مسجّل)" : " (عميل جديد)") }),
        h("dt", { text: "المنتج" }), h("dd", { text: `CalmGastro × ${T.boxes} علبة` }),
        h("dt", { text: "التفاصيل" }), h("dd", { text: T.lines.map(l => `${l.name} × ${l.quantity}`).join(" + ") }),
        h("dt", { text: "المجموع" }), h("dd", { text: money(T.subtotal) }),
        T.offerDiscount ? [h("dt", { text: "خصم أفضل سعر" }), h("dd", { text: "− " + money(T.offerDiscount) })] : null,
        T.manualDiscount ? [h("dt", { text: "خصم يدوي" }), h("dd", { text: "− " + money(T.manualDiscount) })] : null,
        h("dt", { text: "التوصيل" }), h("dd", { text: T.shipping ? money(T.shipping) : "مجاني" }),
        h("dt", { text: "الإجمالي" }), h("dd", null, h("b", { text: money(T.total) })),
        h("dt", { text: "المصدر" }), h("dd", { text: "لوحة التحكم" }), h("dt", { text: "الحالة الأولى" }), h("dd", null, badge(r.status))),
      S.initialized ? h("div", { class: short ? "warn-box" : "note-box" },
        short ? h("p", null, h("b", { text: "المخزون المتوفر لا يكفي. " }), `المطلوب ${S.requested} · المتوفر ${S.available} · النقص ${S.shortage}. سيُحجز ${S.toReserve} ويُسجَّل الطلب «نقص مخزون» (داخلياً فقط).`)
          : h("p", { text: `المتوفر الآن ${S.available} علبة · سيُحجز ${S.toReserve} · المتبقي بعد الحجز ${S.availableAfter} · المحجوز سيصبح ${S.reservedAfter}.` }))
        : h("p", { class: "muted small", text: "لم يُسجَّل الرصيد الافتتاحي للمخزون بعد؛ لن يُحجز مخزون لهذا الطلب الآن." }),
      h("div", { class: "row" }, create, h("button", { type: "button", class: "btn ghost", text: "إلغاء", onclick: () => { out.textContent = ""; } }))));
    out.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  put(main, h("div", { class: "page-head" }, h("div", null, h("a", { href: "/admin/orders", "data-link": true, class: "small", text: "→ الطلبات" }), h("h1", { text: "طلب جديد" })), h("span", { class: "tag", text: "المصدر: لوحة التحكم" })),
    h("div", { class: "o-grid" },
      h("div", null,
        pasteCard(r => { ["name", "phone", "city", "district", "address"].forEach(k => { if (r[k]) f[k].value = r[k]; }); if (r.quantity) qty.value = r.quantity; out.textContent = ""; }),
        h("section", { class: "card" }, h("h2", { text: "العميل" }), search, results,
          h("div", { class: "grid2" }, h("label", { class: "f" }, "الاسم الكامل", f.name), h("label", { class: "f" }, "رقم الجوال", f.phone)), save),
        h("section", { class: "card" }, h("h2", { text: "التوصيل" }),
          h("div", { class: "grid2" }, h("label", { class: "f" }, "المدينة", f.city), h("label", { class: "f" }, "الحي", f.district)), h("label", { class: "f" }, "العنوان الكامل", f.address), h("label", { class: "f" }, "ملاحظات التوصيل", f.notes))),
      h("div", null,
        h("section", { class: "card" }, h("h2", { text: "المنتج والطلب" }),
          h("div", { class: "grid2" }, h("label", { class: "f" }, "المنتج", h("input", { value: "CalmGastro", disabled: true })), h("label", { class: "f" }, "الكمية (علبة)", qty, h("small", { text: "السعر حسب عروض الموقع الحالية" })),
            h("label", { class: "f" }, "الحالة الأولى", status), h("label", { class: "f" }, "طريقة الدفع", h("input", { value: "الدفع عند الاستلام", disabled: true }))),
          can("orders.discount") ? h("div", { class: "grid2" }, h("label", { class: "f" }, "خصم يدوي (ر.س)", disc), h("label", { class: "f" }, "سبب الخصم", discReason)) : null,
          h("label", { class: "f" }, "ملاحظة داخلية (لا يراها العميل)", note), err, h("div", { class: "row" }, pv, h("a", { class: "btn ghost", href: "/admin/orders", "data-link": true, text: "إلغاء" }))),
        out)));
}

/* بطاقة المخزون داخل صفحة الطلب */
function orderInventoryCard(o, onDone) {
  const inv = o.inventory;
  if (!inv) return null;
  const card = h("section", { class: "card" }, h("h2", { text: "المخزون" }));
  if (!inv.reservations.length) { put(card, h("p", { class: "muted small", text: ["CANCELLED", "FAILED"].includes(o.status) ? "لا يوجد حجز (طلب ملغي أو متعذّر)." : "لا يوجد حجز لهذا الطلب (سُجّل قبل تفعيل المخزون أو لم يُسجَّل الرصيد الافتتاحي بعد)." })); return card; }
  for (const r of inv.reservations) put(card, h("dl", { class: "kv" },
    h("dt", { text: "حالة المخزون" }), h("dd", null, invBadge(r.status)),
    h("dt", { text: "المطلوب" }), h("dd", { text: r.requested + " علبة" }),
    h("dt", { text: "المحجوز" }), h("dd", { text: r.reserved + " علبة" }),
    r.shortage ? [h("dt", { text: "النقص" }), h("dd", null, h("b", { class: "danger-text", text: r.shortage + " علبة" }))] : null,
    r.availableBefore != null ? [h("dt", { text: "المتوفر قبل الحجز" }), h("dd", { text: fmtN(r.availableBefore) }), h("dt", { text: "المتوفر بعد الحجز" }), h("dd", { text: fmtN(r.availableAfter) })] : null,
    r.cogs !== undefined && r.status === "COMMITTED" ? [h("dt", { text: "تكلفة البضاعة (COGS)" }), h("dd", { text: r.cogsComplete ? sarF(r.cogs) : "غير مكتملة — دفعة بلا تكلفة" })] : null,
    r.committedAt ? [h("dt", { text: "تاريخ الاستهلاك" }), h("dd", { text: when(r.committedAt) })] : null,
    r.releasedAt && r.status === "RELEASED" ? [h("dt", { text: "أُلغي الحجز" }), h("dd", { text: when(r.releasedAt) })] : null));
  if (inv.canAllocate) put(card, h("button", { type: "button", class: "btn primary sm", text: "حجز المتوفر الآن", onclick: e => busy(e.currentTarget, "جارٍ الحجز…", async () => {
    try { const r = await api(`/orders/${o.orderNumber}/allocate`, { body: {} }); toast(r.status === "RESERVED" ? "تم حجز كامل الكمية." : `ما زال ينقص ${r.shortage}.`); onDone(); } catch (x) { toast(errText(x), true); } }) }));
  if (inv.transactions.length) put(card, h("details", null, h("summary", { class: "small", text: `حركات المخزون (${inv.transactions.length})` }),
    h("div", { class: "audit-mini" }, inv.transactions.map(t => h("div", null, h("b", { text: TX[t.type] || t.type }), ` ${t.quantity} · المتوفر ${t.availableBefore} → ${t.availableAfter}`,
      t.cost != null ? ` · ${sarF(t.cost)}` : "", h("small", { class: "muted", text: ` ${when(t.at)} · ${t.actor === "customer" ? "العميل" : t.actor}` }))))));
  return card;
}

/* ---------- لصق رسالة العميل (واتساب) → حقول الطلب ---------- */
const CITY_NAMES = ["الرياض", "جدة", "مكة المكرمة", "المدينة المنورة", "الدمام", "الخبر", "الظهران", "الأحساء", "القطيف", "الجبيل", "الطائف", "تبوك", "أبها", "خميس مشيط", "بريدة",
  "عنيزة", "الرس", "حائل", "جازان", "نجران", "ينبع", "الباحة", "عرعر", "سكاكا", "القريات", "حفر الباطن", "الخرج", "المجمعة", "الزلفي", "الدوادمي", "وادي الدواسر", "بيشة",
  "القنفذة", "رابغ", "العلا", "الخفجي", "صبيا", "محايل عسير", "القصيم"];
const cityList = () => { let dl = document.getElementById("cgCities"); if (!dl) { dl = h("datalist", { id: "cgCities" }, CITY_NAMES.map(c => h("option", { value: c }))); document.body.append(dl); } return "cgCities"; };
const ORDER_FIELD_AR = { name: "الاسم", phone: "رقم الجوال", city: "المدينة", district: "الحي", address: "العنوان", quantity: "الكمية", discount: "الخصم", discountReason: "سبب الخصم" };
// نفس شروط الخادم، لتلوين الحقل الناقص قبل الإرسال
function orderRowProblems(r) {
  const p = {};
  if (String(r.name || "").trim().length < 2) p.name = 1;
  if (!/^05\d{8}$/.test(window.CGParse.digits(r.phone || "").replace(/\D/g, "").replace(/^(966|00966)/, "0").replace(/^5/, "05"))) p.phone = 1;
  if (String(r.city || "").trim().length < 2) p.city = 1;
  if (String(r.district || "").trim().length < 2) p.district = 1;
  if (String(r.address || "").trim().length < 3) p.address = 1;
  if (!Number.isInteger(Number(r.quantity)) || Number(r.quantity) < 1) p.quantity = 1;
  return p;
}

function pasteCard(fill) {
  const ta = h("textarea", { rows: 5, placeholder: "الصق رسالة العميل هنا كما وصلت في واتساب — تُعبّأ الحقول تلقائياً", "aria-label": "رسالة العميل" });
  const note = h("div", { class: "small" });
  const run = () => {
    if (!ta.value.trim()) return;
    const r = window.CGParse.parse(ta.value);
    fill(r);
    note.textContent = "";
    put(note, h("p", { class: "ok-msg", text: "تمت تعبئة الحقول من الرسالة — راجعها قبل المتابعة." }),
      r.warnings.length ? h("ul", { class: "warn-list" }, r.warnings.map(w => h("li", { text: w }))) : null,
      r.price ? h("p", { class: "muted", text: `الرسالة تذكر مبلغ ${r.price} ريال؛ السعر يُحسب من عروض الموقع وسيظهر في المراجعة.` }) : null);
  };
  ta.addEventListener("paste", () => setTimeout(run, 0));
  return h("section", { class: "card paste-card" }, h("h2", { text: "لصق رسالة العميل" }), ta,
    h("div", { class: "row" }, h("button", { type: "button", class: "btn ghost sm", text: "تعبئة الحقول من الرسالة", onclick: run }),
      h("a", { class: "small", href: "/admin/orders/import", "data-link": true, text: "عندك رسائل كثيرة؟ أدخلها دفعة واحدة" })), note);
}

/* ---------- إدخال عدة طلبات من رسائل ملصقة ---------- */
async function pageImportOrders() {
  const main = shell("orders");
  const ta = h("textarea", { rows: 10, class: "import-box", placeholder: "الصق رسائل العملاء هنا (رسالة واحدة أو عدة رسائل). افصل بين الطلبات بسطر --- إن لم تُفصل تلقائياً." });
  const allowShort = h("input", { type: "checkbox" });
  const status = h("select", null, h("option", { value: "RECEIVED", text: STATUS.RECEIVED }), (can("orders.status") || can("orders.status.limited")) ? h("option", { value: "CONFIRMED", text: STATUS.CONFIRMED }) : null);
  const table = h("div"), summary = h("div", { class: "note-box" }), bar = h("div", { class: "row" });
  let rows = [];
  const read = () => {
    const parts = window.CGParse.split(ta.value);
    rows = parts.map(t => { const r = window.CGParse.parse(t); return { ...r, quantity: r.quantity || "", raw: t, key: "admin-" + reqId(), state: "new", result: "" }; });
    draw();
    if (!rows.length) toast("لم يُعثر على طلبات في النص.", true);
  };
  function draw() {
    table.textContent = ""; summary.textContent = ""; bar.textContent = "";
    if (!rows.length) return;
    const dl = cityList();
    const body = h("tbody");
    rows.forEach((r, i) => {
      const bad = r.state === "done" ? {} : orderRowProblems(r);
      const inp = (k, attrs = {}) => {
        const el = h("input", { value: r[k] ?? "", class: bad[k] ? "bad" : "", disabled: r.state === "done", "aria-label": ORDER_FIELD_AR[k] + " — طلب " + (i + 1), ...attrs });
        el.addEventListener("input", () => { r[k] = el.value; el.classList.toggle("bad", !!orderRowProblems(r)[k]); updateBar(); });
        return el;
      };
      body.append(h("tr", { class: "st-row-" + r.state },
        h("td", { class: "num", text: String(i + 1) }),
        h("td", null, inp("name")), h("td", null, inp("phone", { dir: "ltr", inputmode: "tel", class: (bad.phone ? "bad " : "") + "w-phone" })),
        h("td", null, inp("city", { list: dl })), h("td", null, inp("district")), h("td", null, inp("address", { class: (bad.address ? "bad " : "") + "w-addr" })),
        h("td", null, inp("quantity", { type: "number", min: 1, step: 1, class: (bad.quantity ? "bad " : "") + "w-qty" })),
        h("td", { class: "small" }, r.warnings.filter(w => !(w.includes("الكمية") && r.quantity)).join(" · ") || "—", r.price ? h("div", { class: "muted", text: `ذُكر ${r.price} ريال` }) : null,
          h("details", null, h("summary", { text: "الرسالة" }), h("pre", { class: "raw", text: r.raw }))),
        h("td", null, r.state === "done" ? h("a", { href: "/admin/orders/" + r.result, "data-link": true, class: "num", text: "✓ " + r.result })
          : r.state === "error" ? h("span", { class: "danger-text small", text: r.result }) : r.state === "busy" ? "…" : "جاهز"),
        h("td", null, r.state === "done" ? "" : h("button", { type: "button", class: "btn ghost sm", text: "حذف", "aria-label": "حذف الطلب " + (i + 1), onclick: () => { rows.splice(i, 1); draw(); } }))));
    });
    put(table, h("div", { class: "table-wrap" }, h("table", { class: "import-table" },
      h("thead", null, h("tr", null, ["#", "الاسم", "الجوال", "المدينة", "الحي", "العنوان", "الكمية", "ملاحظات", "الحالة", ""].map(t => h("th", { text: t })))), body)));
    updateBar();
  }
  function updateBar() {
    bar.textContent = "";
    const pending = rows.filter(r => r.state !== "done"), invalid = pending.filter(r => Object.keys(orderRowProblems(r)).length);
    const boxes = pending.reduce((a, r) => a + (Number(r.quantity) || 0), 0);
    summary.textContent = `${rows.length} طلب · جاهز للإنشاء ${pending.length - invalid.length} · يحتاج تصحيح ${invalid.length} (الخانات الحمراء) · مجموع العلب ${boxes}`;
    const go_ = h("button", { type: "button", class: "btn primary", text: `إنشاء ${pending.length - invalid.length} طلب`, disabled: !pending.length || invalid.length > 0 });
    go_.addEventListener("click", () => createAll(go_));
    put(bar, go_, invalid.length ? h("span", { class: "muted small", text: "صحّح الخانات الحمراء أو احذف الطلب لتفعيل الزر." }) : null);
  }
  async function createAll(btn) {
    const todo = rows.filter(r => r.state !== "done");
    const boxes = todo.reduce((a, r) => a + Number(r.quantity), 0);
    if (!(await confirmBox("إنشاء الطلبات", [`سيُنشأ ${todo.length} طلباً (${boxes} علبة) بحالة «${STATUS[status.value]}»، مصدرها لوحة التحكم، وتُحجز علبها من المخزون.`,
      allowShort.checked ? "إن لم يكفِ المخزون يُنشأ الطلب كطلب نقص." : "إن لم يكفِ المخزون لطلب ما يُترك ولا يُنشأ (فعّل «السماح بطلبات النقص» لإنشائه)."], { okText: "إنشاء" }))) return;
    await busy(btn, "جارٍ الإنشاء…", async () => {
      for (const r of todo) {
        r.state = "busy"; draw();
        try {
          const c = await api("/orders/new", { body: { quantity: Number(r.quantity), status: status.value, idempotencyKey: r.key, allowShortage: allowShort.checked,
            customer: { name: r.name, phone: r.phone, city: r.city, district: r.district, address: r.address, notes: "" }, internalNote: "أُدخل من رسالة العميل (إدخال جماعي)." } });
          r.state = "done"; r.result = c.orderNumber;
        } catch (e) {
          r.state = "error";
          r.result = e.message === "insufficient_stock" ? `المخزون لا يكفي (المتوفر ${e.data.available})` : e.data && e.data.fields ? "تحقق من: " + Object.keys(e.data.fields).map(k => ORDER_FIELD_AR[k] || k).join("، ") : errText(e);
        }
      }
      draw();
      const ok = rows.filter(r => r.state === "done").length, bad = rows.filter(r => r.state === "error").length;
      toast(bad ? `أُنشئ ${ok} طلب، و${bad} لم يُنشأ — راجع عمود الحالة.` : `تم إنشاء ${ok} طلب.`, !!bad);
    });
  }
  put(main, h("div", { class: "page-head" }, h("div", null, h("a", { href: "/admin/orders", "data-link": true, class: "small", text: "→ الطلبات" }), h("h1", { text: "إدخال عدة طلبات" })), h("span", { class: "tag", text: "المصدر: لوحة التحكم" })),
    h("section", { class: "card" },
      h("p", { class: "muted small", text: "انسخ رسائل العملاء من واتساب والصقها هنا كلها مرة واحدة. يقرأ النظام الاسم والجوال والمدينة والحي والعنوان والكمية، ثم تراجعها في الجدول قبل الإنشاء. السعر يُحسب دائماً من عروض الموقع." }),
      ta, h("div", { class: "row" }, h("button", { type: "button", class: "btn primary", text: "قراءة الرسائل", onclick: read }),
        h("label", { class: "row small" }, "الحالة الأولى", status), h("label", { class: "row small" }, allowShort, "السماح بطلبات النقص"))),
    h("section", { class: "card" }, h("h2", { text: "الطلبات المقروءة" }), summary, table, bar));
}

route();
})();

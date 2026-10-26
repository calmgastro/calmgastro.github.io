/* Admin panel (Arabic, RTL). Served by the Worker at /admin with a strict CSP: no inline script,
   no third-party resources. All data is rendered with textContent (never innerHTML). */

export const ADMIN_HTML = String.raw`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>طلبات CalmGastro</title>
<link rel="stylesheet" href="/admin/app.css">
</head>
<body>
<div id="login" class="login" hidden>
  <form id="loginForm" class="card">
    <div class="brand"><span class="o">)</span><span class="t">(</span> <b>Calm</b>Gastro</div>
    <h1>لوحة الطلبات</h1>
    <label for="pw">كلمة المرور</label>
    <input id="pw" type="password" autocomplete="current-password" required>
    <p class="err" id="loginErr" role="alert"></p>
    <button type="submit" class="btn primary" id="loginBtn">دخول</button>
  </form>
</div>

<div id="app" hidden>
  <header class="bar">
    <div class="brand"><span class="o">)</span><span class="t">(</span> <b>Calm</b>Gastro <small>الطلبات</small></div>
    <div class="bar-actions">
      <span class="updated" id="updated"></span>
      <button type="button" class="btn ghost" id="refresh">تحديث</button>
      <button type="button" class="btn ghost" id="logout">خروج</button>
    </div>
  </header>
  <main class="wrap">
    <div class="chips" id="chips"></div>
    <form class="filters" id="filters">
      <input id="q" type="search" placeholder="رقم الطلب، اسم العميل أو الجوال" aria-label="بحث">
      <select id="status" aria-label="الحالة"></select>
      <label>من <input id="from" type="date"></label>
      <label>إلى <input id="to" type="date"></label>
      <button type="submit" class="btn primary">بحث</button>
      <button type="button" class="btn ghost" id="reset">مسح</button>
    </form>
    <p class="count" id="count"></p>
    <div class="list" id="list"></div>
    <div class="pager" id="pager"></div>
  </main>
</div>

<div class="overlay" id="detail" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="dTitle">
    <div class="sheet-head">
      <h2 id="dTitle"></h2>
      <button type="button" class="x" id="dClose" aria-label="إغلاق">✕</button>
    </div>
    <div class="sheet-body" id="dBody"></div>
  </div>
</div>
<script src="/admin/app.js"></script>
</body>
</html>`;

export const ADMIN_CSS = String.raw`
:root{--teal-deep:#0F5C57;--teal:#13857B;--orange:#F2941B;--lime:#E9F3CF;--ink:#12302E;--muted:#4F6663;--paper:#FBFCF6;--line:#D7E3CF;--danger:#B4321F;--white:#fff}
*{box-sizing:border-box}
html,body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 "IBM Plex Sans Arabic","Segoe UI",Tahoma,system-ui,sans-serif}
[hidden]{display:none!important}
button,input,select,textarea{font:inherit}
.brand{direction:ltr;font-size:1.25rem;font-weight:400;color:var(--teal)}
.brand .o{color:var(--orange)} .brand b{color:var(--teal-deep);font-weight:800} .brand small{font-size:.8rem;color:var(--muted);margin-inline-start:.4rem}
.btn{border:1.5px solid transparent;border-radius:999px;padding:.5em 1.1em;font-weight:700;cursor:pointer;min-height:40px}
.btn.primary{background:var(--orange);color:var(--ink)} .btn.primary:hover{background:#F7A436}
.btn.ghost{background:transparent;border-color:var(--line);color:var(--teal-deep)} .btn.ghost:hover{background:var(--lime)}
.btn:disabled{opacity:.6;cursor:progress}
input,select,textarea{border:1.5px solid var(--line);border-radius:10px;padding:.5em .7em;background:var(--white);color:var(--ink);min-height:40px}
input:focus,select:focus,textarea:focus,.btn:focus-visible{outline:3px solid rgba(19,133,123,.3);outline-offset:1px}
.login{min-height:100vh;display:grid;place-items:center;padding:16px}
.card{background:var(--white);border:1px solid var(--line);border-radius:18px;padding:24px;width:min(380px,100%);display:grid;gap:10px;box-shadow:0 20px 50px -30px rgba(15,92,87,.5)}
.card h1{margin:0 0 6px;font-size:1.3rem;color:var(--teal-deep)}
.err{color:var(--danger);margin:0;min-height:1.2em;font-size:.9rem}
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;background:rgba(251,252,246,.95);border-bottom:1px solid var(--line)}
.bar-actions{display:flex;align-items:center;gap:8px}
.updated{font-size:.8rem;color:var(--muted)}
.wrap{max-width:1200px;margin:0 auto;padding:16px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.chip{border:1.5px solid var(--line);background:var(--white);border-radius:999px;padding:.3em .9em;cursor:pointer;font-weight:600;color:var(--ink)}
.chip b{margin-inline-start:.35em;font-family:ui-monospace,monospace}
.chip.on{border-color:var(--teal-deep);background:var(--teal-deep);color:var(--white)}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.filters #q{flex:1 1 240px}
.filters label{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:.9rem}
.count{color:var(--muted);font-size:.9rem;margin:6px 0}
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--white);border:1px solid var(--line);border-radius:14px;overflow:hidden}
th,td{padding:.65rem .8rem;text-align:start;border-bottom:1px solid var(--line);vertical-align:middle}
th{background:#F3F7EC;font-size:.85rem;color:var(--muted);font-weight:700}
tbody tr{cursor:pointer} tbody tr:hover{background:#FAFDF3} tbody tr:last-child td{border-bottom:0}
.num{font-family:ui-monospace,"Cascadia Mono",monospace;direction:ltr;unicode-bidi:isolate}
.st{display:inline-block;border-radius:999px;padding:.15em .75em;font-size:.82rem;font-weight:700;white-space:nowrap}
.st-pending{background:#FFF1D6;color:#8A5300} .st-confirmed{background:#DDF0FF;color:#0B4F80} .st-preparing{background:#EDE4FF;color:#4B2A93}
.st-shipped{background:#DCF3EE;color:#0F5C57} .st-out_for_delivery{background:#E3F6D5;color:#2F6B12} .st-delivered{background:#0F5C57;color:#fff}
.st-cancelled{background:#ECECEC;color:#555} .st-problem{background:#F8E3DE;color:#B4321F}
.empty{background:var(--white);border:1px dashed var(--line);border-radius:14px;padding:32px;text-align:center;color:var(--muted)}
.pager{display:flex;gap:8px;justify-content:center;margin:14px 0}
.overlay{position:fixed;inset:0;z-index:20;background:rgba(18,48,46,.45);display:flex;justify-content:flex-start}
.sheet{background:var(--paper);width:min(720px,100%);height:100%;display:flex;flex-direction:column;box-shadow:0 0 40px rgba(0,0,0,.25)}
.sheet-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:var(--teal-deep);color:var(--white)}
.sheet-head h2{margin:0;font-size:1.15rem}
.x{background:rgba(255,255,255,.12);color:var(--white);border:0;border-radius:10px;width:40px;height:40px;cursor:pointer;font-size:1rem}
.sheet-body{overflow:auto;padding:16px 18px 40px;display:grid;gap:14px}
.box{background:var(--white);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.box h3{margin:0 0 10px;font-size:1rem;color:var(--teal-deep)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0}
.kv dt{color:var(--muted)} .kv dd{margin:0;overflow-wrap:anywhere}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.row textarea{flex:1 1 100%;min-height:64px}
.links a{color:var(--teal);font-weight:700;margin-inline-end:14px}
.tl{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.tl li{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start}
.tl .dot{width:12px;height:12px;border-radius:50%;background:var(--teal);margin-top:.45em}
.tl small{display:block;color:var(--muted)}
.notes{display:grid;gap:8px;margin-bottom:10px}
.notes div{background:#F7FAF0;border-radius:10px;padding:.5em .8em}
.notes small{color:var(--muted);display:block}
.msg{margin:0;font-size:.9rem} .msg.bad{color:var(--danger)} .msg.good{color:var(--teal-deep)}
.tot td{font-weight:700}
@media (max-width:760px){
  thead{display:none}
  table,tbody,tr,td{display:block;width:100%}
  table{border:0;background:none;display:grid;gap:10px}
  tbody{display:grid;gap:10px}
  tbody tr{background:var(--white);border:1px solid var(--line);border-radius:14px;padding:10px 12px;display:grid;grid-template-columns:1fr auto;gap:2px 10px}
  td{border:0;padding:0}
  td.c-num{font-weight:700} td.c-st{grid-row:1;grid-column:2} td.c-date,td.c-city{color:var(--muted);font-size:.85rem}
  td.c-total{grid-column:2;grid-row:2 / span 2;align-self:end;font-weight:700}
  .items tbody tr{grid-template-columns:1fr auto}
  .bar .updated{display:none}
}`;

export const ADMIN_JS = String.raw`(function(){
"use strict";
var STATUS = {
  pending: "بانتظار التأكيد", confirmed: "تم تأكيد الطلب", preparing: "جاري تجهيز الطلب", shipped: "تم شحن الطلب",
  out_for_delivery: "خرج للتوصيل", delivered: "تم التوصيل", cancelled: "ملغي", problem: "يوجد مشكلة في الطلب"
};
var ORDER = ["pending","confirmed","preparing","shipped","out_for_delivery","delivered","cancelled","problem"];
var ERR = {
  wrong_password: "كلمة المرور غير صحيحة.", rate_limited: "محاولات كثيرة. انتظر دقيقة ثم حاول مرة أخرى.",
  admin_not_configured: "لم يتم إعداد كلمة مرور الإدارة بعد.", transition_not_allowed: "لا يمكن الانتقال إلى هذه الحالة من الحالة الحالية.",
  status_changed: "تغيّرت حالة الطلب من جهاز آخر. تم تحديث البيانات.", empty_note: "اكتب الملاحظة أولاً.", not_found: "الطلب غير موجود."
};
var $ = function(s){ return document.querySelector(s); };
function h(tag, attrs){
  var el = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function(k){
    var v = attrs[k];
    if (v == null || v === false) return;
    if (k === "text") el.textContent = v;
    else if (k === "class") el.className = v;
    else if (k.slice(0,2) === "on") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  });
  for (var i = 2; i < arguments.length; i++){
    var c = arguments[i];
    if (c == null || c === false) continue;
    (Array.isArray(c) ? c : [c]).forEach(function(x){ if (x != null && x !== false) el.appendChild(typeof x === "string" || typeof x === "number" ? document.createTextNode(String(x)) : x); });
  }
  return el;
}
var dtf = new Intl.DateTimeFormat("ar-SA-u-nu-latn-ca-gregory", { timeZone: "Asia/Riyadh", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
var fmtDate = function(iso){ return dtf.format(new Date(iso)); };
var money = function(n, cur){ return Number(n).toLocaleString("en-US") + " " + (cur === "SAR" ? "ر.س" : cur); };
var stBadge = function(s){ return h("span", { class: "st st-" + s, text: STATUS[s] || s }); };

async function api(path, opts){
  opts = opts || {};
  var init = { method: opts.method || "GET", credentials: "same-origin", headers: {} };
  if (opts.body){ init.method = "POST"; init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  if (init.method === "POST") init.headers["X-CG-Admin"] = "1";
  var r = await fetch("/admin/api" + path, init);
  var j = null; try { j = await r.json(); } catch (e) {}
  if (r.status === 401 && path !== "/login"){ showLogin(); throw new Error("unauthorized"); }
  if (!r.ok){ var e = new Error((j && j.error) || "error"); e.status = r.status; e.data = j; throw e; }
  return j;
}

/* ---------- login ---------- */
function showLogin(){ $("#app").hidden = true; $("#detail").hidden = true; $("#login").hidden = false; $("#pw").focus(); stopAuto(); }
$("#loginForm").addEventListener("submit", async function(e){
  e.preventDefault();
  var btn = $("#loginBtn"); btn.disabled = true; $("#loginErr").textContent = "";
  try { await api("/login", { body: { password: $("#pw").value } }); $("#pw").value = ""; start(); }
  catch (err){ $("#loginErr").textContent = ERR[err.message] || "تعذر تسجيل الدخول."; }
  finally { btn.disabled = false; }
});
$("#logout").addEventListener("click", async function(){ try { await api("/logout", { method: "POST" }); } catch (e) {} showLogin(); });

/* ---------- list ---------- */
var state = { q: "", status: "", from: "", to: "", page: 1 };
var timer = null;
function stopAuto(){ if (timer){ clearInterval(timer); timer = null; } }

var sel = $("#status");
sel.appendChild(h("option", { value: "", text: "كل الحالات" }));
ORDER.forEach(function(s){ sel.appendChild(h("option", { value: s, text: STATUS[s] })); });

$("#filters").addEventListener("submit", function(e){
  e.preventDefault();
  state = { q: $("#q").value.trim(), status: sel.value, from: $("#from").value, to: $("#to").value, page: 1 };
  load();
});
$("#reset").addEventListener("click", function(){ $("#q").value = ""; sel.value = ""; $("#from").value = ""; $("#to").value = ""; state = { q: "", status: "", from: "", to: "", page: 1 }; load(); });
$("#refresh").addEventListener("click", function(){ load(); });

async function load(){
  var p = new URLSearchParams();
  Object.keys(state).forEach(function(k){ if (state[k]) p.set(k, state[k]); });
  var data;
  try { data = await api("/orders?" + p.toString()); } catch (e){ if (e.message !== "unauthorized") $("#count").textContent = "تعذر تحميل الطلبات. تحقق من الاتصال ثم اضغط «تحديث»."; return; }
  renderChips(data.counts);
  var pending = data.counts.pending || 0;
  document.title = (pending ? "(" + pending + ") " : "") + "طلبات CalmGastro";
  $("#updated").textContent = "آخر تحديث " + new Intl.DateTimeFormat("ar-SA-u-nu-latn", { timeZone: "Asia/Riyadh", hour: "numeric", minute: "2-digit" }).format(new Date());
  $("#count").textContent = data.total ? "عدد النتائج: " + data.total : "";
  var list = $("#list"); list.textContent = "";
  if (!data.orders.length){ list.appendChild(h("div", { class: "empty", text: "لا توجد طلبات مطابقة." })); $("#pager").textContent = ""; return; }
  var tbody = h("tbody");
  data.orders.forEach(function(o){
    tbody.appendChild(h("tr", { tabindex: "0", onclick: function(){ openOrder(o.orderNumber); }, onkeydown: function(e){ if (e.key === "Enter") openOrder(o.orderNumber); } },
      h("td", { class: "c-num num", text: o.orderNumber }),
      h("td", { class: "c-name", text: o.customerName }),
      h("td", { class: "c-phone num", text: o.phone }),
      h("td", { class: "c-city", text: o.city + " · " + o.district }),
      h("td", { class: "c-date", text: fmtDate(o.createdAt) }),
      h("td", { class: "c-total", text: money(o.total, o.currency) }),
      h("td", { class: "c-st" }, stBadge(o.status))));
  });
  list.appendChild(h("table", null,
    h("thead", null, h("tr", null, ["رقم الطلب","العميل","الجوال","المدينة والحي","التاريخ","الإجمالي","الحالة"].map(function(t){ return h("th", { text: t }); }))),
    tbody));
  var pages = Math.ceil(data.total / data.pageSize), pager = $("#pager"); pager.textContent = "";
  if (pages > 1){
    pager.appendChild(h("button", { type: "button", class: "btn ghost", disabled: state.page <= 1, text: "السابق", onclick: function(){ state.page--; load(); } }));
    pager.appendChild(h("span", { class: "count", text: state.page + " / " + pages }));
    pager.appendChild(h("button", { type: "button", class: "btn ghost", disabled: state.page >= pages, text: "التالي", onclick: function(){ state.page++; load(); } }));
  }
}
function renderChips(counts){
  var box = $("#chips"); box.textContent = "";
  var all = ORDER.reduce(function(s, k){ return s + (counts[k] || 0); }, 0);
  box.appendChild(h("button", { type: "button", class: "chip" + (state.status ? "" : " on"), onclick: function(){ sel.value = ""; state.status = ""; state.page = 1; load(); } }, "الكل", h("b", { text: all })));
  ORDER.forEach(function(s){
    if (!counts[s] && s !== "pending") return;
    box.appendChild(h("button", { type: "button", class: "chip" + (state.status === s ? " on" : ""), onclick: function(){ sel.value = s; state.status = s; state.page = 1; load(); } }, STATUS[s], h("b", { text: counts[s] || 0 })));
  });
}

/* ---------- details ---------- */
var current = null;
function closeDetail(){ $("#detail").hidden = true; current = null; }
$("#dClose").addEventListener("click", closeDetail);
$("#detail").addEventListener("click", function(e){ if (e.target === $("#detail")) closeDetail(); });
document.addEventListener("keydown", function(e){ if (e.key === "Escape" && !$("#detail").hidden) closeDetail(); });

async function openOrder(n){
  $("#detail").hidden = false; $("#dTitle").textContent = n; $("#dBody").textContent = "جارٍ التحميل…";
  try { renderDetail(await api("/orders/" + encodeURIComponent(n))); }
  catch (e){ if (e.message !== "unauthorized") $("#dBody").textContent = ERR[e.message] || "تعذر تحميل الطلب."; }
}

function renderDetail(o){
  current = o;
  $("#dTitle").textContent = "طلب " + o.orderNumber;
  var body = $("#dBody"); body.textContent = "";
  var c = o.customer;
  var wa = "https://wa.me/" + c.phoneIntl + "?text=" + encodeURIComponent("مرحباً " + c.name + "، بخصوص طلبك رقم " + o.orderNumber + " من CalmGastro.");

  body.appendChild(h("section", { class: "box" }, h("h3", { text: "معلومات الطلب" }),
    h("dl", { class: "kv" },
      h("dt", { text: "رقم الطلب" }), h("dd", { class: "num", text: o.orderNumber }),
      h("dt", { text: "المعرّف الداخلي" }), h("dd", { class: "num", text: String(o.id) }),
      h("dt", { text: "التاريخ" }), h("dd", { text: fmtDate(o.createdAt) }),
      h("dt", { text: "الحالة" }), h("dd", null, stBadge(o.status)),
      h("dt", { text: "طريقة الدفع" }), h("dd", { text: o.paymentMethod === "cod" ? "الدفع عند الاستلام" : o.paymentMethod }),
      h("dt", { text: "لغة العميل" }), h("dd", { text: o.lang === "en" ? "الإنجليزية" : "العربية" }))));

  body.appendChild(h("section", { class: "box" }, h("h3", { text: "العميل والتوصيل" }),
    h("dl", { class: "kv" },
      h("dt", { text: "الاسم" }), h("dd", { text: c.name }),
      h("dt", { text: "الجوال" }), h("dd", { class: "num", text: c.phone }),
      h("dt", { text: "المدينة" }), h("dd", { text: c.city }),
      h("dt", { text: "الحي" }), h("dd", { text: c.district }),
      h("dt", { text: "العنوان" }), h("dd", { text: c.address }),
      h("dt", { text: "ملاحظات العميل" }), h("dd", { text: c.notes || "—" })),
    h("p", { class: "links" },
      h("a", { href: "tel:" + c.phone, text: "اتصال" }),
      h("a", { href: wa, target: "_blank", rel: "noopener noreferrer", text: "واتساب العميل" }),
      c.location ? h("a", { href: "https://www.google.com/maps?q=" + c.location.lat + "," + c.location.lng, target: "_blank", rel: "noopener noreferrer", text: "الموقع على الخريطة" }) : null)));

  var rows = o.items.map(function(i){ return h("tr", null, h("td", { text: i.name }), h("td", { class: "num", text: String(i.quantity) }), h("td", { text: money(i.unitPrice, o.currency) }), h("td", { text: money(i.lineTotal, o.currency) })); });
  var sum = function(label, v){ return h("tr", { class: "tot" }, h("td", { colspan: "3", text: label }), h("td", { text: v })); };
  body.appendChild(h("section", { class: "box" }, h("h3", { text: "المنتجات (" + o.boxes + " علب)" }),
    h("table", { class: "items" },
      h("thead", null, h("tr", null, ["المنتج","الكمية","سعر الوحدة","المجموع"].map(function(t){ return h("th", { text: t }); }))),
      h("tbody", null, rows,
        sum("المجموع الفرعي", money(o.subtotal, o.currency)),
        o.discount ? sum("خصم الباقات", "− " + money(o.discount, o.currency)) : null,
        sum("الشحن", o.shipping ? money(o.shipping, o.currency) : "مجاني"),
        sum("الإجمالي", money(o.total, o.currency))))));

  // status change: only the transitions the server allows from the current status
  var msg = h("p", { class: "msg", role: "status" });
  if (o.allowedNext.length){
    var s = h("select", { "aria-label": "الحالة الجديدة" }, o.allowedNext.map(function(x){ return h("option", { value: x, text: STATUS[x] }); }));
    var note = h("textarea", { placeholder: "ملاحظة على التغيير (اختياري)", maxlength: "1000" });
    var save = h("button", { type: "button", class: "btn primary", text: "تحديث الحالة" });
    save.addEventListener("click", async function(){
      if (s.value === "cancelled" && !confirm("تأكيد إلغاء الطلب " + o.orderNumber + "؟")) return;
      save.disabled = true; msg.className = "msg"; msg.textContent = "";
      try { renderDetail(await api("/orders/" + encodeURIComponent(o.orderNumber) + "/status", { body: { status: s.value, note: note.value, expectedStatus: o.status } })); load(); }
      catch (e){
        if (e.message === "unauthorized") return;
        if (e.message === "status_changed"){ openOrder(o.orderNumber); load(); }
        msg.className = "msg bad"; msg.textContent = ERR[e.message] || "تعذر تحديث الحالة."; save.disabled = false;
      }
    });
    body.appendChild(h("section", { class: "box" }, h("h3", { text: "تغيير الحالة" }), h("div", { class: "row" }, s, save, note), msg));
  } else {
    body.appendChild(h("section", { class: "box" }, h("h3", { text: "تغيير الحالة" }), h("p", { class: "msg", text: "الطلب في حالة نهائية (" + STATUS[o.status] + ") ولا يمكن تغييرها." })));
  }

  body.appendChild(h("section", { class: "box" }, h("h3", { text: "سجل الحالات" }),
    h("ol", { class: "tl" }, o.history.map(function(x){
      return h("li", null, h("span", { class: "dot" }), h("div", null, h("b", { text: STATUS[x.to] || x.to }),
        h("small", { text: fmtDate(x.at) + " · " + (x.by === "customer" ? "العميل (إنشاء الطلب)" : "الإدارة") + (x.from ? " · من «" + STATUS[x.from] + "»" : "") }),
        x.note ? h("small", { text: "ملاحظة: " + x.note }) : null));
    }))));

  var nInput = h("textarea", { placeholder: "ملاحظة داخلية (لا يراها العميل)", maxlength: "1000" });
  var nMsg = h("p", { class: "msg", role: "status" });
  var nBtn = h("button", { type: "button", class: "btn ghost", text: "إضافة ملاحظة" });
  nBtn.addEventListener("click", async function(){
    nBtn.disabled = true; nMsg.textContent = "";
    try { renderDetail(await api("/orders/" + encodeURIComponent(o.orderNumber) + "/notes", { body: { note: nInput.value } })); }
    catch (e){ if (e.message !== "unauthorized"){ nMsg.className = "msg bad"; nMsg.textContent = ERR[e.message] || "تعذر حفظ الملاحظة."; nBtn.disabled = false; } }
  });
  body.appendChild(h("section", { class: "box" }, h("h3", { text: "ملاحظات داخلية" }),
    h("div", { class: "notes" }, o.notes.length ? o.notes.map(function(x){ return h("div", null, x.note, h("small", { text: fmtDate(x.at) })); }) : h("p", { class: "msg", text: "لا توجد ملاحظات." })),
    h("div", { class: "row" }, nInput, nBtn), nMsg));
}

/* ---------- start ---------- */
function start(){
  $("#login").hidden = true; $("#app").hidden = false;
  load();
  stopAuto();
  timer = setInterval(function(){ if (!document.hidden && $("#detail").hidden) load(); }, 60000);   // new orders appear without reloading
}
api("/session").then(start).catch(function(e){ if (e.message !== "unauthorized") showLogin(); });
})();`;

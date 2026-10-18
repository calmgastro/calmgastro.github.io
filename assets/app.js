/* ============================================================
   الإعدادات التقنية (بيانات المنتج نفسها في product-data أعلاه)
   ============================================================ */
const PRODUCT = JSON.parse(document.getElementById("product-data").textContent);

/* ---------- اللغة: العربية من الصفحة نفسها، والإنجليزية من assets/i18n-en.js ---------- */
const LANG = window.CG_LANG === "en" && window.I18N_EN ? "en" : "ar";
const EN = LANG === "en" ? window.I18N_EN : null;
// t("نص {n}", { n: 3 }) يعيد النص بلغة الصفحة
const t = (ar, vars) => {
  const s = EN && EN.ui[ar] != null ? EN.ui[ar] : ar;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k] != null ? vars[k] : "") : s;
};
const localized = (o, keys) => EN ? Object.assign({}, o, ...keys.filter(k => o[k + "_en"] != null).map(k => ({ [k]: o[k + "_en"] }))) : o;
const STORE = Object.assign(localized(PRODUCT.store, ["currency", "payment", "shippingNote", "deliveryShort", "deliveryLong"]),
  { bundles: PRODUCT.store.bundles.map(b => localized(b, ["title", "program", "tag"])) });

const CONFIG = Object.assign({}, STORE, {
  orderEndpoint: "",                 // اختياري: رابط Google Apps Script أو أي API لحفظ الطلبات (POST JSON) — أضف نطاقه إلى connect-src في سياسة الأمان (CSP) أعلى index.html
  // تحويل الإحداثيات إلى مدينة وحي. لا يُرسل شيء إلا بعد أن يضغط العميل «تحديد موقعي» ويوافق.
  //  "nominatim": خدمة OpenStreetMap المجانية، بلا مفتاح (مناسبة لعدد طلبات قليل إلى متوسط)
  //  "endpoint":  خدمتك الخاصة لاحقاً (Backend أو Serverless) تستقبل GET ?lat=..&lng=.. وترجع {"city":"..","district":".."}
  //               ضع أي مفتاح سري داخل تلك الخدمة، وليس هنا
  //  "none":      بدون تحويل؛ يُرسل رابط الموقع فقط ويكتب العميل المدينة والحي بنفسه
  reverseGeocode: { provider: "nominatim", endpoint: "", timeoutMs: 8000 },
  // مساعد CalmGastro: رابط Cloudflare Worker الذي ينتهي بـ /chat (لا يوضع هنا أي مفتاح API)
  // إذا كان فارغاً يختفي زر المساعد (للمعاينة فقط أضف ?assistant إلى رابط الموقع)
  assistant: { endpoint: "https://calmgastro-assistant.calmgastro.workers.dev/chat" }
});

/* المكونات حسب الملصق، لكل ظرف واحد (من product-data) */
const INGREDIENTS = PRODUCT.ingredients.map(i => Object.assign({}, i, {
  name: EN ? i.name_en : (i.ltr ? `<bdi dir="ltr">${i.ar}</bdi>` : i.ar),
  role: EN ? i.role_en : i.role
}));

/* ---------- ترجمة الصفحة وزر تبديل اللغة ---------- */
(function i18n(){
  const html = document.documentElement;
  html.lang = LANG; html.dir = LANG === "en" ? "ltr" : "rtl";
  const btn = document.getElementById("langBtn");
  if (EN){ btn.textContent = "العربية"; btn.lang = "ar"; btn.setAttribute("aria-label", "التبديل إلى العربية"); }
  btn.addEventListener("click", () => {
    const next = LANG === "en" ? "ar" : "en";
    try { localStorage.setItem("cg-lang", next); } catch (_) {}
    const u = new URL(location.href);
    u.searchParams.set("lang", next); u.hash = "";
    location.href = u.href;
  });
  if (EN){
    const norm = s => s.replace(/\s+/g, " ").trim();
    const AR = /[\u0600-\u06FF]/;
    const SKIP = "script,style,svg,datalist,#bundles,#ingList,#readout,#aiLog,#glassFill,[data-no-i18n]";
    for (const el of document.body.querySelectorAll("*")){
      if (!el.isConnected || !AR.test(el.textContent) || el.closest(SKIP)) continue;
      const en = EN.html[norm(el.innerHTML)];
      if (en != null) el.innerHTML = en;
    }
    const missing = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());){
      if (!AR.test(n.nodeValue) || n.parentElement.closest(SKIP)) continue;
      const en = EN.text[norm(n.nodeValue)];
      if (en != null) n.nodeValue = n.nodeValue.match(/^\s*/)[0] + en + n.nodeValue.match(/\s*$/)[0];
      else missing.push(norm(n.nodeValue));
    }
    for (const el of document.querySelectorAll("[placeholder],[aria-label],[alt],[title]"))
      for (const a of ["placeholder", "aria-label", "alt", "title"]){
        const v = el.getAttribute(a);
        if (v && EN.attr[norm(v)] != null) el.setAttribute(a, EN.attr[norm(v)]);
      }
    document.title = EN.meta.title;
    const meta = (sel, v) => { const m = document.querySelector(sel); if (m) m.setAttribute("content", v); };
    meta('meta[name="description"]', EN.meta.description);
    meta('meta[property="og:title"]', EN.meta.ogTitle);
    meta('meta[property="og:description"]', EN.meta.ogDescription);
    document.getElementById("cities").innerHTML = EN.cities.map(c => `<option value="${c}">`).join("");
    // عند تعديل نص عربي في الصفحة بدون تحديث مفتاحه في i18n-en.js يظهر هنا
    if (missing.length) console.warn("[i18n] untranslated:", missing);
  }
  html.classList.remove("i18n-wait");
})();

(function(){
  const $ = (s, el=document) => el.querySelector(s);
  const $$ = (s, el=document) => [...el.querySelectorAll(s)];
  const fmt = n => n.toLocaleString("en-US");
  const money = n => `${fmt(n)} ${CONFIG.currency}`;

  document.getElementById("yr").textContent = new Date().getFullYear();
  $$("[data-cfg]").forEach(el => { const v = CONFIG[el.dataset.cfg]; if (v) el.textContent = v; });

  /* ---------- whatsapp links ---------- */
  const waLink = msg => `https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent(msg)}`;
  $$(".js-wa").forEach(a => {
    a.href = waLink(t("السلام عليكم، عندي استفسار عن CalmGastro"));
    a.target = "_blank"; a.rel = "noopener";
  });

  /* ---------- glass + ingredient list ---------- */
  const fill = $("#glassFill"), list = $("#ingList"), glass = $("#glass"), readout = $("#readout");
  // ارتفاع الطبقة: الجذر التربيعي للجرعة حتى تظهر المكونات الصغيرة، مع حد أدنى
  const FILL = 82; // نسبة امتلاء الكوب
  const roots = INGREDIENTS.map(i => Math.sqrt(i.w));
  const sum = roots.reduce((a,b)=>a+b,0);
  const MIN = 2.6;
  let raw = roots.map(r => Math.max(MIN, r / sum * FILL));
  const scale = FILL / raw.reduce((a,b)=>a+b,0);
  raw = raw.map(h => h * scale);

  // الأكبر في القاع: نضيفها بترتيب عكسي لأن الحاوية تبدأ من الأسفل
  INGREDIENTS.slice().reverse().forEach((ing, k) => {
    const i = INGREDIENTS.length - 1 - k;
    const b = document.createElement("button");
    b.className = "layer"; b.type = "button";
    b.style.height = raw[i] + "%"; b.style.background = ing.color;
    b.style.transitionDelay = `0ms, 0ms, ${i * 70}ms`; // التأخير للتعبئة فقط وليس للتحديد
    b.dataset.i = i; b.setAttribute("aria-label", `${ing.name.replace(/<[^>]+>/g, "")} ${ing.dose}`);
    fill.appendChild(b);
  });

  INGREDIENTS.forEach((ing, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<button type="button" class="ing" data-i="${i}" aria-pressed="false">
        <span class="sw" style="background:${ing.color}"></span>
        <span class="nm">${ing.name}${ing.efsa ? '<span class="efsa">EFSA</span>' : ''}<small dir="ltr" style="text-align:right">${ing.en}</small></span>
        <span class="ds">${ing.dose}</span></button>`;
    list.appendChild(li);
  });

  function select(i){
    const ing = INGREDIENTS[i];
    glass.classList.add("is-focus");
    $$(".layer", fill).forEach(l => l.classList.toggle("on", +l.dataset.i === i));
    $$(".ing", list).forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.i === i)));
    readout.innerHTML = `<div class="r-name">${ing.name}</div><div class="r-dose" dir="ltr" style="text-align:right">${ing.dose}</div><p>${ing.role}</p>`;
  }
  fill.addEventListener("click", e => { const l = e.target.closest(".layer"); if (l) select(+l.dataset.i); });
  list.addEventListener("click", e => { const b = e.target.closest(".ing"); if (b) select(+b.dataset.i); });
  select(0);

  /* ---------- scroll reveal + glass fill ---------- */
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if ("IntersectionObserver" in window && !reduce){
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        en.target.classList.add(en.target === glass ? "filled" : "in");
        io.unobserve(en.target);
      });
    }, { threshold: .15 });
    $$(".rv").forEach(el => io.observe(el));
    io.observe(glass);
  } else {
    $$(".rv").forEach(el => el.classList.add("in"));
    glass.classList.add("filled");
  }

  /* ---------- bundles ---------- */
  const box = $("#bundles");
  CONFIG.bundles.forEach(b => {
    const save = b.was ? Math.round((1 - b.price / b.was) * 100) : 0;
    const per = Math.round(b.price / (b.boxes * 30) * 10) / 10;  // 7.5 لا تُقرّب إلى 8 حتى يظهر فرق العروض
    const lab = document.createElement("label");
    lab.className = "bundle";
    lab.innerHTML = `
      <input type="radio" name="bundle" value="${b.id}" ${b.id === CONFIG.defaultBundle ? "checked" : ""}>
      <span class="card">
        <span class="radio" aria-hidden="true"></span>
        <span><span class="b-title">${b.title}</span><br><span class="b-sub">${t("{n} ظرفاً", { n: b.boxes * 30 })}</span><br><span class="b-prog">${b.program}</span><br><span class="b-sub">${t("≈ {per} {cur} لليوم", { per, cur: CONFIG.currency })}</span></span>
        <span class="b-price">
          <span class="now">${money(b.price)}</span><br>
          ${b.was ? `<span class="was">${money(b.was)}</span> <span class="b-save">${t("وفّر {save}%", { save })}</span>` : ""}
        </span>
      </span>
      ${b.tag ? `<span class="tag">${b.tag}</span>` : ""}`;
    box.appendChild(lab);
  });
  $("#bundles legend").textContent = t("اختر العرض");
  const current = () => CONFIG.bundles.find(b => b.id === ($("input[name=bundle]:checked")||{}).value) || CONFIG.bundles[0];
  function updateSummary(){
    if ($("#f-wholesale").checked){
      $("#sumLabel").textContent = t("استفسار عن طلب بالجملة");
      $("#sumTotal").textContent = t("حسب الكمية");
      return;
    }
    const b = current();
    $("#sumLabel").textContent = t("{title} · {n} ظرفاً · {program}", { title: b.title, n: b.boxes * 30, program: b.program });
    $("#sumTotal").textContent = money(b.price);
  }
  box.addEventListener("change", updateSummary);
  updateSummary();
  $("#mbarPrice").textContent = money(Math.min(...CONFIG.bundles.map(b => b.price)));
  // شريط «اطلب الآن» وزر واتساب العائم يختفيان داخل قسم الطلب حتى لا يغطيا النموذج وزر التأكيد
  // زرا واتساب والمساعد العائمان يختفيان في الجوال فقط (فوق نموذج الطلب أو زر «اطلب» في البداية) حتى لا يغطيا أي منهما
  if ("IntersectionObserver" in window){
    const seen = { order: false };
    const ctas = new Set();   // أزرار «اطلب» الرئيسية الظاهرة الآن (أعلى الصفحة وآخرها)
    const mobile = matchMedia("(max-width: 640px)");
    const apply = () => {
      $(".mbar").classList.toggle("away", seen.order);
      [$(".wa-float"), $("#aiLauncher")].forEach(el => el.classList.toggle("away", mobile.matches && (seen.order || ctas.size > 0)));
      $("#aiLauncher").classList.toggle("compact", !mobile.matches && seen.order);
    };
    // الهامش يتجاهل حافة القسم الملاصقة للشاشة (أو المختفية تحت الترويسة) حتى لا تختفي الأزرار بلا داعٍ
    new IntersectionObserver(([en]) => { seen.order = en.isIntersecting; apply(); }, { rootMargin: "-80px 0px -40px 0px" }).observe($("#order"));
    const ctaIO = new IntersectionObserver(entries => { entries.forEach(en => en.isIntersecting ? ctas.add(en.target) : ctas.delete(en.target)); apply(); });
    $$(".hero-copy .cta-row, .final .btn").forEach(el => ctaIO.observe(el));
    mobile.addEventListener("change", apply);
  }

  /* ---------- form ---------- */
  const form = $("#orderForm");
  const submitBtn = $("#submitBtn");
  const isWholesale = () => form.elements.wholesale.checked;
  const selected = () => CONFIG.bundles.find(b => b.id === ($("input[name=bundle]:checked")||{}).value) || null;
  const toLatinDigits = v => v
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0));
  const normPhone = v => {
    let d = toLatinDigits(v).replace(/[^\d]/g, "").replace(/^00/, "");
    if (d.startsWith("966")) d = "0" + d.slice(3);
    if (d.length === 9 && d.startsWith("5")) d = "0" + d;
    return d;
  };
  const boxesLabel = n => EN ? (n === 1 ? "1 box" : `${n} boxes`)
    : n === 1 ? "علبة واحدة" : n === 2 ? "علبتان" : n <= 10 ? `${n} علب` : `${n} علبة`;

  // موقع العميل: يبقى في الذاكرة فقط لهذه الصفحة، ولا يُحفظ في المتصفح أو أي قاعدة بيانات
  let loc = null; // { lat, lng }

  const rules = {
    name:     v => v.trim().length >= 2 || t("اكتب اسمك"),
    phone:    v => /^05\d{8}$/.test(normPhone(v)) || t("اكتب رقم جوال سعودي صحيح يبدأ بـ 05 ومكوّن من 10 أرقام"),
    // المدينة والحي مطلوبان إلا إذا حدد العميل موقعه (رابط الخريطة يكفي للتوصيل)
    city:     v => v.trim().length >= 2 || !!loc || t("اكتب مدينتك أو استخدم «تحديد موقعي»"),
    district: v => v.trim().length >= 2 || !!loc || t("اكتب اسم الحي أو استخدم «تحديد موقعي»")
  };
  function check(name){
    const input = form.elements[name], res = rules[name](input.value);
    const ok = res === true;
    input.setAttribute("aria-invalid", ok ? "false" : "true");
    $("#e-" + name).textContent = ok ? "" : res;
    return ok;
  }
  function checkBundle(){
    const b = selected();
    const ok = isWholesale() || (!!b && Number.isInteger(b.boxes) && b.boxes > 0);
    $("#e-bundle").textContent = ok ? "" : t("اختر أحد العروض");
    return ok;
  }
  Object.keys(rules).forEach(n => {
    const el = form.elements[n];
    el.addEventListener("blur", () => el.value && check(n));
    el.addEventListener("input", () => el.getAttribute("aria-invalid") === "true" && check(n));
  });
  box.addEventListener("change", checkBundle);

  /* ---------- طلب الجملة ---------- */
  function setSubmitLabel(){ submitBtn.textContent = isWholesale() ? t("أكّد الاستفسار") : t("أكّد الطلب"); }
  form.elements.wholesale.addEventListener("change", () => {
    const on = isWholesale();
    $("#wholesaleField").hidden = !on;
    $(".order").classList.toggle("is-wholesale", on);
    if (on) $("#e-bundle").textContent = "";
    setSubmitLabel();
    updateSummary();
  });

  /* ---------- تحديد الموقع (اختياري، عند الضغط فقط) ---------- */
  const locBtn = $("#locBtn"), locBtnText = $("#locBtnText"), locStatus = $("#locStatus");
  const LOC_FAIL = t("لم نتمكن من تحديد موقعك. يمكنك إدخال المدينة والحي يدوياً.");
  let locating = false;

  function showLoc(kind, lines, withClear){
    locStatus.className = "loc-status " + kind;
    locStatus.textContent = "";
    lines.forEach((t, i) => {
      const d = document.createElement("div");
      if (i === 0) d.className = "t";
      d.textContent = t;              // نص فقط؛ لا نُدخل HTML قادماً من خدمة خارجية
      locStatus.appendChild(d);
    });
    if (withClear){
      const c = document.createElement("button");
      c.type = "button"; c.className = "clear"; c.textContent = t("إزالة الموقع");
      c.addEventListener("click", clearLoc);
      locStatus.appendChild(c);
    }
    locStatus.hidden = false;
  }
  function clearLoc(){
    loc = null;
    locStatus.hidden = true; locStatus.textContent = "";
    locBtnText.textContent = t("تحديد موقعي تلقائياً");
    locBtn.focus();
  }

  // قابل للاستبدال: غيّر CONFIG.reverseGeocode فقط
  async function reverseGeocode(lat, lng){
    const rg = CONFIG.reverseGeocode || {};
    if (!rg.provider || rg.provider === "none") return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), rg.timeoutMs || 8000);
    try {
      if (rg.provider === "endpoint" && rg.endpoint){
        const r = await fetch(`${rg.endpoint}?lat=${lat}&lng=${lng}`, { signal: ctrl.signal });
        if (!r.ok) return null;
        const j = await r.json();
        return { city: String(j.city || "").trim(), district: String(j.district || "").trim() };
      }
      if (rg.provider === "nominatim"){
        const u = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&addressdetails=1&accept-language=${LANG}&lat=${lat}&lon=${lng}`;
        const r = await fetch(u, { signal: ctrl.signal });
        if (!r.ok) return null;
        const a = (await r.json()).address || {};
        return {
          city: (a.city || a.town || a.village || a.municipality || a.county || "").trim(),
          district: (a.suburb || a.neighbourhood || a.quarter || a.city_district || a.residential || a.hamlet || "").trim()
        };
      }
    } catch (_) { /* انقطاع أو مهلة: نكمل بدون أسماء */ }
    finally { clearTimeout(timer); }
    return null;
  }

  locBtn.addEventListener("click", () => {
    if (locating) return;
    if (!("geolocation" in navigator) || !window.isSecureContext){ showLoc("soft", [LOC_FAIL]); return; }
    locating = true; loc = null;
    locBtn.disabled = true;
    locBtnText.textContent = t("جارٍ تحديد موقعك…");
    locStatus.hidden = true;

    let settled = false;
    const finish = (label) => { locating = false; locBtn.disabled = false; locBtnText.textContent = label; };
    const fail = () => {
      if (settled) return; settled = true; clearTimeout(watchdog);
      finish(t("تحديد موقعي تلقائياً"));
      showLoc("soft", [LOC_FAIL]);
    };
    // بعض المتصفحات لا ترد أبداً إذا أُغلقت نافذة الإذن دون اختيار
    const watchdog = setTimeout(fail, 30000);

    try {
      navigator.geolocation.getCurrentPosition(async pos => {
        if (settled) return; settled = true; clearTimeout(watchdog);
        loc = { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6) };
        locBtnText.textContent = t("جارٍ تحديد المدينة والحي…");
        const place = await reverseGeocode(loc.lat, loc.lng);
        if (!loc) return; // أزال العميل الموقع أثناء الانتظار
        if (place && place.city) form.elements.city.value = place.city;
        if (place && place.district) form.elements.district.value = place.district;
        check("city"); check("district");
        const lines = [t("✓ تم تحديد موقعك")];
        if (place && (place.city || place.district)){
          lines.push(t("المدينة: {city} — الحي: {district}", { city: place.city || "—", district: place.district || "—" }));
          lines.push(t("يمكنك تعديل المدينة والحي إذا لم تكن دقيقة."));
        } else {
          lines.push(t("سنرسل رابط موقعك مع الطلب. يمكنك كتابة المدينة والحي يدوياً."));
        }
        finish(t("تحديث موقعي"));
        showLoc("ok", lines, true);
      }, fail, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
    } catch (_) { fail(); }
  });

  /* ---------- رسالة واتساب ---------- */
  function buildMessage(d){
    const out = [];
    const sec = (title, rows) => { const r = rows.filter(Boolean); if (r.length) out.push("", title, ...r); };
    if (d.wholesale){
      out.push(t("استفسار عن طلب بالجملة من موقع CalmGastro"), "", t("نوع الطلب: استفسار عن طلب بالجملة"));
    } else {
      out.push(t("طلب جديد من موقع CalmGastro"), "", t("نوع الطلب: طلب عادي"));
    }
    sec(t("بيانات العميل:"), [t("الاسم: {v}", { v: d.name }), t("رقم الجوال: {v}", { v: d.phone })]);
    if (d.wholesale){
      sec(t("تفاصيل الاستفسار:"), [d.wdetails]);
    } else {
      sec(t("تفاصيل الطلب:"), [
        t("العرض: {v}", { v: d.program }),
        t("الكمية: {q} ({n} ظرفاً)", { q: boxesLabel(d.boxes), n: d.boxes * 30 }),
        t("الإجمالي: {v}", { v: money(d.total) })
      ]);
    }
    sec(t("بيانات التوصيل:"), [d.city && t("المدينة: {v}", { v: d.city }), d.district && t("الحي: {v}", { v: d.district })]);
    if (d.mapUrl) sec(t("الموقع:"), [d.mapUrl]);
    sec(t("ملاحظات:"), [d.notes]);
    out.push("");
    if (d.wholesale){
      out.push(t("أرغب في الاستفسار عن أسعار وكميات طلبات الجملة."));
    } else {
      out.push(t("الدفع: الدفع عند الاستلام"), "", t("يرجى التواصل معي لتأكيد الطلب وموعد التوصيل."));
    }
    return out.join("\n");
  }

  /* ---------- تأكيد الطلب: يفتح واتساب برسالة جاهزة، والعميل هو من يضغط «إرسال» ---------- */
  let opening = false;
  form.addEventListener("submit", e => {
    e.preventDefault();
    if (opening) return;

    const bad = Object.keys(rules).filter(n => !check(n));
    const bundleOk = checkBundle();
    if (bad.length || !bundleOk){
      (bad.length ? form.elements[bad[0]] : $("input[name=bundle]")).focus();
      return;
    }

    opening = true;
    submitBtn.disabled = true;
    submitBtn.textContent = t("جارٍ تجهيز الرسالة…");

    const wholesale = isWholesale();
    const b = selected();
    const data = {
      wholesale,
      name: form.elements.name.value.trim(),
      phone: normPhone(form.elements.phone.value),
      city: form.elements.city.value.trim(),
      district: form.elements.district.value.trim(),
      notes: form.elements.notes.value.trim(),
      wdetails: wholesale ? form.elements.wdetails.value.trim() : "",
      bundle: b ? b.title : "", program: b ? b.program : "", boxes: b ? b.boxes : 0, total: b ? b.price : 0,
      mapUrl: loc ? `https://www.google.com/maps?q=${loc.lat},${loc.lng}` : ""
    };
    const link = waLink(buildMessage(data));

    // يجب أن يُفتح واتساب مباشرة داخل حدث الضغط (بدون انتظار) حتى لا يحجبه Safari
    const win = window.open(link, "_blank");
    if (win) { try { win.opener = null; } catch (_) {} }

    $("#okTitle").textContent = wholesale ? t("تم تجهيز استفسارك في واتساب") : t("تم تجهيز طلبك في واتساب");
    $("#okText").textContent = win
      ? (wholesale ? t("ستفتح لك محادثة واتساب برسالة الاستفسار جاهزة. اضغط إرسال لإكمال استفسارك.") : t("ستفتح لك محادثة واتساب برسالة الطلب جاهزة. اضغط إرسال لإكمال طلبك."))
      : (wholesale ? t("لم يُفتح واتساب تلقائياً. اضغط الزر بالأسفل، ثم اضغط إرسال لإكمال استفسارك.") : t("لم يُفتح واتساب تلقائياً. اضغط الزر بالأسفل، ثم اضغط إرسال لإكمال طلبك."));
    const okWa = $("#okWa");
    okWa.href = link;
    okWa.textContent = wholesale ? t("إرسال الاستفسار عبر واتساب") : t("إرسال الطلب عبر واتساب");
    form.classList.add("done");
    form.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });

    // اختياري: حفظ نسخة من الطلب في خدمتك. لا يؤخر فتح واتساب، ولا يتضمن إحداثيات العميل
    if (CONFIG.orderEndpoint){
      const { mapUrl, ...rest } = data;
      try {
        fetch(CONFIG.orderEndpoint, { method:"POST", mode:"no-cors", keepalive:true,
          headers:{ "Content-Type":"text/plain;charset=utf-8" },
          body: JSON.stringify({ ...rest, hasLocation: !!mapUrl, currency: CONFIG.currency, at: new Date().toISOString() }) }).catch(() => {});
      } catch (_) {}
    }
    opening = false;
  });

  // يرجع للنموذج بنفس البيانات لتعديلها وإعادة التأكيد
  $("#editOrder").addEventListener("click", () => {
    form.classList.remove("done");
    submitBtn.disabled = false;
    setSubmitLabel();
    form.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    form.elements.name.focus({ preventScroll: true });
  });

  /* ============================================================
     مساعد CalmGastro
     - الأسئلة السريعة تُجاب هنا مباشرة من بيانات الصفحة (بدون ذكاء اصطناعي وبدون تكلفة)
     - الأسئلة المكتوبة تذهب إلى CONFIG.assistant.endpoint (Cloudflare Worker) فقط
     - لا يُرسل للمساعد أي شيء من نموذج الطلب (الاسم، الجوال، الموقع، العنوان)
     ============================================================ */
  const AI = CONFIG.assistant || {};
  const aiPreview = /[?&]assistant(=|&|$)/.test(location.search);
  if (AI.endpoint || aiPreview){
    const launcher = $("#aiLauncher"), panel = $("#aiPanel"), log = $("#aiLog");
    const aiForm = $("#aiForm"), aiInput = $("#aiInput"), aiSend = $("#aiSend");
    const UNAVAILABLE = t("المساعد غير متاح حالياً، يمكنك التواصل معنا مباشرة عبر WhatsApp.");
    const isMobile = () => matchMedia("(max-width: 640px), (max-height: 500px)").matches;   // الجوال عمودياً أو أفقياً
    const plain = html => html.replace(/<[^>]+>/g, "");
    const lines = (sel, root = document) => $$(sel, root).map(el => el.textContent.replace(/\s+/g, " ").trim()).filter(Boolean);
    let history = [], busy = false, started = false, lastQuestion = "";

    /* ---------- إجابات الأسئلة السريعة (من نفس مصدر بيانات الصفحة) ---------- */
    const bundleLine = b => {
      const save = b.was ? t("بدل {was} (وفّر {save}%)", { was: money(b.was), save: Math.round((1 - b.price / b.was) * 100) }) : "";
      return t("- {title} ({n} ظرفاً · {program}): **{price}** {save}", { title: b.title, n: b.boxes * 30, program: b.program, price: money(b.price), save }).trim();
    };
    const QUICK = [
      { q: t("ما مكونات المنتج؟"), answer: () => ({
          text: [t("كل ظرف يحتوي على:"), ...INGREDIENTS.map(i => `- ${plain(i.name)}: ${i.dose}`),
                 "", t("الجرعات مطابقة للملصق الخلفي للعلبة، ويحتوي المنتج على مُحلٍّ.")].join("\n"),
          actions: ["order"] }) },
      { q: t("كيف أستخدم المنتج؟"), answer: () => {
          const steps = $$("#how .step").map((st, i) => `${i + 1}. ${lines("h3", st)[0]}: ${lines("p", st)[0]}`);
          const heavy = $("#safety .plan .accent");
          return { text: [...steps, "", lines("#how .tip")[0] || "",
                          heavy ? `\n${lines("h3", heavy)[0]}: ${lines(".dose span", heavy).map((x, i) => EN && i ? x.charAt(0).toLowerCase() + x.slice(1) : x).join(t("، ثم "))}. ${lines("p.after", heavy)[0] || ""}` : ""]
                          .filter(Boolean).join("\n"), actions: ["order"] };
        } },
      { q: t("ما فوائد المنتج؟"), answer: () => ({
          text: [...$$("#why .problem").map(c => `- **${lines(".q", c)[0]}**: ${lines("p", c)[0]}`),
                 "", lines("#results .disclaim")[0] || ""].filter(Boolean).join("\n"),
          actions: ["order"] }) },
      { q: t("كم السعر؟"), answer: () => ({
          text: [t("أسعار العروض الحالية:"), ...CONFIG.bundles.map(bundleLine), "", t("{ship}، و{pay}.", { ship: CONFIG.shippingNote, pay: CONFIG.payment })].join("\n"),
          actions: ["order"] }) },
      { q: t("ما الفرق بين العروض؟"), answer: () => ({
          text: [...CONFIG.bundles.map(b => t("- **{title}** {tag}: {n} ظرفاً تكفي {dur}، بسعر {price}، أي حوالي {per} {cur} لليوم.", {
                   title: b.title, tag: b.tag ? `(${b.tag})` : "", n: b.boxes * 30, dur: b.program.replace("برنامج ", ""), program: b.program,
                   price: money(b.price), per: Math.round(b.price / (b.boxes * 30) * 10) / 10, cur: CONFIG.currency })),
                 "", lines("#order .sec-head p")[0] || ""].filter(Boolean).join("\n"),
          actions: ["order"] }) },
      { q: t("كيف أطلب؟"), answer: () => ({
          text: [t("أكيد، يمكنك إكمال طلبك من قسم الطلب، وسأساعدك إذا كان لديك أي سؤال عن المنتج."),
                 t("1. اختر العرض المناسب."), t("2. اكتب بيانات التوصيل."), t("3. اضغط «أكّد الطلب» فيفتح واتساب برسالة طلبك جاهزة، ثم اضغط إرسال."),
                 "", t("{pay}، والتوصيل {del}.", { pay: CONFIG.payment, del: CONFIG.deliveryShort })].join("\n"),
          actions: ["order"] }) },
      { q: t("هل يوجد بيع بالجملة؟"), answer: () => ({
          text: [t("لدينا خيار للاستفسار عن طلبات الجملة. يمكنك اختيار «لدي طلب بالجملة» في نموذج الطلب، واكتب الكمية التي تحتاجها، ونرد عليك بالأسعار عبر واتساب."),
                 ...[...$$(".announce-sub a")].map(a => t("أو راسلنا على الإيميل: {email}", { email: a.textContent.trim() }))].join("\n"),
          actions: ["wholesale", "whatsapp"] }) }
    ];

    /* ---------- عرض الرسائل ---------- */
    const scrollDown = () => { log.scrollTop = log.scrollHeight; };
    function richText(el, text){
      // نص آمن: لا نُدخل HTML قادماً من الخادم؛ فقط **عريض** وتحويل القوائم إلى نقاط
      text.split("\n").forEach((line, i) => {
        if (i) el.appendChild(document.createTextNode("\n"));
        line = line.replace(/^\s*[-*•]\s+/, "• ")
                   .replace(/(\d[\d.,]*) (ر\.س|SAR)/g, "$1 $2");   // السعر وعملته لا ينفصلان على سطرين
        line.split(/\*\*(.+?)\*\*/g).forEach((part, k) => {
          if (!part) return;
          const box = k % 2 ? el.appendChild(document.createElement("strong")) : el;
          // مصطلحات لاتينية مثل 5-HTP تبقى بترتيبها الصحيح داخل النص العربي
          part.split(/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)/).forEach((seg, n) => {
            if (!seg) return;
            if (n % 2){ const t = document.createElement("bdi"); t.dir = "ltr"; t.textContent = seg; box.appendChild(t); }
            else box.appendChild(document.createTextNode(seg));
          });
        });
      });
    }
    function addMsg(role, text){
      const d = document.createElement("div");
      d.className = "ai-msg " + role;
      if (role === "bot") richText(d, text); else d.textContent = text;
      log.appendChild(d); scrollDown();
      return d;
    }
    const ICON_WA = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.04 2a9.9 9.9 0 0 0-8.5 15l-1.4 5.1 5.2-1.4A9.9 9.9 0 1 0 12.04 2Zm4.5 12c-.25-.12-1.46-.72-1.69-.8-.23-.08-.39-.12-.55.12-.16.25-.63.8-.78.96-.14.17-.29.19-.53.07a6.7 6.7 0 0 1-3.32-2.9c-.25-.43.25-.4.72-1.33.08-.16.04-.3-.02-.42-.06-.12-.55-1.33-.76-1.82-.2-.48-.4-.41-.55-.42h-.47a.9.9 0 0 0-.65.3 2.7 2.7 0 0 0-.85 2.02 4.7 4.7 0 0 0 1 2.5 10.8 10.8 0 0 0 4.13 3.65c1.54.66 2.14.72 2.91.6.47-.07 1.46-.6 1.66-1.17.2-.58.2-1.07.15-1.17-.06-.1-.22-.17-.46-.29Z"/></svg>';
    function addActions(actions){
      const wanted = [...new Set(actions || [])].filter(a => ["order", "wholesale", "whatsapp"].includes(a));
      if (!wanted.length) return;
      const row = document.createElement("div");
      row.className = "ai-actions";
      wanted.forEach(a => {
        if (a === "whatsapp"){
          const l = document.createElement("a");
          l.className = "ai-act wa"; l.target = "_blank"; l.rel = "noopener";
          l.href = waLink(t("السلام عليكم، عندي سؤال عن CalmGastro") + (lastQuestion ? `:\n${lastQuestion}` : ""));
          l.innerHTML = ICON_WA + `<span>${t("تواصل معنا عبر WhatsApp")}</span>`;
          row.appendChild(l);
          return;
        }
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ai-act " + a;
        b.textContent = a === "order" ? t("اطلب الآن") : t("استفسار عن الجملة");
        b.addEventListener("click", () => goToOrder(a === "wholesale"));
        row.appendChild(b);
      });
      log.appendChild(row); scrollDown();
    }
    function goToOrder(wholesale){
      closePanel(false);
      const wb = $("#f-wholesale");
      if (wholesale && !wb.checked){ wb.checked = true; wb.dispatchEvent(new Event("change", { bubbles: true })); }
      $("#order").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      const target = wholesale ? $("#f-wdetails") : $("#bundles input:checked") || $("#f-name");
      setTimeout(() => target && target.focus({ preventScroll: true }), reduce ? 0 : 500);
    }
    function showTyping(){
      const t = document.createElement("div");
      t.className = "ai-typing"; t.setAttribute("aria-label", window.I18N_EN && LANG === "en" ? window.I18N_EN.ui["المساعد يكتب"] : "المساعد يكتب");
      t.innerHTML = "<span></span><span></span><span></span>";
      log.appendChild(t); scrollDown();
      return t;
    }
    function welcome(){
      addMsg("bot", t("أهلاً بك 👋 أنا مساعد CalmGastro. اختر سؤالاً سريعاً أو اكتب سؤالك."));
      const chips = document.createElement("div");
      chips.className = "ai-chips";
      QUICK.forEach((item, i) => {
        const c = document.createElement("button");
        c.type = "button"; c.className = "ai-chip"; c.textContent = item.q;
        c.addEventListener("click", () => ask(item.q, i));
        chips.appendChild(c);
      });
      log.appendChild(chips);
    }

    /* ---------- السؤال والإجابة ---------- */
    function remember(role, text){
      history.push({ role, text: text.slice(0, 600) });
      history = history.slice(-6);
    }
    async function ask(raw, quickIndex){
      const q = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 300);
      if (!q || busy) return;
      addMsg("user", q);
      lastQuestion = q;

      if (quickIndex != null){
        const r = QUICK[quickIndex].answer();
        addMsg("bot", r.text); addActions(r.actions);
        remember("user", q); remember("assistant", r.text);
        return;
      }
      if (!AI.endpoint){ addMsg("bot", UNAVAILABLE); addActions(["whatsapp"]); return; }

      busy = true; aiSend.disabled = true;
      const typing = showTyping();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      let answer = "", actions = [];
      try {
        const r = await fetch(AI.endpoint, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
          body: JSON.stringify({ message: q, history, lang: LANG })
        });
        const j = r.ok ? await r.json() : null;
        if (j && typeof j.answer === "string" && j.answer.trim()){ answer = j.answer.trim(); actions = Array.isArray(j.actions) ? j.actions : []; }
      } catch (_) { /* انقطاع أو مهلة: نعرض البديل */ }
      finally { clearTimeout(timer); typing.remove(); busy = false; aiSend.disabled = false; }

      if (!answer){ addMsg("bot", UNAVAILABLE); addActions(["whatsapp"]); return; }
      addMsg("bot", answer); addActions(actions);
      remember("user", q); remember("assistant", answer);
    }
    aiForm.addEventListener("submit", e => {
      e.preventDefault();
      const q = aiInput.value;
      if (!q.trim() || busy) return;
      aiInput.value = "";
      ask(q);
    });

    /* ---------- فتح وإغلاق، وتكيّف مع لوحة المفاتيح في الجوال ---------- */
    function fitViewport(){
      const vv = window.visualViewport;
      if (panel.hidden || !isMobile() || !vv){ panel.style.height = ""; panel.style.top = ""; return; }
      panel.style.height = vv.height + "px";
      panel.style.top = vv.offsetTop + "px";
      scrollDown();
    }
    if (window.visualViewport){
      visualViewport.addEventListener("resize", fitViewport);
      visualViewport.addEventListener("scroll", fitViewport);
    }
    function openPanel(){
      panel.hidden = false;
      document.body.classList.add("ai-open");
      launcher.setAttribute("aria-expanded", "true");
      if (!started){ started = true; welcome(); }
      fitViewport();
      // في الجوال لا نفتح لوحة المفاتيح تلقائياً حتى تظهر الأسئلة السريعة كاملة
      (isMobile() ? panel : aiInput).focus({ preventScroll: true });
    }
    function closePanel(returnFocus = true){
      panel.hidden = true;
      document.body.classList.remove("ai-open");
      launcher.setAttribute("aria-expanded", "false");
      panel.style.height = ""; panel.style.top = "";
      if (returnFocus && !launcher.classList.contains("away")) launcher.focus({ preventScroll: true });
    }
    launcher.hidden = false;
    launcher.addEventListener("click", openPanel);
    $("#aiClose").addEventListener("click", () => closePanel());
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !panel.hidden) closePanel(); });
  }
})();

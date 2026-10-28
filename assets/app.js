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
  // خادم الطلبات (orders/ على Cloudflare Workers + D1): يُنشئ الطلب ويعطي رقمه. نطاقه مضاف إلى connect-src في CSP
  // العنوان الأول على نطاقنا (لا تحجبه الشبكات)، والثاني احتياطي يُستخدم تلقائياً إن تعذّر الاتصال بالأول
  ordersApi: { endpoints: ["https://api.vitamik.com", "https://calmgastro-orders.calmgastro.workers.dev"] },
  // تحويل الإحداثيات إلى مدينة وحي. لا يُرسل شيء إلا بعد أن يضغط العميل «تحديد موقعي» ويوافق.
  //  "nominatim": خدمة OpenStreetMap المجانية، بلا مفتاح (مناسبة لعدد طلبات قليل إلى متوسط)
  //  "endpoint":  خدمتك الخاصة لاحقاً (Backend أو Serverless) تستقبل GET ?lat=..&lng=.. وترجع {"city":"..","district":".."}
  //               ضع أي مفتاح سري داخل تلك الخدمة، وليس هنا
  //  "none":      بدون تحويل؛ يُرسل رابط الموقع فقط ويكتب العميل المدينة والحي بنفسه
  reverseGeocode: { provider: "nominatim", endpoint: "", timeoutMs: 8000 },
  // مساعد CalmGastro: رابط Cloudflare Worker الذي ينتهي بـ /chat (لا يوضع هنا أي مفتاح API)
  // إذا كان فارغاً يختفي زر المساعد (للمعاينة فقط أضف ?assistant إلى رابط الموقع)
  assistant: { endpoints: ["https://assistant.vitamik.com/chat", "https://calmgastro-assistant.calmgastro.workers.dev/chat"] }
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
  /* ---------- فيديو «تعرف على كالم كاسترو»: نافذة تظهر من موضع الزر، والفيديو يُحمَّل عند أول فتح.
     أول زيارة: عند وصول الزائر للزر يظهر مؤشر يضغطه تلقائياً ويُفتح الفيديو بدون صوت (المتصفحات تمنع الصوت بلا لمسة)،
     مع زر «اضغط لتشغيل الصوت». مرة واحدة لكل زائر، ولا يحدث إن كان مشغولاً بالسلة أو المساعد أو الطلب ---------- */
  (function introVideo(){
    const openBtn = document.getElementById("introOpen"), dlg = document.getElementById("introDialog");
    if (!openBtn || !dlg || typeof dlg.showModal !== "function") return;
    const video = document.getElementById("introVideo"), closeBtn = document.getElementById("introClose"), soundBtn = document.getElementById("introSound");
    const SEEN = "cg-intro-seen";
    const seen = () => { try { return localStorage.getItem(SEEN) === "1"; } catch (_) { return true; } };
    const markSeen = () => { try { localStorage.setItem(SEEN, "1"); } catch (_) {} };
    let autoOpened = false;

    function showSound(){
      const muted = video.muted || video.paused;
      soundBtn.hidden = !muted;
      if (muted) soundBtn.querySelector("span").textContent = video.paused ? t("اضغط لتشغيل الفيديو") : t("اضغط لتشغيل الصوت");
    }
    function open(auto){
      markSeen(); autoOpened = !!auto;
      const r = openBtn.getBoundingClientRect();
      dlg.style.setProperty("--fx", Math.round(r.left + r.width / 2 - innerWidth / 2) + "px");
      dlg.style.setProperty("--fy", Math.round(r.top + r.height / 2 - innerHeight / 2) + "px");
      if (!video.src) video.src = video.dataset.src;
      dlg.classList.remove("closing");
      dlg.showModal(); document.documentElement.classList.add("vm-open");
      video.muted = !!auto;                 // ضغطة حقيقية: بالصوت. ضغطة تلقائية: بدون صوت حتى يلمس الزائر
      video.currentTime = 0;
      soundBtn.hidden = !auto;                                            // يظهر فوراً مع الفتح التلقائي (قبل اكتمال التحميل)
      if (auto) soundBtn.querySelector("span").textContent = t("اضغط لتشغيل الصوت");
      const p = video.play();
      if (p && p.then) p.then(showSound, showSound); else showSound();   // وضع توفير الطاقة قد يمنع التشغيل: يظهر «اضغط لتشغيل الفيديو»
      closeBtn.focus({ preventScroll: true });
    }
    function close(){
      if (!dlg.open || dlg.classList.contains("closing")) return;
      video.pause();
      if (reduce){ dlg.close(); return; }
      dlg.classList.add("closing");
      setTimeout(() => { dlg.close(); dlg.classList.remove("closing"); }, 270);
    }
    openBtn.addEventListener("click", e => { if (e.isTrusted) open(false); });
    closeBtn.addEventListener("click", close);
    soundBtn.addEventListener("click", () => { video.muted = false; const p = video.play(); if (p && p.catch) p.catch(() => {}); soundBtn.hidden = true; });
    video.addEventListener("volumechange", () => { if (!video.muted) soundBtn.hidden = true; });
    video.addEventListener("play", () => { if (!video.muted) soundBtn.hidden = true; });
    video.addEventListener("ended", () => { if (autoOpened) setTimeout(close, 600); });
    dlg.addEventListener("cancel", e => { e.preventDefault(); close(); });                 // Esc
    dlg.addEventListener("click", e => { if (e.target === dlg) close(); });               // الضغط خارج الفيديو
    dlg.addEventListener("close", () => { video.pause(); soundBtn.hidden = true; document.documentElement.classList.remove("vm-open"); openBtn.focus({ preventScroll: true }); });

    /* ---- الضغطة التلقائية ---- */
    const saveData = navigator.connection && navigator.connection.saveData;
    if (seen() || reduce || saveData || !("IntersectionObserver" in window) || !Element.prototype.animate) return;
    const busy = () => document.visibilityState !== "visible" || dlg.open || document.body.classList.contains("view-active")
      || !(document.getElementById("cartDrawer") || {}).hidden || !(document.getElementById("aiPanel") || {}).hidden
      || /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "");
    const fine = matchMedia("(pointer: fine)").matches;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let visible = false, timer = null, running = false;
    const stillThere = () => { const r = openBtn.getBoundingClientRect(); return visible && !busy() && r.top >= 0 && r.bottom <= innerHeight; };

    async function demo(){
      if (running || seen()) return;
      running = true;
      const ARROW = '<svg class="arrow" viewBox="0 0 32 32" aria-hidden="true"><path d="M6 3.5 25 16.4l-8.3 1.3 4.8 9.6-3.8 1.9-4.8-9.7L6 25.2Z" fill="#fff" stroke="#12302E" stroke-width="1.9" stroke-linejoin="round"/></svg>';
      const HAND = '<svg class="hand" viewBox="0 0 32 32" aria-hidden="true"><path d="M11.6 2.6c1.3 0 2.3 1 2.3 2.3v8l.9-.1c.3-1 1.2-1.7 2.2-1.7s1.9.6 2.2 1.5c.4-.6 1.1-1 1.9-1 1.1 0 2 .7 2.2 1.7.4-.4 1-.6 1.6-.6 1.3 0 2.3 1 2.3 2.3v6.4c0 4.7-3.8 8.5-8.5 8.5h-1.8c-2.6 0-5-1.2-6.6-3.2L5 20.1c-.8-1-.6-2.4.4-3.2 1-.8 2.4-.7 3.2.2l.6.7V4.9c0-1.3 1-2.3 2.4-2.3Z" fill="#fff" stroke="#12302E" stroke-width="1.8" stroke-linejoin="round"/></svg>';
      const cur = document.createElement("div");
      cur.className = "auto-cursor"; cur.setAttribute("aria-hidden", "true"); cur.innerHTML = fine ? ARROW + HAND : HAND;
      if (!fine) cur.classList.add("on-btn");
      document.body.appendChild(cur);
      const tip = fine ? [7, 4] : [14, 3];                                     // رأس المؤشر داخل الأيقونة (40×40)
      const r = openBtn.getBoundingClientRect();
      const tx = r.left + r.width * .5, ty = r.top + r.height * .55;
      const sx = Math.min(innerWidth - 48, tx + Math.min(170, innerWidth * .32)), sy = Math.min(innerHeight - 48, ty + 120);
      const at = (x, y, sc = 1) => `translate(${x - tip[0]}px, ${y - tip[1]}px) scale(${sc})`;
      const step = (kf, ms, easing = "ease") => cur.animate(kf, { duration: ms, easing, fill: "forwards" }).finished;
      const abort = () => { cur.remove(); openBtn.classList.remove("hover-sim", "pressed"); running = false; };
      try {
        await step([{ opacity: 0, transform: at(sx, sy, .6) }, { opacity: 1, transform: at(sx, sy) }], 280, "ease-out");
        await step([{ transform: at(sx, sy) }, { transform: at((sx + tx) / 2 + 24, (sy + ty) / 2 + 30), offset: .55 }, { transform: at(tx, ty) }], 1050, "cubic-bezier(.45,.05,.3,1)");
        if (!stillThere()) return abort();
        cur.classList.add("on-btn"); openBtn.classList.add("hover-sim");
        await sleep(380);
        if (!stillThere()) return abort();
        const rip = document.createElement("span"); rip.className = "click-ripple"; rip.style.left = tx + "px"; rip.style.top = ty + "px";
        document.body.appendChild(rip); setTimeout(() => rip.remove(), 700);
        openBtn.classList.add("pressed");
        await step([{ transform: at(tx, ty) }, { transform: at(tx, ty, .82) }, { transform: at(tx, ty) }], 220);
        openBtn.classList.remove("pressed");
        await sleep(160);
        if (busy()) return abort();
        open(true);
        io.disconnect();
        step([{ opacity: 1, transform: at(tx, ty) }, { opacity: 0, transform: at(tx + 10, ty + 14, .9) }], 300).then(() => cur.remove());
        setTimeout(() => openBtn.classList.remove("hover-sim"), 400);
        running = false;
      } catch (_) { abort(); }
    }
    // يبدأ عندما يظهر الزر كاملاً ويبقى ظاهراً قليلاً (ليس أثناء مرور سريع)
    const io = new IntersectionObserver(([en]) => {
      visible = en.intersectionRatio >= .95;
      clearTimeout(timer);
      if (visible) timer = setTimeout(() => { if (stillThere()) demo(); }, 900);
    }, { threshold: [0, .95, 1] });
    io.observe(openBtn);
    openBtn.addEventListener("click", e => { if (e.isTrusted) io.disconnect(); });
  })();

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

  // شريط الجوال يختفي داخل قسم العروض ما دامت السلة فارغة؛ وعند وجود منتجات يبقى ظاهراً بزر «إتمام الطلب»
  // زرا واتساب والمساعد العائمان يختفيان في الجوال فقط (فوق نموذج الطلب أو زر «اطلب» في البداية) حتى لا يغطيا أي منهما
  if ("IntersectionObserver" in window){
    const seen = { order: false };
    const ctas = new Set();   // أزرار «اطلب» الرئيسية الظاهرة الآن (أعلى الصفحة وآخرها)
    const mobile = matchMedia("(max-width: 640px)");
    const apply = () => {
      $(".mbar").classList.toggle("away", seen.order && !document.body.classList.contains("has-cart"));
      [$(".wa-float"), $("#aiLauncher")].forEach(el => el.classList.toggle("away", mobile.matches && (seen.order || ctas.size > 0)));
      $("#aiLauncher").classList.toggle("compact", !mobile.matches && seen.order);
    };
    // الهامش يتجاهل حافة القسم الملاصقة للشاشة (أو المختفية تحت الترويسة) حتى لا تختفي الأزرار بلا داعٍ
    new IntersectionObserver(([en]) => { seen.order = en.isIntersecting; apply(); }, { rootMargin: "-80px 0px -40px 0px" }).observe($("#order"));
    const ctaIO = new IntersectionObserver(entries => { entries.forEach(en => en.isIntersecting ? ctas.add(en.target) : ctas.delete(en.target)); apply(); });
    $$(".hero-copy .cta-row, .final .btn").forEach(el => ctaIO.observe(el));
    mobile.addEventListener("change", apply);
    window.addEventListener("cg:cart", apply);            // من shop.js عند تغيّر السلة
  }

  /* ============================================================
     مساعد CalmGastro
     - الأسئلة السريعة تُجاب هنا مباشرة من بيانات الصفحة (بدون ذكاء اصطناعي وبدون تكلفة)
     - الأسئلة المكتوبة تذهب إلى CONFIG.assistant.endpoints (Cloudflare Worker) فقط
     - لا يُرسل للمساعد أي شيء من نموذج الطلب (الاسم، الجوال، الموقع، العنوان)
     ============================================================ */
  const AI = CONFIG.assistant || {};
  const aiPreview = /[?&]assistant(=|&|$)/.test(location.search);
  if ((AI.endpoints || []).length || aiPreview){
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
          text: [...INGREDIENTS.filter(i => /^(Konjac|Inulin|Ginger|Chromium|5-H)/.test(i.en)).map(i => `- **${EN ? i.name_en : i.ar}**: ${i.role}`),
                 "", lines("#results .disclaim")[0] || ""].filter(Boolean).join("\n"),
          actions: ["order"] }) },
      { q: t("كم السعر؟"), answer: () => ({
          text: [t("أسعار العروض الحالية:"), ...CONFIG.bundles.map(bundleLine),
                 CONFIG.pricing && CONFIG.pricing.boxPriceAfterBundles ? t("- أكثر من {max} علب: **{p}** للعلبة (مثلاً 4 علب = {four}).", {
                   max: Math.max(...CONFIG.bundles.map(b => b.boxes)), p: money(CONFIG.pricing.boxPriceAfterBundles), four: money(4 * CONFIG.pricing.boxPriceAfterBundles) }) : "",
                 "", t("{ship}، و{pay}.", { ship: CONFIG.shippingNote, pay: CONFIG.payment })].filter((x, i, a) => x || a[i - 1]).join("\n"),
          actions: ["order"] }) },
      { q: t("ما الفرق بين العروض؟"), answer: () => ({
          text: [...CONFIG.bundles.map(b => t("- **{title}** {tag}: {n} ظرفاً تكفي {dur}، بسعر {price}، أي حوالي {per} {cur} لليوم.", {
                   title: b.title, tag: b.tag ? `(${b.tag})` : "", n: b.boxes * 30, dur: b.program.replace("برنامج ", ""), program: b.program,
                   price: money(b.price), per: Math.round(b.price / (b.boxes * 30) * 10) / 10, cur: CONFIG.currency })),
                 "", lines("#order .sec-head p")[0] || ""].filter(Boolean).join("\n"),
          actions: ["order"] }) },
      { q: t("كيف أطلب؟"), answer: () => ({
          text: [t("أكيد، يمكنك الطلب من الموقع مباشرة، وسأساعدك إذا كان لديك أي سؤال عن المنتج."),
                 t("1. اختر العرض واضغط «إضافة للسلة»."), t("2. اضغط «إتمام الطلب» واكتب بيانات التوصيل."), t("3. راجع طلبك ثم اضغط «تأكيد الطلب»، فيُسجَّل طلبك فوراً وتحصل على رقم طلب تتابع به حالته."),
                 "", t("{pay}، والتوصيل {del}.", { pay: CONFIG.payment, del: CONFIG.deliveryShort })].join("\n"),
          actions: ["order"] }) },
      { q: t("هل يوجد بيع بالجملة؟"), answer: () => ({
          text: [t("لدينا خيار للاستفسار عن طلبات الجملة. اضغط «استفسار عن الجملة» لتصلنا رسالتك عبر واتساب، واكتب الكمية التي تحتاجها، ونرد عليك بالأسعار."),
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
      // الجملة: استفسار عبر واتساب برسالة جاهزة (ليس طلباً من السلة)
      if (wholesale){ const w = $(".js-wa-wholesale"); if (w) window.open(w.href, "_blank", "noopener"); return; }
      closePanel(false);
      if (location.hash.startsWith("#/")){ location.hash = "#order"; return; }
      $("#order").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      const target = $("#bundles .add-btn");
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
      const urls = AI.endpoints || [];
      if (!urls.length){ addMsg("bot", UNAVAILABLE); addActions(["whatsapp"]); return; }

      busy = true; aiSend.disabled = true;
      const typing = showTyping();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      let answer = "", actions = [];
      try {
        let r = null;
        for (const u of urls){   // العنوان التالي فقط إن لم يصل الطلب إطلاقاً (حجب/شبكة)
          try { r = await fetch(u, {
            method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, signal: ctrl.signal,   // بلا preflight (انظر shop.js)
            body: JSON.stringify({ message: q, history, lang: LANG })
          }); break; } catch (e) { if (e.name === "AbortError") throw e; }
        }
        const j = r && r.ok ? await r.json() : null;
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

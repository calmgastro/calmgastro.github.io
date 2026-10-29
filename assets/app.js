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
    const SKIP = "script,style,svg,datalist,#bundles,#ingExplorer,#aiLog,[data-no-i18n]";
    const kbExtra = document.getElementById("kbExtra");
    const roots = [document.body].concat(kbExtra ? [kbExtra.content] : []);   // نصوص المساعد المخفية تُترجم أيضاً
    for (const el of roots.flatMap(r => [...r.querySelectorAll("*")])){
      if (!(el.isConnected || (kbExtra && kbExtra.content.contains(el))) || !AR.test(el.textContent) || el.closest(SKIP)) continue;
      const en = EN.html[norm(el.innerHTML)];
      if (en != null) el.innerHTML = en;
    }
    const missing = [];
    for (const r of roots){
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode());){
        if (!AR.test(n.nodeValue) || (n.parentElement && n.parentElement.closest(SKIP))) continue;
        const en = EN.text[norm(n.nodeValue)];
        if (en != null) n.nodeValue = n.nodeValue.match(/^\s*/)[0] + en + n.nodeValue.match(/\s*$/)[0];
        else if (r === document.body) missing.push(norm(n.nodeValue));
      }
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

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- مكونات الظرف: طريقة التحضير ثم المكونات ----------
     مشهد بصورة الكوب الحقيقية: كوب ماء ← الظرف يميل ويُسكب ← التحريك (دوامة وفقاعات ويتحول المشروب للوردي) ← تخرج المكونات
     من الكوب واحداً تلو الآخر وتستقر حوله، ثم تتنقل البطاقة بينها تلقائياً. مرور/تركيز/لمس أي مكوّن يعرض بطاقته ويوقف التنقل.
     المصدر الوحيد للبيانات: product-data ← INGREDIENTS. الصورة المصغّرة: ing.img إن وُجدت، وإلا رسم SVG حسب ing.id */
  (function ingredientExplorer(){
    const root = $("#ingExplorer"); if (!root) return;
    const N = INGREDIENTS.length, plain = s => String(s).replace(/<[^>]+>/g, "");
    const hover = matchMedia("(hover: hover) and (pointer: fine)").matches;
    const stacked = () => matchMedia("(max-width: 1000px)").matches;
    const tint = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${n >> 8 & 255},${n & 255},${a})`; };
    const ART = {
      konjac: '<ellipse cx="32" cy="39" rx="22" ry="16" fill="#A8794D"/><ellipse cx="32" cy="36" rx="19" ry="12" fill="#BE8E5F"/><circle cx="24" cy="35" r="2" fill="#86592F"/><circle cx="37" cy="32" r="1.8" fill="#86592F"/><circle cx="33" cy="43" r="2.2" fill="#86592F"/><circle cx="44" cy="39" r="1.6" fill="#86592F"/><path d="M32 24c0-6 3-10 9-12-1 6-4 9-9 12Z" fill="#5FA05B"/><path d="M31 24c-1-5-4-8-9-9 1 5 4 8 9 9Z" fill="#7FB77E"/>',
      inulin: '<path d="M8 40c0 7 11 13 24 13s24-6 24-13Z" fill="#C99A63"/><ellipse cx="32" cy="40" rx="24" ry="6" fill="#B5854F"/><path d="M14 40c2-9 9-15 18-15s16 6 18 15c-5 2-11 3-18 3s-13-1-18-3Z" fill="#F5F0E7"/><path d="M21 34c3-3 7-5 11-5" stroke="#fff" stroke-width="2.5" stroke-linecap="round" fill="none"/>',
      greentea: '<path d="M14 46C12 26 26 12 50 12c2 22-12 36-36 34Z" fill="#6FAF5E"/><path d="M16 44C24 34 34 26 46 18" stroke="#3F7F3A" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M10 55c4-12 12-18 22-20-2 10-10 18-22 20Z" fill="#8FC47A"/>',
      coffee: '<ellipse cx="24" cy="35" rx="12" ry="16" transform="rotate(-25 24 35)" fill="#7A4A26"/><path d="M19 23c6 6 6 18 10 24" stroke="#4E2D15" stroke-width="2.6" fill="none" stroke-linecap="round"/><ellipse cx="42" cy="30" rx="11" ry="15" transform="rotate(20 42 30)" fill="#8D5A30"/><path d="M45 17c-5 6-4 17-7 25" stroke="#5A3418" stroke-width="2.4" fill="none" stroke-linecap="round"/>',
      garcinia: '<circle cx="32" cy="37" r="18" fill="#9CC458"/><path d="M32 19v36M21 23c-4 9-4 19 0 28M43 23c4 9 4 19 0 28" stroke="#7DA63D" stroke-width="2" fill="none"/><path d="M32 19c2-6 7-9 13-9-2 6-7 9-13 9Z" fill="#4E8F45"/><ellipse cx="25" cy="31" rx="4" ry="6" fill="#fff" fill-opacity=".3"/>',
      carnitine: '<g transform="rotate(-35 32 32)"><rect x="12" y="24" width="40" height="16" rx="8" fill="#fff" stroke="#E2D3B0" stroke-width="1.5"/><path d="M32 24h12a8 8 0 0 1 0 16H32Z" fill="#F7B955"/><rect x="16" y="27" width="10" height="3" rx="1.5" fill="#fff" fill-opacity=".85"/></g><circle cx="46" cy="49" r="3" fill="#EFE6D3"/><circle cx="53" cy="43" r="2" fill="#EFE6D3"/>',
      bromelain: '<path d="M32 25c-3-7-8-10-13-10 2 5 6 8 10 10-5-2-10-1-13 2 5 0 10 1 13 3ZM32 25c3-7 8-10 13-10-2 5-6 8-10 10 5-2 10-1 13 2-5 0-10 1-13 3Z" fill="#5FA05B"/><path d="M32 13c-2 5-2 9 0 13 2-4 2-8 0-13Z" fill="#4E8F45"/><ellipse cx="32" cy="42" rx="14" ry="16" fill="#F2C744"/><path d="M24 33l3 3 3-3 3 3 3-3 3 3M21 40l3 3 3-3 3 3 3-3 3 3 3-3 3 3M22 47l3 3 3-3 3 3 3-3 3 3 3-3 3 3M26 54l3 2 3-2 3 2 3-2" stroke="#D29A1E" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
      ginger: '<path d="M9 41c0-5 4-8 9-8 1-6 6-9 11-7 3-5 10-6 13-1 5-1 10 3 9 8 4 2 5 7 2 10-3 4-9 4-12 1-4 3-10 3-13 0-5 2-11 1-13-3-4 0-6-0-6 0Z" fill="#E0B072"/><path d="M18 33c2 4 6 6 11 5M29 26c2 5 6 7 11 7M42 25c0 4 3 7 7 8" stroke="#B9844A" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="23" cy="43" r="1.6" fill="#B9844A"/>',
      htp: '<path d="M8 40c8-14 31-20 46-12-8 14-31 20-46 12Z" fill="#8BB36B"/><path d="M13 39c10-6 25-9 37-10" stroke="#6C9450" stroke-width="1.6" fill="none"/><ellipse cx="21" cy="38" rx="5" ry="4" fill="#5B3A2A"/><ellipse cx="32" cy="35" rx="5" ry="4" fill="#6B4433"/><ellipse cx="43" cy="32" rx="5" ry="4" fill="#5B3A2A"/>',
      chromium: '<path d="M32 8 48 22 42 54H22L16 22Z" fill="#7FA9C0"/><path d="M32 8 40 24 32 54 24 24Z" fill="#A3C4D6"/><path d="M16 22h32M24 24l-8-2M40 24l8-2" stroke="#5E8FA8" stroke-width="1.4" fill="none"/><path d="M27 14l-4 6" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
      b12: '<path d="M32 8C24 20 16 28 16 38a16 16 0 0 0 32 0c0-10-8-18-16-30Z" fill="#E06C80"/><path d="M24 34c0-5 2-9 5-12" stroke="#fff" stroke-opacity=".6" stroke-width="3" stroke-linecap="round" fill="none"/><text x="32" y="45" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="13" fill="#fff">B12</text>'
    };
    const art = ing => ing.img ? `<img src="${ing.img}" alt="" width="52" height="52" loading="lazy" decoding="async">`
      : `<svg viewBox="0 0 64 64" aria-hidden="true">${ART[ing.id] || '<circle cx="32" cy="32" r="16" fill="' + ing.color + '"/>'}</svg>`;
    const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
    const STEPS = [t("كوب ماء (250 مل)"), t("أضف ظرفاً واحداً"), t("حرّكه جيداً واشربه مباشرة"), t("قبل وجبتك بنصف ساعة، ثم كوب ماء إضافي")];
    const SWIRL = "M50 8c22 0 36 8 36 18S70 44 50 44 18 36 18 27s14-15 32-15 28 6 28 14-12 12-28 12-22-4-22-10 9-9 22-9 16 3 16 7";
    const DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';

    root.innerHTML = `
      <div class="ux-tour">
        <div class="ux-stage" role="img" aria-label="${t("طريقة التحضير: ظرف واحد في كوب ماء 250 مل، حرّكه جيداً واشربه قبل وجبتك بنصف ساعة")}">
          <img class="ux-glass" src="assets/usage-glass-water.jpg" alt="" width="916" height="1224" decoding="async">
          <img class="ux-glass ux-pink" src="assets/usage-glass-pink.jpg" alt="" width="916" height="1224" decoding="async">
          <div class="ux-liquid"><span class="ux-cloud"></span>
            <svg class="ux-swirl" viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true"><path d="${SWIRL}" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.6" stroke-linecap="round"/><path d="${SWIRL}" fill="none" stroke="#F39AB2" stroke-opacity=".7" stroke-width="1.4" stroke-linecap="round" transform="translate(0 6)"/></svg>
            <span class="ux-fizz">${"<i></i>".repeat(16)}</span></div>
          <span class="ux-stream"></span>
          <span class="ux-grains">${"<i></i>".repeat(14)}</span>
          <img class="ux-sachet" src="assets/usage-sachet.png" alt="" width="760" height="520" decoding="async">
          <p class="ux-cap" aria-hidden="true"><b class="num"></b><span></span></p>
        </div>
        <div class="ux-spot" aria-hidden="true"><span class="ux-spot-orb"></span><div class="ux-spot-txt"><b class="ux-spot-nm"></b><span class="ux-spot-dose"></span><span class="ux-spot-role"></span></div></div>
        <svg class="ux-wire" aria-hidden="true"><path pathLength="1"/><circle r="5"/></svg>
      </div>
      <div class="ux-foot">
        <button type="button" class="ux-replay"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>${t("شاهد طريقة التحضير مرة أخرى")}</button>
        <button type="button" class="ux-down">${DOWN}${t("عرض جميع المكونات")}</button>
      </div>
      <div class="ux-grid" role="group" aria-label="${t("جميع المكونات")}">
        ${INGREDIENTS.map((ing, i) => `<button type="button" class="ux-ing" data-i="${i}" aria-pressed="false" aria-controls="ixCard" aria-label="${plain(ing.name)} — ${ing.dose}"><span class="ux-orb" style="background:${tint(ing.color, .16)}">${art(ing)}</span><span class="ux-nm">${ing.name}</span></button>`).join("")}
      </div>
      <div class="ix-card is-hint" id="ixCard" aria-live="polite"></div>`;
    const tour = $(".ux-tour", root), stage = $(".ux-stage", root), card = $("#ixCard", root), cap = $(".ux-cap", root);
    const spotEl = $(".ux-spot", root), spotOrb = $(".ux-spot-orb", spotEl), wire = $(".ux-wire", root), grid = $(".ux-grid", root);
    const bubbles = $$(".ux-ing", root);

    // البطاقة (المحتوى من product-data فقط)
    const body = document.createElement("div"), nav = document.createElement("div");
    body.className = "ixc-body"; nav.className = "ixc-nav";
    nav.innerHTML = `<button type="button" class="ixc-prev" aria-label="${t("المكوّن السابق")}">${CHEV.replace('d="m9 6 6 6-6 6"', 'd="m15 6-6 6 6 6"')}</button><span class="ixc-count num" aria-hidden="true"></span><button type="button" class="ixc-next" aria-label="${t("المكوّن التالي")}">${CHEV}</button>`;
    card.append(body, nav);
    const hint = () => `<div class="ix-hint"><b>${t("11 مكوّناً في كل ظرف")}</b><span>${t("اضغط على أي مكوّن لتعرف دوره")}</span></div>`;
    const efsa = ing => ing.efsa ? ` <span class="efsa" title="${t("ادعاء صحي معتمد من EFSA")}">EFSA</span>` : "";
    const content = ing => `<div class="ixc-top"><span class="ixc-art" style="background:${tint(ing.color, .14)}">${art(ing)}</span>
      <div><h3 class="ixc-name">${ing.name}${efsa(ing)}</h3>
      <p class="ixc-ext" dir="ltr">${ing.en.replace(/ (mg|µg)\b/g, " $1")}</p></div></div>
      <p class="ixc-dose"><b dir="ltr">${ing.dose}</b> ${t("لكل ظرف")}</p>
      <p class="ixc-role">${ing.role}</p>`;
    function fillSpot(ing){
      spotOrb.style.background = tint(ing.color, .18);
      spotOrb.innerHTML = art(ing);
      $(".ux-spot-nm", spotEl).innerHTML = ing.name + efsa(ing);
      $(".ux-spot-dose", spotEl).innerHTML = `<b dir="ltr">${ing.dose}</b> ${t("لكل ظرف")}`;
      $(".ux-spot-role", spotEl).innerHTML = ing.role;
    }

    body.innerHTML = hint();
    // ارتفاع ثابت = أطول محتوى: لا تقفز الصفحة عند ظهور البطاقة أو بطاقة المكوّن بجانب الكوب أو تبدّل المكوّن
    function sizeCard(){
      if (!card.getBoundingClientRect().width) return;
      const saved = body.innerHTML, wasHint = card.classList.contains("is-hint");
      card.style.minHeight = ""; card.classList.remove("is-hint"); spotEl.style.minHeight = "";
      let max = 0, smax = 0;
      for (const ing of INGREDIENTS) { body.innerHTML = content(ing); max = Math.max(max, card.getBoundingClientRect().height); }
      body.innerHTML = saved; card.classList.toggle("is-hint", wasHint);
      card.style.minHeight = Math.ceil(max) + "px";
      const shown = spot;
      for (const ing of INGREDIENTS) { fillSpot(ing); smax = Math.max(smax, spotEl.offsetHeight); }   // ارتفاع التخطيط (لا يتأثر بحركة التصغير)
      spotEl.style.minHeight = smax + 1 + "px";
      if (shown >= 0) { fillSpot(INGREDIENTS[shown]); placeSpot(shown); }
    }
    let sel = -1, spot = -1, swapT = 0, revealT = 0;
    function select(i){
      i = (i + N) % N;
      if (i === sel) return;
      const first = sel < 0;
      sel = i;
      bubbles.forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.i === i)));
      clearTimeout(swapT);
      const show = () => { body.innerHTML = content(INGREDIENTS[i]); $(".ixc-count", nav).textContent = `${i + 1} / ${N}`; card.classList.remove("is-hint", "swap"); };
      if (first || reduce) show(); else { card.classList.add("swap"); swapT = setTimeout(show, 170); }
    }
    function reveal(){                                                    // الجوال: إظهار البطاقة كاملة فوق الشريط السفلي
      clearTimeout(revealT);
      revealT = setTimeout(() => {
        if (!stacked() || sel < 0) return;
        const r = card.getBoundingClientRect(), bottom = innerHeight - 110;
        if (r.bottom > bottom) scrollBy({ top: Math.min(r.bottom - bottom, r.top - 70), behavior: reduce ? "auto" : "smooth" });
      }, 230);
    }

    /* المكوّن بجانب الكوب: يخرج من فم الكوب إلى بطاقته، ويمتد منه خط إلى المشروب، ثم التالي في الجهة الأخرى.
       الكمبيوتر: يميناً ويساراً بارتفاعات مختلفة؛ الجوال: تحت الكوب والخط يصعد إليه */
    const YS = [.06, .42, .22, .58, .12, .48, .3, .64, .08, .4, .26];      // موضع البطاقة رأسياً (نسبة من المساحة المتاحة)
    const TY = [.5, .6, .68, .55, .74, .63, .5, .71, .57, .66, .53];        // نقطة الخط على المشروب
    function placeSpot(i){
      const side = i % 2 ? 3 : 1;
      if (stacked()) { spotEl.style.gridColumn = ""; spotEl.style.marginTop = ""; spotEl.style.flexDirection = ""; spotEl.style.justifySelf = ""; }
      else {
        spotEl.style.gridColumn = String(side);
        spotEl.style.justifySelf = side === 1 ? "end" : "start";             // ملاصقة لجهة الكوب
        const free = stage.getBoundingClientRect().height - spotEl.getBoundingClientRect().height;
        spotEl.style.marginTop = Math.max(0, free * YS[i]) + "px";
      }
      const T = tour.getBoundingClientRect(), S = spotEl.getBoundingClientRect(), G = stage.getBoundingClientRect();
      const left = S.left + S.width / 2 < G.left + G.width / 2;
      if (!stacked()) spotEl.style.flexDirection = (left === (document.documentElement.dir === "rtl")) ? "row" : "row-reverse";   // الدائرة باتجاه الكوب
      const O = spotOrb.getBoundingClientRect();
      let sx, sy, ex, ey, d;
      if (stacked()) {
        sx = O.left + O.width / 2 - T.left; sy = O.top - T.top - 4;
        ex = G.left + G.width * (i % 2 ? .58 : .42) - T.left; ey = G.top + G.height * .8 - T.top;
        d = `M${sx} ${sy} C${sx} ${sy - 30} ${ex} ${ey + 40} ${ex} ${ey}`;
      } else {
        sx = (left ? O.right + 4 : O.left - 4) - T.left; sy = O.top + O.height / 2 - T.top;
        ex = G.left + G.width * (left ? .3 : .72) - T.left; ey = G.top + G.height * TY[i] - T.top;
        const mx = (sx + ex) / 2;
        d = `M${sx} ${sy} C${mx} ${sy} ${mx} ${ey} ${ex} ${ey}`;
      }
      $("path", wire).setAttribute("d", d);
      const c = $("circle", wire); c.setAttribute("cx", ex); c.setAttribute("cy", ey);
    }
    function showSpot(i, fly){
      spot = i;
      wire.classList.remove("draw", "out");
      spotEl.classList.remove("in");
      fillSpot(INGREDIENTS[i]);
      placeSpot(i);
      void spotEl.offsetWidth;
      spotEl.classList.add("in");
      if (fly && !reduce) {
        const s = stage.getBoundingClientRect(), r = spotOrb.getBoundingClientRect();
        const dx = s.left + s.width * .515 - (r.left + r.width / 2), dy = s.top + s.height * .25 - (r.top + r.height / 2);
        spotOrb.animate([
          { transform: `translate(${dx}px, ${dy}px) scale(.15)`, opacity: 0 },
          { transform: `translate(${dx * .45}px, ${dy * .5 - 60}px) scale(1.18)`, opacity: 1, offset: .58 },
          { transform: "none", opacity: 1 }
        ], { duration: 850, easing: "cubic-bezier(.3,.75,.3,1)" });
        const ring = document.createElement("span");
        ring.className = "ux-pop"; ring.style.left = "51.5%"; ring.style.top = "25%";
        stage.appendChild(ring); setTimeout(() => ring.remove(), 700);
        clearTimeout(wireT); wireT = setTimeout(() => wire.classList.add("draw"), 650);
      } else wire.classList.add("draw");
    }
    function hideSpot(){ spotEl.classList.remove("in"); wire.classList.add("out"); }

    // جولة المكونات: واحد كل 3.4 ثوانٍ، وتتكرر. تنتظر حين يكون الكوب خارج الشاشة، وتتوقف عندما يختار الزائر مكوّناً بنفسه
    const SPOT = 3400;
    let tourT = 0, wireT = 0, touring = false, userDriven = false, inView = false;
    function tourStep(i){
      clearTimeout(tourT);
      if (!touring) return;
      if (!inView || document.hidden) { tourT = setTimeout(() => tourStep(i), 400); return; }
      showSpot(i, true);
      bubbles.forEach(b => b.classList.toggle("lit", +b.dataset.i === i));
      if (!userDriven) select(i);
      tourT = setTimeout(() => { hideSpot(); tourT = setTimeout(() => tourStep((i + 1) % N), 380); }, SPOT);
    }
    const stopTour = () => { touring = false; clearTimeout(tourT); clearTimeout(wireT); bubbles.forEach(b => b.classList.remove("lit")); };
    function takeOver(i){                                                  // الزائر اختار مكوّناً: يظهر بجانب الكوب أيضاً
      userDriven = true; stopTour();
      select(i);
      if (root.classList.contains("done")) showSpot(sel, false);
    }

    // التسلسل
    let timers = [];
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    function caption(k){
      $("b", cap).textContent = String(k + 1);
      $("span", cap).textContent = STEPS[k];
      cap.classList.remove("show"); void cap.offsetWidth; cap.classList.add("show");
    }
    function play(){
      timers.forEach(clearTimeout); timers = []; stopTour(); hideSpot(); spot = -1; sizeCard();
      sel = -1; userDriven = false; card.classList.add("is-hint"); body.innerHTML = hint(); bubbles.forEach(b => b.setAttribute("aria-pressed", "false"));
      root.classList.remove("play", "done"); void root.offsetWidth; root.classList.add("play");
      caption(0);
      at(1300, () => caption(1));
      at(3300, () => caption(2));
      at(5600, () => caption(3));
      at(7400, () => { root.classList.add("done"); cap.classList.remove("show"); touring = true; tourStep(0); });
    }
    function finished(){                                                   // بدون حركة: الكوب الوردي والمكوّن الأول بجانبه، والزائر يختار البقية
      root.classList.add("static", "done");
      select(0); showSpot(0, false);
    }
    sizeCard();
    let sizeT = 0; const resize = () => { clearTimeout(sizeT); sizeT = setTimeout(sizeCard, 150); };
    if (document.fonts) { if (document.fonts.ready) document.fonts.ready.then(sizeCard); document.fonts.addEventListener("loadingdone", resize); }   // الخط يغيّر الارتفاع
    addEventListener("resize", resize);

    bubbles.forEach(b => {
      const i = +b.dataset.i;
      b.addEventListener("click", () => { takeOver(i); reveal(); });
      b.addEventListener("focus", () => { if (root.classList.contains("done")) takeOver(i); });
      if (hover) b.addEventListener("mouseenter", () => { if (root.classList.contains("done")) takeOver(i); });
    });
    $(".ixc-prev", nav).addEventListener("click", () => { takeOver(sel - 1); reveal(); });
    $(".ixc-next", nav).addEventListener("click", () => { takeOver(sel + 1); reveal(); });
    $(".ux-replay", root).addEventListener("click", () => { play(); tour.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" }); });
    $(".ux-down", root).addEventListener("click", () => grid.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" }));

    /* عند وصول الزائر للقسم وتوقفه عن التمرير: تُعدَّل الصفحة مرة واحدة (لأعلى أو لأسفل) حتى يكون مشهد التحضير في منتصف الشاشة */
    let framed = false, scrollT = 0;
    function frame(){
      if (framed || !tour.offsetParent || document.documentElement.classList.contains("vm-open") || document.body.classList.contains("view-active")) return;
      const drawer = document.getElementById("cartDrawer"); if (drawer && !drawer.hidden) return;
      const head = $("header.top"), bar = $(".mbar");
      const top = head ? Math.max(0, head.getBoundingClientRect().bottom) : 0;
      // شريط «اطلب الآن» يختفي مؤقتاً وقسم العروض ظاهر ثم يعود بعد التمرير: نقيس مكانه كأنه ظاهر
      const away = bar && bar.classList.contains("away"); if (away) bar.classList.remove("away");
      const bottom = bar && getComputedStyle(bar).display !== "none" ? bar.getBoundingClientRect().top : innerHeight;
      if (away) bar.classList.add("away");
      const r = tour.getBoundingClientRect(), avail = bottom - top;
      if (Math.min(r.bottom, bottom) - Math.max(r.top, top) < Math.min(r.height, avail) * .35) return;   // ما زال بعيداً عن المشهد
      framed = true;
      const delta = r.top - (r.height <= avail ? top + (avail - r.height) / 2 : top + 8);
      if (Math.abs(delta) > 24) scrollBy({ top: delta, behavior: reduce ? "auto" : "smooth" });
    }
    addEventListener("scroll", () => { if (!framed) { clearTimeout(scrollT); scrollT = setTimeout(frame, 180); } }, { passive: true });

    if (reduce || !("IntersectionObserver" in window) || !Element.prototype.animate) { finished(); return; }
    // يبدأ عندما يقف الزائر عند المشهد (ليس أثناء مرور سريع أو التمرير بزر القائمة)
    let started = false, dwellT = 0;
    new IntersectionObserver(([en]) => {
      inView = en.isIntersecting;
      clearTimeout(dwellT);
      if (inView && !started && en.intersectionRatio >= .45) dwellT = setTimeout(() => { if (!started) { started = true; play(); } }, 250);
    }, { threshold: [0, .45, .7] }).observe(stage);
  })();

  /* ---------- آراء العملاء: شريط يتقدم رأياً واحداً كل 4 ثوانٍ بحركة هادئة ----------
     يتوقف عند المرور بالمؤشر أو التركيز أو اللمس، وخارج الشاشة، ولمن فعّل «تقليل الحركة». السحب باليد للتالي/السابق */
  (function reviewsCarousel(){
    const root = $("#reviewsCarousel"); if (!root) return;
    const track = $(".rvc-track", root), viewport = $(".rvc-viewport", root), dotsBox = $(".rvc-dots", root);
    const items = $$(".review", track), N = items.length; if (N < 2) return;
    const rtl = document.documentElement.dir === "rtl", MOVE = "transform .95s cubic-bezier(.45,.05,.25,1)";
    // نسخ أول 4 آراء في النهاية حتى يستمر الدوران بلا قفزة (مخفية عن قارئ الشاشة)
    items.slice(0, Math.min(4, N)).forEach(it => { const c = it.cloneNode(true); c.setAttribute("aria-hidden", "true"); c.classList.add("clone"); track.appendChild(c); });
    dotsBox.innerHTML = items.map(() => "<i></i>").join("");
    const dots = $$("i", dotsBox);
    let idx = 0, timer = 0, hold = false, inView = false;
    const step = () => items[0].getBoundingClientRect().width + (parseFloat(getComputedStyle(track).columnGap) || 0);
    function go(i, animate = true){
      idx = i;
      track.style.transition = animate && !reduce ? MOVE : "none";
      track.style.transform = `translateX(${(rtl ? 1 : -1) * idx * step()}px)`;
      dots.forEach((d, k) => d.classList.toggle("on", k === ((idx % N) + N) % N));
    }
    track.addEventListener("transitionend", e => {
      if (e.target !== track) return;
      if (idx >= N) go(idx - N, false);
    });
    function next(){ go(idx + 1); }
    function prev(){
      if (idx > 0) return go(idx - 1);
      go(N, false); void track.offsetWidth; go(N - 1);                      // من الأول للأخير عبر النسخة
    }
    function schedule(){
      clearTimeout(timer);
      if (reduce) return;
      timer = setTimeout(() => { if (!hold && inView && !document.hidden) next(); schedule(); }, 4000);
    }
    root.addEventListener("mouseenter", () => { hold = true; });
    root.addEventListener("mouseleave", () => { hold = false; });
    root.addEventListener("focusin", () => { hold = true; });
    root.addEventListener("focusout", () => { hold = false; });
    let x0 = null;
    viewport.addEventListener("pointerdown", e => { x0 = e.clientX; hold = true; });
    addEventListener("pointerup", e => {
      if (x0 == null) return;
      const dx = e.clientX - x0; x0 = null; hold = false;
      if (Math.abs(dx) > 40) { ((dx > 0) === rtl ? next : prev)(); schedule(); }
    });
    addEventListener("resize", () => go(idx, false));
    new IntersectionObserver(([en]) => { inView = en.isIntersecting; }, { threshold: .3 }).observe(root);
    go(0, false); schedule();
  })();

  /* ---------- «للملصق الخلفي»: يفتح صورة الملصق في نافذة (تُحمَّل عند أول فتح)، مع تكبير على الجوال ---------- */
  (function backLabel(){
    const openBtn = document.getElementById("labelOpen"), dlg = document.getElementById("labelDialog");
    if (!openBtn || !dlg || typeof dlg.showModal !== "function") return;
    const card = $(".lm-card", dlg), img = document.getElementById("labelImg"), zoomBtn = document.getElementById("labelZoom");
    function zoom(on){
      card.classList.toggle("zoom", on);
      zoomBtn.setAttribute("aria-pressed", String(on));
      zoomBtn.textContent = t(on ? "تصغير الصورة" : "تكبير الصورة");
    }
    function open(){
      if (!img.src) img.src = img.dataset.src;
      zoom(false);
      dlg.classList.remove("closing");
      dlg.showModal(); document.documentElement.classList.add("vm-open");
      document.getElementById("labelClose").focus({ preventScroll: true });
    }
    function close(){
      if (!dlg.open || dlg.classList.contains("closing")) return;
      if (reduce){ dlg.close(); return; }
      dlg.classList.add("closing");
      setTimeout(() => { dlg.close(); dlg.classList.remove("closing"); }, 270);
    }
    openBtn.addEventListener("click", open);
    document.getElementById("labelClose").addEventListener("click", close);
    zoomBtn.addEventListener("click", () => zoom(!card.classList.contains("zoom")));
    img.addEventListener("click", e => {
      const on = !card.classList.contains("zoom"), box = img.parentElement, r = img.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      zoom(on);
      if (on) { box.scrollLeft = fx * box.scrollWidth - box.clientWidth / 2; box.scrollTop = fy * box.scrollHeight - box.clientHeight / 2; }   // يكبّر حول موضع الضغط
    });
    dlg.addEventListener("cancel", e => { e.preventDefault(); close(); });                 // Esc
    dlg.addEventListener("click", e => { if (e.target === dlg) close(); });               // الضغط خارج الصورة
    dlg.addEventListener("close", () => { document.documentElement.classList.remove("vm-open"); openBtn.focus({ preventScroll: true }); });
  })();

  /* ---------- scroll reveal ---------- */
  /* ---------- فيديو «تعرف على كالم كاسترو»: نافذة تظهر من موضع الزر، والفيديو يُحمَّل عند أول فتح.
     في كل تحميل للصفحة: عند وصول الزائر للزر يظهر مؤشر يضغطه تلقائياً ويُفتح الفيديو بدون صوت (المتصفحات تمنع الصوت بلا لمسة)،
     مع زر «اضغط لتشغيل الصوت». مرة واحدة في كل تحميل، ولا يحدث إن كان مشغولاً بالسلة أو المساعد أو الطلب ---------- */
  (function introVideo(){
    const openBtn = document.getElementById("introOpen"), dlg = document.getElementById("introDialog");
    if (!openBtn || !dlg || typeof dlg.showModal !== "function") return;
    const video = document.getElementById("introVideo"), closeBtn = document.getElementById("introClose"), soundBtn = document.getElementById("introSound");
    // الضغطة التلقائية مرة في كل تحميل للصفحة (بعد التحديث تعود). cg-intro-auto=off يوقفها (للاختبارات الآلية فقط)
    const autoOff = () => { try { return localStorage.getItem("cg-intro-auto") === "off"; } catch (_) { return false; } };
    let autoOpened = false, autoDone = false;

    function showSound(){
      const muted = video.muted || video.paused;
      soundBtn.hidden = !muted;
      if (muted) soundBtn.querySelector("span").textContent = video.paused ? t("اضغط لتشغيل الفيديو") : t("اضغط لتشغيل الصوت");
    }
    function open(auto){
      autoDone = true; autoOpened = !!auto;
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
    if (autoOff() || reduce || saveData || !("IntersectionObserver" in window) || !Element.prototype.animate) return;
    const busy = () => document.visibilityState !== "visible" || dlg.open || document.body.classList.contains("view-active")
      || !(document.getElementById("cartDrawer") || {}).hidden || !(document.getElementById("aiPanel") || {}).hidden
      || /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "");
    const fine = matchMedia("(pointer: fine)").matches;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let visible = false, timer = null, running = false;
    const stillThere = () => { const r = openBtn.getBoundingClientRect(); return visible && !busy() && r.top >= 0 && r.bottom <= innerHeight; };

    async function demo(){
      if (running || autoDone) return;
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
      if (visible && !autoDone) timer = setTimeout(() => { if (stillThere()) demo(); }, 900);
    }, { threshold: [0, .95, 1] });
    io.observe(openBtn);
    openBtn.addEventListener("click", e => { if (e.isTrusted) io.disconnect(); });
  })();

  if ("IntersectionObserver" in window && !reduce){
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        en.target.classList.add("in");
        io.unobserve(en.target);
      });
    }, { threshold: .15 });
    $$(".rv").forEach(el => io.observe(el));
  } else {
    $$(".rv").forEach(el => el.classList.add("in"));
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
    const KB = (document.getElementById("kbExtra") || {}).content || document;   // الأقسام المحذوفة من العرض (template)

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
          const steps = $$("#how .step", KB).map((st, i) => `${i + 1}. ${lines("h3", st)[0]}: ${lines("p", st)[0]}`);
          const heavy = $("#safety .plan .accent", KB);
          return { text: [...steps, "", lines("#how .tip", KB)[0] || "",
                          heavy ? `\n${lines("h3", heavy)[0]}: ${lines(".dose span", heavy).map((x, i) => EN && i ? x.charAt(0).toLowerCase() + x.slice(1) : x).join(t("، ثم "))}. ${lines("p.after", heavy)[0] || ""}` : ""]
                          .filter(Boolean).join("\n"), actions: ["order"] };
        } },
      { q: t("ما فوائد المنتج؟"), answer: () => ({
          text: [...INGREDIENTS.filter(i => /^(Konjac|Inulin|Ginger|Chromium|5-H)/.test(i.en)).map(i => `- **${EN ? i.name_en : i.ar}**: ${i.role}`),
                 "", lines("#results .disclaim", KB)[0] || ""].filter(Boolean).join("\n"),
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

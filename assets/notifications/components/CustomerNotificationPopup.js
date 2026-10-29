/* ============================================================
   CustomerNotificationPopup: عرض الإشعار العائم فقط (لا يحتوي بيانات ولا منطق اختيار)
   show(notification, durationMs) → Promise<"timeout" | "closed">
   - بطاقة صغيرة أسفل يسار الشاشة، لا تحجب الصفحة ولا تأخذ التركيز
   - ترتفع تلقائياً فوق زر واتساب وشريط «اطلب الآن» والمساعد (config.avoid)
   - يتوقف العدّ أثناء مرور الفأرة أو التركيز عليها، وEsc يغلقها
   ============================================================ */
(function(){
  const NS = window.CalmGastroNotify = window.CalmGastroNotify || {};
  const EN = window.CG_LANG === "en" && window.I18N_EN ? window.I18N_EN : null;
  const t = ar => EN && EN.ui && EN.ui[ar] != null ? EN.ui[ar] : ar;
  const TAGS = { testimonial: "تجربة عميل", stock: "توفر المنتج", purchase: "من طلبات عملائنا" };
  const SVG_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

  let root, card, bar, closeBtn, els = {}, current = null;

  function mount(){
    if (root) return;
    root = document.createElement("aside");
    root.className = "cgn"; root.setAttribute("aria-label", t("إشعار")); root.hidden = true;
    root.innerHTML = '<div class="cgn-card"><span class="cgn-ico" aria-hidden="true"></span><div class="cgn-body">'
      + '<p class="cgn-head"><b class="cgn-name"></b><span class="cgn-city"></span></p><p class="cgn-text"></p><span class="cgn-tag"></span></div>'
      + '<button type="button" class="cgn-close">' + SVG_X + '</button><span class="cgn-bar" aria-hidden="true"><i></i></span></div>';
    document.body.appendChild(root);
    card = root.firstChild; bar = root.querySelector(".cgn-bar i"); closeBtn = root.querySelector(".cgn-close");
    closeBtn.setAttribute("aria-label", t("إغلاق"));
    ["ico", "name", "city", "text", "tag"].forEach(k => els[k] = root.querySelector(".cgn-" + k));
    closeBtn.addEventListener("click", () => finish("closed"));
    root.addEventListener("keydown", e => { if (e.key === "Escape") finish("closed"); });
    // يتوقف العدّ والمؤشر أثناء القراءة (مرور الفأرة أو التركيز بلوحة المفاتيح)
    root.addEventListener("pointerenter", () => pause(true));
    root.addEventListener("pointerleave", () => pause(false));
    root.addEventListener("focusin", () => pause(true));
    root.addEventListener("focusout", e => { if (!root.contains(e.relatedTarget)) pause(false); });
    addEventListener("resize", schedulePlace, { passive: true });
    addEventListener("scroll", schedulePlace, { passive: true });
    // زر واتساب أو الشريط يظهر/يختفي بتغيير class أو hidden: يُعاد حساب الموضع فوراً
    const mo = new MutationObserver(schedulePlace);
    ((NS.config || {}).avoid || []).forEach(sel => document.querySelectorAll(sel).forEach(el => mo.observe(el, { attributes: true, attributeFilter: ["class", "hidden", "style"] })));
    mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  /* ---------- الموضع: أسفل اليسار، ويرتفع فوق أي عنصر ثابت يتقاطع معه ---------- */
  function base(){
    const w = innerWidth;
    return w <= 640 ? { side: 12, bottom: 12, full: true } : w <= 1024 ? { side: 16, bottom: 16 } : { side: 20, bottom: 20 };
  }
  function visibleRect(el){
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height && r.bottom > 0 && r.top < innerHeight ? r : null;
  }
  // يرجع false إذا لم تتسع الشاشة للإشعار بدون تغطية شيء مهم
  function place(){
    if (!root) return false;
    const cfg = NS.config || {}, gap = cfg.gap || 12, b = base();
    root.style.left = b.side + "px";
    root.style.right = b.full ? b.side + "px" : "auto";
    const box = root.getBoundingClientRect(), h = box.height, L = box.left, R = box.right;
    const rects = [];
    (cfg.avoid || []).forEach(sel => document.querySelectorAll(sel).forEach(el => { if (!root.contains(el)) { const r = visibleRect(el); if (r) rects.push(r); } }));
    let bottom = b.bottom;
    for (let k = 0; k < 6; k++){                          // كل ارتفاع قد يقابل عنصراً آخر فوقه
      const top = innerHeight - bottom - h, low = innerHeight - bottom;
      const hit = rects.find(r => r.left < R + gap && r.right > L - gap && r.top < low + gap && r.bottom > top - gap);
      if (!hit) break;
      bottom = Math.ceil(innerHeight - hit.top + gap);
    }
    const head = document.querySelector("header.top"), headBottom = head ? Math.max(0, head.getBoundingClientRect().bottom) : 0;
    root.style.bottom = bottom + "px";
    return innerHeight - bottom - h >= headBottom + 8;
  }
  let placeRaf = 0;
  function schedulePlace(){
    if (!current || placeRaf) return;
    placeRaf = requestAnimationFrame(() => { placeRaf = 0; if (current && !place()) finish("timeout"); });
  }

  /* ---------- العرض ---------- */
  function fill(n){
    els.ico.textContent = n.icon || "";
    els.name.textContent = n.name || n.text;
    els.city.textContent = n.name ? (n.city || "") : "";
    els.city.hidden = !els.city.textContent;
    els.text.textContent = n.name ? n.text : "";
    els.text.hidden = !els.text.textContent;
    els.tag.textContent = t(TAGS[n.type] || "");
    els.tag.hidden = !els.tag.textContent;
    card.dataset.type = n.type;
  }
  function tick(){
    if (!current || current.paused) return;
    const left = current.remaining - (performance.now() - current.since);
    if (left <= 0) finish("timeout");
    else current.timer = setTimeout(tick, Math.min(left, 250));
  }
  function pause(on){
    if (!current || current.paused === on) return;
    current.paused = on;
    bar.style.animationPlayState = on ? "paused" : "running";
    if (on){ current.remaining -= performance.now() - current.since; clearTimeout(current.timer); }
    else { current.since = performance.now(); tick(); }
  }
  function show(n, duration){
    mount();
    if (current) finish("timeout");
    fill(n);
    root.hidden = false; root.classList.remove("in", "out");
    if (!place()){ root.hidden = true; return Promise.resolve("noroom"); }
    void root.offsetWidth;                                  // يثبّت الموضع قبل الظهور (لا ينزلق من الأسفل)
    bar.style.animation = "none"; void bar.offsetWidth;
    bar.style.animation = "cgnBar " + duration + "ms linear forwards";
    requestAnimationFrame(() => root.classList.add("in"));
    return new Promise(resolve => {
      current = { resolve, remaining: duration, since: performance.now(), paused: false, timer: 0, poll: setInterval(schedulePlace, 300) };
      tick();
    });
  }
  function finish(reason){
    if (!current) return;
    const c = current; current = null;
    clearTimeout(c.timer); clearInterval(c.poll);
    const hadFocus = root.contains(document.activeElement);
    root.classList.remove("in"); root.classList.add("out");
    const done = () => { if (!current){ root.hidden = true; root.classList.remove("out"); } };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) done(); else setTimeout(done, 260);
    if (hadFocus) document.activeElement.blur();          // لا يبقى التركيز على عنصر مخفي
    c.resolve(reason);
  }

  NS.CustomerNotificationPopup = { show, hide: () => finish("closed"), place, get visible(){ return !!current; } };
})();

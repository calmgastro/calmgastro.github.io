/* ============================================================
   المتجر: السلة ← إتمام الطلب ← مراجعة ← تأكيد ← صفحة الطلب ← تتبع الطلب
   - الطلب يُنشأ في خادم الطلبات (orders/) ويُحفظ في قاعدة البيانات قبل عرض التأكيد
   - الأسعار هنا للعرض فقط؛ الخادم يعيد حسابها من product-data ولا يثق بالمتصفح
   - السلة فقط تُحفظ في المتصفح (localStorage)؛ بيانات العميل لا تُحفظ في المتصفح
   - يعتمد على CONFIG و t و LANG و EN من app.js
   ============================================================ */
(function(){
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const fmt = n => Number(n).toLocaleString("en-US");
  const money = n => `${fmt(n)} ${CONFIG.currency}`;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const API = (CONFIG.ordersApi && CONFIG.ordersApi.endpoint || "").replace(/\/$/, "");
  const RULES = {
    after: (CONFIG.pricing || {}).boxPriceAfterBundles,
    maxBoxes: (CONFIG.orders || {}).maxBoxesPerOrder || 30,
    maxQty: (CONFIG.orders || {}).maxQtyPerLine || 10,
    shipCost: (CONFIG.shipping || {}).cost || 0,
    freeFrom: (CONFIG.shipping || {}).freeFrom || 0
  };
  const PAYMENTS = (CONFIG.paymentMethods || [{ id: "cod" }]).map(p => ({ id: p.id, label: EN ? p.label_en || p.label : p.label, note: EN ? p.note_en || p.note : p.note }));
  const bundleById = id => CONFIG.bundles.find(b => b.id === id);
  const waLink = msg => `https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent(msg)}`;
  // نرسل JSON كنص عادي حتى يكون الطلب «بسيطاً» بلا طلب تحقق مسبق (CORS preflight): خطوة إضافية كانت تفشل
  // على بعض الجوالات والشبكات (آيفون خاصة) فيظهر «حدث خطأ أثناء إنشاء الطلب». الخادم يقرأ JSON من النص كما هو.
  const JSON_AS_TEXT = { "Content-Type": "text/plain;charset=UTF-8" };

  // عنصر DOM آمن: النصوص دائماً textContent
  function h(tag, attrs, ...kids){
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})){
      if (v == null || v === false) continue;
      if (k === "text") el.textContent = v;
      else if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;            // للأيقونات الثابتة فقط (SVG من هذا الملف)
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }
  // append بدون العناصر الفارغة (append(null) يكتب كلمة "null")
  const put = (el, ...kids) => el.append(...kids.flat().filter(k => k != null && k !== false));
  const ICON = {
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>',
    cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2l2.2 10.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.5L21 8H6.2"/><circle cx="10" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    wa: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.04 2a9.9 9.9 0 0 0-8.5 15l-1.4 5.1 5.2-1.4A9.9 9.9 0 1 0 12.04 2Zm4.5 12c-.25-.12-1.46-.72-1.69-.8-.23-.08-.39-.12-.55.12-.16.25-.63.8-.78.96-.14.17-.29.19-.53.07a6.7 6.7 0 0 1-3.32-2.9c-.25-.43.25-.4.72-1.33.08-.16.04-.3-.02-.42-.06-.12-.55-1.33-.76-1.82-.2-.48-.4-.41-.55-.42h-.47a.9.9 0 0 0-.65.3 2.7 2.7 0 0 0-.85 2.02 4.7 4.7 0 0 0 1 2.5 10.8 10.8 0 0 0 4.13 3.65c1.54.66 2.14.72 2.91.6.47-.07 1.46-.6 1.66-1.17.2-.58.2-1.07.15-1.17-.06-.1-.22-.17-.46-.29Z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>'
  };

  /* ---------- قياس الإعلانات: بدون أي بيانات شخصية ---------- */
  const SNAP = { add_to_cart: "ADD_CART", begin_checkout: "START_CHECKOUT", view_offers: "VIEW_CONTENT" };
  function track(event, data = {}){
    try { (window.dataLayer = window.dataLayer || []).push({ event: "cg_" + event, ...data }); } catch (_) {}
    if (typeof window.snaptr !== "function") return;
    try {
      if (event === "order_created") snaptr("track", "PURCHASE", { price: data.value, currency: "SAR", item_ids: data.items, number_items: data.boxes, transaction_id: data.order });
      else if (SNAP[event]) snaptr("track", SNAP[event], { price: data.value, currency: "SAR", item_ids: data.items, number_items: data.boxes });
    } catch (_) {}
  }

  /* ---------- التسعير (عرض فقط؛ نفس قاعدة الخادم) ---------- */
  function priceForBoxes(n){
    const maxBundle = Math.max(...CONFIG.bundles.map(b => b.boxes));
    if (n > maxBundle && RULES.after) return n * RULES.after;
    const best = [0];
    for (let k = 1; k <= n; k++){
      best[k] = Infinity;
      for (const b of CONFIG.bundles) if (b.boxes <= k && best[k - b.boxes] + b.price < best[k]) best[k] = best[k - b.boxes] + b.price;
    }
    return best[n];
  }
  function quote(items){
    const lines = items.map(i => { const b = bundleById(i.id); return { b, qty: i.qty, total: b.price * i.qty }; });
    const subtotal = lines.reduce((s, l) => s + l.total, 0);
    const boxes = lines.reduce((s, l) => s + l.b.boxes * l.qty, 0);
    const best = boxes ? Math.min(subtotal, priceForBoxes(boxes)) : 0;
    const shipping = boxes ? (RULES.freeFrom && best >= RULES.freeFrom ? 0 : RULES.shipCost) : 0;
    return { lines, subtotal, boxes, discount: subtotal - best, shipping, total: best + shipping };
  }
  const boxesText = n => EN ? (n === 1 ? "1 box" : `${n} boxes`) : n === 1 ? "علبة واحدة" : n === 2 ? "علبتان" : n <= 10 ? `${n} علب` : `${n} علبة`;

  /* ---------- السلة: تبقى بعد التحديث والعودة، ومتزامنة بين التبويبات ---------- */
  const CART_KEY = "cg-cart";
  let cart = loadCart();
  function loadCart(){
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(CART_KEY) || "null"); } catch (_) {}
    const items = raw && Array.isArray(raw.items) ? raw.items : [];
    const merged = new Map();
    for (const it of items){
      if (!bundleById(it && it.id) || !Number.isInteger(it.qty) || it.qty < 1) continue;   // منتج حُذف أو بيانات تالفة
      merged.set(it.id, Math.min(RULES.maxQty, (merged.get(it.id) || 0) + it.qty));
    }
    return [...merged].map(([id, qty]) => ({ id, qty }));
  }
  function saveCart(){
    serverQuote = null; attempt = null;                     // السلة تغيّرت: مراجعة ومحاولة جديدة
    try { cart.length ? localStorage.setItem(CART_KEY, JSON.stringify({ v: 1, items: cart })) : localStorage.removeItem(CART_KEY); } catch (_) {}
    renderAll();
  }
  window.addEventListener("storage", e => { if (e.key === CART_KEY){ cart = loadCart(); renderAll(); } });
  const cartBoxes = (items = cart) => items.reduce((s, i) => s + bundleById(i.id).boxes * i.qty, 0);
  const cartUnits = () => cart.reduce((s, i) => s + i.qty, 0);

  // يعيد رسالة خطأ إذا تجاوز الحدود، وإلا null
  function setQty(id, qty, { silent } = {}){
    const b = bundleById(id); if (!b) return null;
    qty = Math.max(0, Math.min(RULES.maxQty, Math.floor(qty)));
    const others = cart.filter(i => i.id !== id);
    if (qty && cartBoxes(others) + b.boxes * qty > RULES.maxBoxes) return limitMsg();
    const prev = (cart.find(i => i.id === id) || {}).qty || 0;
    cart = qty ? (prev ? cart.map(i => i.id === id ? { id, qty } : i) : [...cart, { id, qty }]) : others;
    if (!silent && qty < prev) track("remove_from_cart", { items: [id], quantity: prev - qty });
    saveCart();
    return null;
  }
  const limitMsg = () => t("الحد الأقصى للطلب الواحد {n} علبة. للكميات الأكبر تواصل معنا لطلب الجملة.", { n: RULES.maxBoxes });

  /* ---------- بطاقات العروض ---------- */
  const bundlesBox = $("#bundles");
  const offerMsg = $("#offerMsg");
  CONFIG.bundles.forEach(b => {
    const save = b.was ? Math.round((1 - b.price / b.was) * 100) : 0;
    const per = Math.round(b.price / (b.boxes * 30) * 10) / 10;
    let qty = 1;
    const qtyOut = h("output", { class: "qty-val num", "aria-live": "polite", text: "1" });
    const minus = h("button", { type: "button", class: "qty-btn", "aria-label": t("إنقاص الكمية"), html: ICON.minus });
    const plus = h("button", { type: "button", class: "qty-btn", "aria-label": t("زيادة الكمية"), html: ICON.plus });
    const setLocal = v => { qty = Math.max(1, Math.min(RULES.maxQty, v)); qtyOut.textContent = qty; minus.disabled = qty <= 1; plus.disabled = qty >= RULES.maxQty; };
    minus.addEventListener("click", () => setLocal(qty - 1));
    plus.addEventListener("click", () => setLocal(qty + 1));
    setLocal(1);
    const addBtn = h("button", { type: "button", class: "btn btn-primary add-btn", "data-id": b.id, disabled: CONFIG.inStock === false },
      h("span", { html: ICON.cart }), h("span", { class: "add-lbl", text: CONFIG.inStock === false ? t("غير متوفر حالياً") : t("إضافة للسلة") }));
    addBtn.addEventListener("click", () => {
      const have = (cart.find(i => i.id === b.id) || {}).qty || 0;
      const err = setQty(b.id, have + qty, { silent: true });
      offerMsg.textContent = err || "";
      if (err) return;
      track("add_to_cart", { items: [b.id], boxes: b.boxes * qty, value: b.price * qty });
      const lbl = $(".add-lbl", addBtn);
      lbl.textContent = t("✓ أُضيف للسلة"); addBtn.classList.add("added");
      setTimeout(() => { lbl.textContent = t("إضافة للسلة"); addBtn.classList.remove("added"); }, 1600);
      setLocal(1);
      // إذا كانت السلة الجانبية ظاهرة نبرزها، وإلا نفتح نافذة السلة
      const panel = $("#cartPanel"), r = panel.getBoundingClientRect();
      if (r.top < innerHeight - 80 && r.bottom > 80 && getComputedStyle(panel).display !== "none"){ panel.classList.remove("flash"); void panel.offsetWidth; panel.classList.add("flash"); }
      else openDrawer(addBtn);
    });
    bundlesBox.appendChild(h("article", { class: "bundle", "data-id": b.id, "aria-labelledby": "bt-" + b.id },
      b.tag ? h("span", { class: "tag", text: b.tag }) : null,
      h("div", { class: "card" },
        h("img", { class: "b-thumb", src: "assets/box-thumb.jpg", alt: "", width: "64", height: "65", loading: "lazy" }),
        h("div", { class: "b-info" },
          h("h3", { class: "b-title", id: "bt-" + b.id, text: b.title }),
          h("p", { class: "b-prog", text: b.program }),
          h("p", { class: "b-sub", text: t("{n} ظرفاً · ≈ {per} {cur} لليوم", { n: b.boxes * 30, per, cur: CONFIG.currency }) }),
          h("p", { class: "b-stock" + (CONFIG.inStock === false ? " out" : ""), text: CONFIG.inStock === false ? t("غير متوفر حالياً") : t("متوفر") })),
        h("div", { class: "b-price" },
          h("span", { class: "now", text: money(b.price) }),
          b.was ? h("span", { class: "was", text: money(b.was) }) : null,
          save ? h("span", { class: "b-save", text: t("وفّر {save}%", { save }) }) : null),
        h("div", { class: "b-actions" },
          h("div", { class: "qty", role: "group", "aria-label": t("الكمية") }, minus, qtyOut, plus),
          addBtn))));
  });
  if (RULES.after){
    $("#priceRule").textContent = t("أكثر من {max} علب؟ سعر العلبة {p} فقط. يُطبَّق أفضل سعر تلقائياً في السلة.", {
      max: Math.max(...CONFIG.bundles.map(b => b.boxes)), p: money(RULES.after) });
  }
  $$(".js-wa-wholesale").forEach(a => { a.href = waLink(t("السلام عليكم، أرغب في الاستفسار عن أسعار وكميات طلبات الجملة لمنتج CalmGastro.")); a.target = "_blank"; a.rel = "noopener"; a.addEventListener("click", () => track("whatsapp_click", { context: "wholesale" })); });
  $$(".js-wa").forEach(a => a.addEventListener("click", () => track("whatsapp_click", { context: "support" })));

  /* ---------- عرض السلة (اللوحة الجانبية ونافذة السلة) ---------- */
  function totalsRows(q, { serverDiscountLabel } = {}){
    const row = (label, value, cls) => h("div", { class: "tr " + (cls || "") }, h("span", { text: label }), h("b", { text: value }));
    return h("div", { class: "totals" },
      row(t("المجموع الفرعي"), money(q.subtotal)),
      q.discount ? row(serverDiscountLabel || t("خصم أفضل سعر"), "− " + money(q.discount), "disc") : null,
      row(t("الشحن"), q.shipping ? money(q.shipping) : t("مجاني"), q.shipping ? "" : "free"),
      row(t("الإجمالي"), money(q.total), "grand"));
  }
  function renderCart(container, { onBrowse, onCheckout, onContinue } = {}){
    container.textContent = "";
    if (!cart.length){
      container.append(h("div", { class: "cart-empty" },
        h("span", { class: "ce-icon", html: ICON.cart }),
        h("h3", { text: t("سلتك فارغة") }),
        h("p", { text: t("لم تضف أي منتجات إلى السلة بعد.") }),
        h("button", { type: "button", class: "btn btn-ghost", text: t("تصفح المنتجات"), onclick: onBrowse })));
      return;
    }
    const q = quote(cart);
    const list = h("ul", { class: "cart-lines" });
    for (const l of q.lines){
      const b = l.b;
      const err = h("p", { class: "line-err", role: "alert" });
      const change = v => { const e = setQty(b.id, v); if (e){ err.textContent = e; } };
      list.append(h("li", { class: "cart-line", "data-id": b.id },
        h("img", { src: "assets/box-thumb.jpg", alt: "", width: "56", height: "57", loading: "lazy" }),
        h("div", { class: "cl-info" },
          h("b", { class: "cl-name", text: `CalmGastro · ${b.title}` }),
          h("span", { class: "cl-sub", text: `${b.program} · ${money(b.price)}` }),
          h("div", { class: "cl-row" },
            h("div", { class: "qty sm", role: "group", "aria-label": t("الكمية") },
              h("button", { type: "button", class: "qty-btn", "aria-label": t("إنقاص الكمية"), html: ICON.minus, disabled: l.qty <= 1, onclick: () => change(l.qty - 1) }),
              h("output", { class: "qty-val num", text: String(l.qty) }),
              h("button", { type: "button", class: "qty-btn", "aria-label": t("زيادة الكمية"), html: ICON.plus, disabled: l.qty >= RULES.maxQty, onclick: () => change(l.qty + 1) })),
            h("button", { type: "button", class: "cl-remove", "aria-label": t("حذف {name} من السلة", { name: b.title }), html: ICON.trash, onclick: () => setQty(b.id, 0) })),
          err),
        h("b", { class: "cl-total", text: money(l.total) })));
    }
    put(container, list,
      h("p", { class: "cart-boxes", text: t("{boxes} في السلة ({n} ظرفاً)", { boxes: boxesText(q.boxes), n: q.boxes * 30 }) }),
      totalsRows(q),
      q.discount ? h("p", { class: "cart-note", text: t("طبّقنا أفضل سعر لعدد العلب في سلتك تلقائياً.") }) : null,
      h("div", { class: "cart-actions" },
        h("a", { href: "#/checkout", class: "btn btn-primary", text: t("إتمام الطلب"), onclick: onCheckout }),
        onContinue ? h("button", { type: "button", class: "btn btn-ghost", text: t("متابعة التسوق"), onclick: onContinue }) : null));
  }

  /* ---------- نافذة السلة ---------- */
  const drawer = $("#cartDrawer"), drawerBody = $("#cartDrawerBody");
  let drawerReturn = null;
  function openDrawer(from){
    drawerReturn = from || document.activeElement;
    renderDrawer();
    drawer.hidden = false;
    document.body.classList.add("drawer-open");
    requestAnimationFrame(() => drawer.classList.add("open"));
    $("#cartClose").focus({ preventScroll: true });
    track("view_cart", { boxes: cartBoxes() });
  }
  function closeDrawer(returnFocus = true){
    if (drawer.hidden) return;
    drawer.classList.remove("open");
    document.body.classList.remove("drawer-open");
    drawer.hidden = true;
    if (returnFocus && drawerReturn && drawerReturn.focus) drawerReturn.focus({ preventScroll: true });
  }
  const goOffers = () => { closeDrawer(false); if (location.hash.startsWith("#/")) location.hash = "#order"; else $("#order").scrollIntoView({ behavior: reduce ? "auto" : "smooth" }); };
  function renderDrawer(){ renderCart(drawerBody, { onBrowse: goOffers, onCheckout: () => closeDrawer(false), onContinue: () => closeDrawer() }); }
  $("#cartBtn").addEventListener("click", e => openDrawer(e.currentTarget));
  $("#cartClose").addEventListener("click", () => closeDrawer());
  drawer.addEventListener("click", e => { if (e.target === drawer) closeDrawer(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !drawer.hidden) closeDrawer();
    if (e.key === "Tab" && !drawer.hidden){                    // التركيز يبقى داخل النافذة
      const f = $$("button:not([disabled]), a[href], input, [tabindex='0']", $(".drawer-panel")).filter(x => x.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]){ e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]){ e.preventDefault(); f[0].focus(); }
    }
  });

  /* ---------- تحديث كل أماكن السلة ---------- */
  function renderAll(){
    const units = cartUnits(), q = quote(cart);
    const badge = $("#cartCount");
    badge.textContent = units; badge.hidden = !units;
    $("#cartBtn").setAttribute("aria-label", units ? t("السلة: {n} منتجات، الإجمالي {total}", { n: units, total: money(q.total) }) : t("السلة فارغة"));
    renderCart($("#cartPanelBody"), { onBrowse: goOffers });
    if (!drawer.hidden) renderDrawer();
    // شريط الجوال: «إتمام الطلب — المبلغ» عند وجود منتجات
    document.body.classList.toggle("has-cart", !!units);
    $("#mbarLabel").textContent = units ? t("{boxes} في السلة", { boxes: boxesText(q.boxes) }) : t("يبدأ من");
    $("#mbarPrice").textContent = units ? money(q.total) : money(Math.min(...CONFIG.bundles.map(b => b.price)));
    const mb = $("#mbarBtn");
    mb.textContent = units ? t("إتمام الطلب") : t("اطلب الآن");
    mb.setAttribute("href", units ? "#/checkout" : "#order");
    window.dispatchEvent(new Event("cg:cart"));
    if (route.name === "checkout") renderCheckout();
  }

  /* ============================================================
     الصفحات الداخلية (#/checkout و #/order/رقم و #/track) — لا تُفهرس لأنها بعد علامة #
     ============================================================ */
  const views = { checkout: $("#view-checkout"), order: $("#view-order"), track: $("#view-track") };
  let route = { name: "home" };
  let lastLandingY = 0;
  function parseRoute(){
    const m = location.hash.match(/^#\/(checkout|order|track)(?:\/([A-Za-z0-9-]+))?\/?$/);
    return m ? { name: m[1], arg: m[2] || "" } : { name: "home" };
  }
  function show(name){
    const wasHome = route.name === "home";
    if (wasHome && name !== "home") lastLandingY = scrollY;
    Object.entries(views).forEach(([k, el]) => { el.hidden = k !== name; });
    document.body.classList.toggle("view-active", name !== "home");
    $("main").hidden = name !== "home";
    return wasHome;
  }
  function onRoute(){
    closeDrawer(false);
    if (/^#\/order\/[^?]+\?k=/.test(location.hash)) captureLinkToken();
    const prev = route.name;
    route = parseRoute();
    show(route.name);
    if (route.name === "home"){
      const id = location.hash.slice(1);
      const target = id && document.getElementById(id);
      if (prev !== "home") requestAnimationFrame(() => target ? target.scrollIntoView() : scrollTo(0, lastLandingY));
      return;
    }
    scrollTo(0, 0);
    if (route.name === "checkout"){ step = "delivery"; renderCheckout(); track("begin_checkout", { boxes: cartBoxes(), value: quote(cart).total, items: cart.map(i => i.id) }); }
    if (route.name === "order") openOrderPage(route.arg);
    if (route.name === "track") openTrackPage(route.arg);
    const hd = $("h1", views[route.name]); if (hd){ hd.setAttribute("tabindex", "-1"); hd.focus({ preventScroll: true }); }
  }
  window.addEventListener("hashchange", onRoute);

  /* ---------- إتمام الطلب ---------- */
  const form = $("#checkoutForm");
  let step = "delivery";
  let loc = null;                 // موقع العميل: في الذاكرة فقط
  let attempt = null;             // { key, payloadHash, expectedTotal }
  let serverQuote = null;         // آخر أسعار من الخادم إن اختلفت

  const toLatin = v => String(v).replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0);
  // نفس قاعدة الخادم: 05XXXXXXXX و +9665XXXXXXXX و 009665… و 5XXXXXXXX
  function normPhone(v){
    let d = toLatin(v).replace(/[\s\-().]/g, "");
    if (!/^\+?\d+$/.test(d)) return null;
    d = d.replace(/^\+/, "").replace(/^00/, "");
    if (d.startsWith("966")) d = d.slice(3);
    if (d.startsWith("0")) d = d.slice(1);
    return /^5\d{8}$/.test(d) ? "0" + d : null;
  }
  const rules = {
    name:     v => (v.trim().length >= 2 && /\p{L}/u.test(v)) || t("يرجى كتابة الاسم الكامل"),
    phone:    v => !!normPhone(v) || t("يرجى إدخال رقم جوال سعودي صحيح"),
    city:     v => v.trim().length >= 2 || t("يرجى كتابة المدينة"),
    district: v => v.trim().length >= 2 || t("يرجى كتابة الحي"),
    address:  v => v.trim().length >= 3 || t("يرجى كتابة عنوان التوصيل")
  };
  function check(name){
    const input = form.elements[name], res = rules[name](input.value), ok = res === true;
    input.setAttribute("aria-invalid", ok ? "false" : "true");
    $("#e-" + name).textContent = ok ? "" : res;
    return ok;
  }
  function setFieldError(name, msg){ const i = form.elements[name]; if (!i) return; i.setAttribute("aria-invalid", "true"); $("#e-" + name).textContent = msg; }
  Object.keys(rules).forEach(n => {
    const el = form.elements[n];
    el.addEventListener("blur", () => el.value && check(n));
    el.addEventListener("input", () => el.getAttribute("aria-invalid") === "true" && check(n));
  });
  form.elements.phone.addEventListener("blur", () => { const p = normPhone(form.elements.phone.value); if (p) form.elements.phone.value = p; });

  // طرق الدفع من الإعدادات المركزية (الدفع عند الاستلام الآن، ويمكن إضافة غيرها لاحقاً)
  const payBox = $("#payMethods");
  PAYMENTS.forEach((p, i) => payBox.append(h("label", { class: "pay-opt" },
    h("input", { type: "radio", name: "payment", value: p.id, checked: i === 0 }),
    h("span", { class: "pay-dot", "aria-hidden": "true" }),
    h("span", null, h("b", { text: p.label }), h("small", { text: p.note || "" })))));
  $("#coEta").textContent = t("التوصيل خلال {d} · {ship}", { d: CONFIG.deliveryShort, ship: CONFIG.shippingNote });

  const customer = () => ({
    name: form.elements.name.value.trim(), phone: normPhone(form.elements.phone.value) || form.elements.phone.value.trim(),
    city: form.elements.city.value.trim(), district: form.elements.district.value.trim(),
    address: form.elements.address.value.trim(), notes: form.elements.notes.value.trim()
  });
  const paymentId = () => (form.elements.payment && form.elements.payment.value) || "cod";

  function renderSummary(){
    const box = $("#coSummaryBody"); box.textContent = "";
    if (!cart.length) return;
    const q = serverQuote ? Object.assign(quote(cart), serverQuote) : quote(cart);
    box.append(h("ul", { class: "sum-lines" }, q.lines.map(l => h("li", null,
      h("img", { src: "assets/box-thumb.jpg", alt: "", width: "44", height: "45" }),
      h("span", null, h("b", { text: `CalmGastro · ${l.b.title}` }), h("small", { text: `${l.b.program} · ${t("الكمية: {q}", { q: l.qty })} · ${money(l.b.price)}` })),
      h("b", { class: "num-sum", text: money(l.total) })))),
      totalsRows(q));
    $("#coSumTotal").textContent = money(q.total);
  }

  function renderCheckout(){
    const empty = !cart.length;
    $("#coEmpty").hidden = !empty;
    $("#coGrid").hidden = empty;
    if (empty){ renderCart($("#coEmptyBody"), { onBrowse: goOffers }); setSteps("cart"); return; }
    renderSummary();
    form.hidden = step !== "delivery";
    $("#reviewStep").hidden = step !== "review";
    setSteps(step);
    if (step === "review") renderReview();
  }
  function setSteps(current){
    const order = ["cart", "delivery", "review", "done"];
    $$("#coSteps li").forEach(li => {
      const i = order.indexOf(li.dataset.step), c = order.indexOf(current);
      li.classList.toggle("done", i < c); li.classList.toggle("current", i === c);
      if (i === c) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
  }
  $("#coEditCart").addEventListener("click", e => openDrawer(e.currentTarget));

  form.addEventListener("submit", e => {
    e.preventDefault();
    const bad = Object.keys(rules).filter(n => !check(n));
    if (bad.length){ form.elements[bad[0]].focus(); return; }
    step = "review"; serverQuote = null;
    renderCheckout();
    $("#reviewStep").scrollIntoView({ behavior: "auto", block: "start" });
    $("#reviewTitle").focus({ preventScroll: true });
  });
  $("#editDetails").addEventListener("click", () => { step = "delivery"; renderCheckout(); form.elements.name.focus(); });

  function renderReview(){
    const c = customer(), q = serverQuote ? Object.assign(quote(cart), serverQuote) : quote(cart);
    const prod = $("#rvProducts"); prod.textContent = "";
    prod.append(h("ul", { class: "rv-lines" }, q.lines.map(l => h("li", null,
      h("span", { text: `CalmGastro · ${l.b.title} (${l.b.program})` }),
      h("span", { class: "num-sum", text: `${l.qty} × ${money(l.b.price)}` })))));
    const dl = $("#rvDelivery"); dl.textContent = "";
    [[t("الاسم"), c.name], [t("الجوال"), c.phone], [t("المدينة"), c.city], [t("الحي"), c.district], [t("العنوان"), c.address],
     c.notes ? [t("ملاحظات"), c.notes] : null, loc ? [t("الموقع"), t("تم تحديد موقعك على الخريطة")] : null]
      .filter(Boolean).forEach(([k, v]) => dl.append(h("dt", { text: k }), h("dd", { text: v })));
    const p = PAYMENTS.find(x => x.id === paymentId()) || PAYMENTS[0];
    $("#rvPayment").textContent = p.label + (p.note ? " — " + p.note : "");
    const tb = $("#rvTotals"); tb.textContent = ""; tb.append(totalsRows(q));
    $("#rvEta").textContent = t("التوصيل المتوقع: {d}", { d: CONFIG.deliveryShort });
    $("#placeOrder").textContent = t("تأكيد الطلب — {total}", { total: money(q.total) });
  }

  /* ---------- تحديد الموقع (اختياري، عند الضغط فقط) ---------- */
  const locBtn = $("#locBtn"), locBtnText = $("#locBtnText"), locStatus = $("#locStatus");
  const LOC_FAIL = t("لم نتمكن من تحديد موقعك. يمكنك إدخال المدينة والحي يدوياً.");
  let locating = false;
  function showLoc(kind, lines, withClear){
    locStatus.className = "loc-status " + kind; locStatus.textContent = "";
    lines.forEach((x, i) => locStatus.append(h("div", { class: i ? null : "t", text: x })));
    if (withClear) locStatus.append(h("button", { type: "button", class: "clear", text: t("إزالة الموقع"), onclick: clearLoc }));
    locStatus.hidden = false;
  }
  function clearLoc(){ loc = null; locStatus.hidden = true; locStatus.textContent = ""; locBtnText.textContent = t("تحديد موقعي تلقائياً"); locBtn.focus(); }
  async function reverseGeocode(lat, lng){
    const rg = CONFIG.reverseGeocode || {};
    if (!rg.provider || rg.provider === "none") return null;
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), rg.timeoutMs || 8000);
    try {
      if (rg.provider === "endpoint" && rg.endpoint){
        const r = await fetch(`${rg.endpoint}?lat=${lat}&lng=${lng}`, { signal: ctrl.signal });
        if (!r.ok) return null;
        const j = await r.json();
        return { city: String(j.city || "").trim(), district: String(j.district || "").trim() };
      }
      if (rg.provider === "nominatim"){
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&addressdetails=1&accept-language=${LANG}&lat=${lat}&lon=${lng}`, { signal: ctrl.signal });
        if (!r.ok) return null;
        const a = (await r.json()).address || {};
        return { city: (a.city || a.town || a.village || a.municipality || a.county || "").trim(),
                 district: (a.suburb || a.neighbourhood || a.quarter || a.city_district || a.residential || a.hamlet || "").trim() };
      }
    } catch (_) {} finally { clearTimeout(timer); }
    return null;
  }
  locBtn.addEventListener("click", () => {
    if (locating) return;
    if (!("geolocation" in navigator) || !window.isSecureContext){ showLoc("soft", [LOC_FAIL]); return; }
    locating = true; loc = null; locBtn.disabled = true; locBtnText.textContent = t("جارٍ تحديد موقعك…"); locStatus.hidden = true;
    let settled = false;
    const finish = label => { locating = false; locBtn.disabled = false; locBtnText.textContent = label; };
    const fail = () => { if (settled) return; settled = true; clearTimeout(watchdog); finish(t("تحديد موقعي تلقائياً")); showLoc("soft", [LOC_FAIL]); };
    const watchdog = setTimeout(fail, 30000);
    try {
      navigator.geolocation.getCurrentPosition(async pos => {
        if (settled) return; settled = true; clearTimeout(watchdog);
        loc = { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6) };
        locBtnText.textContent = t("جارٍ تحديد المدينة والحي…");
        const place = await reverseGeocode(loc.lat, loc.lng);
        if (!loc) return;
        if (place && place.city) form.elements.city.value = place.city;
        if (place && place.district) form.elements.district.value = place.district;
        if (form.elements.city.value) check("city");
        if (form.elements.district.value) check("district");
        const lines = [t("✓ تم تحديد موقعك")];
        if (place && (place.city || place.district)){
          lines.push(t("المدينة: {city} — الحي: {district}", { city: place.city || "—", district: place.district || "—" }));
          lines.push(t("يمكنك تعديل المدينة والحي إذا لم تكن دقيقة."));
        } else lines.push(t("سنحفظ موقعك على الخريطة مع الطلب. اكتب المدينة والحي يدوياً."));
        finish(t("تحديث موقعي")); showLoc("ok", lines, true);
      }, fail, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
    } catch (_) { fail(); }
  });

  /* ---------- تأكيد الطلب: يُنشأ في قاعدة البيانات أولاً ---------- */
  const placeBtn = $("#placeOrder"), errBox = $("#orderError");
  let placing = false;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("")).replace(/-/g, "");

  async function placeOrder(){
    if (placing) return;
    if (!cart.length){ location.hash = "#/checkout"; return; }
    const c = customer();
    const payload = { items: cart.map(i => ({ id: i.id, qty: i.qty })), customer: c, location: loc, paymentMethod: paymentId(), lang: LANG };
    const sig = JSON.stringify(payload);
    // نفس المحاولة (إعادة المحاولة بعد خطأ أو ضغطتين) = نفس المفتاح، فلا يتكرر الطلب
    if (!attempt || attempt.sig !== sig) attempt = { sig, key: uuid(), expectedTotal: serverQuote ? serverQuote.total : quote(cart).total };
    placing = true; placeBtn.disabled = true; placeBtn.classList.add("loading");
    placeBtn.textContent = t("جاري تأكيد الطلب...");
    errBox.hidden = true; $("#priceNote").hidden = true;
    let res = null, data = null, failure = "NET";
    try {
      if (!API) throw new Error("no endpoint");
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        res = await fetch(API + "/api/orders", { method: "POST", headers: JSON_AS_TEXT, signal: ctrl.signal,
          body: JSON.stringify({ ...payload, idempotencyKey: attempt.key, expectedTotal: attempt.expectedTotal, hp: $("#f-hp").value }) });
        data = await res.json().catch(() => null);
      } finally { clearTimeout(timer); }
    } catch (e) { res = null; failure = e && e.name === "AbortError" ? "TIMEOUT" : navigator.onLine === false ? "OFFLINE" : "NET"; }
    placing = false; placeBtn.disabled = false; placeBtn.classList.remove("loading");

    if (res && (res.status === 201 || res.status === 200) && data && data.order && data.order.orderNumber){
      const o = data.order;
      rememberOrder(o.orderNumber, data.token);
      track("order_created", { order: o.orderNumber, value: o.total, boxes: o.boxes, items: o.items.map(i => i.productId) });
      cart = []; saveCart();
      attempt = null; serverQuote = null; loc = null;
      form.reset(); locStatus.hidden = true; locBtnText.textContent = t("تحديد موقعي تلقائياً");
      step = "delivery";
      justCreated = o;
      location.hash = "#/order/" + o.orderNumber;
      return;
    }
    renderReview();
    if (res && res.status === 409 && data && data.error === "price_changed" && data.quote){
      serverQuote = data.quote; attempt = null;
      renderSummary(); renderReview();
      const n = $("#priceNote"); n.textContent = t("تغيّرت الأسعار منذ فتحك للصفحة. هذا هو الإجمالي المحدّث؛ راجعه ثم اضغط «تأكيد الطلب» مرة أخرى."); n.hidden = false; n.focus();
      return;
    }
    if (res && res.status === 422 && data && data.fields){
      const f = data.fields;
      const fieldMsgs = { phone: t("يرجى إدخال رقم جوال سعودي صحيح"), name: t("يرجى كتابة الاسم الكامل"), city: t("يرجى كتابة المدينة"), district: t("يرجى كتابة الحي"), address: t("يرجى كتابة عنوان التوصيل") };
      const fields = Object.keys(fieldMsgs).filter(k => f[k]);
      if (fields.length){ step = "delivery"; renderCheckout(); fields.forEach(k => setFieldError(k, fieldMsgs[k])); form.elements[fields[0]].focus(); return; }
      if (f.items){ showError(f.items === "max_boxes" || f.items === "qty_limit" ? limitMsg() : t("يوجد منتج غير متاح في سلتك. حدّث السلة ثم حاول مرة أخرى.")); return; }
    }
    if (res && res.status === 409 && data && data.error === "out_of_stock"){ showError(t("المنتج غير متوفر حالياً. لم يتم تسجيل الطلب.")); return; }
    if (res && res.status === 429){ showError(t("محاولات كثيرة خلال وقت قصير. انتظر دقيقة ثم اضغط «حاول مرة أخرى». لم يتم تسجيل الطلب.")); return; }
    // رمز قصير يوضح نوع المشكلة: NET = لم يصل الطلب للخادم (شبكة/حظر)، TIMEOUT = تأخر الرد، S500… = رد الخادم
    // NET/TIMEOUT: لم يصل الطلب لخادمنا إطلاقاً، غالباً شبكة الواي فاي أو إعداد في الجهاز يحجب الاتصال؛ نرشد العميل لبديل فوري
    if (!res){ showError(t("تعذّر الاتصال بخادم الطلبات من شبكتك الحالية، ولم يتم تسجيل الطلب. أوقف الواي فاي وجرّب ببيانات الجوال، أو أرسل طلبك عبر واتساب وسنكمله لك."), failure); return; }
    showError(t("حدث خطأ أثناء إنشاء الطلب. لم يتم تسجيل الطلب."), "S" + res.status + (data && data.error ? "-" + data.error : ""));
  }
  function showError(msg, code){
    $("#orderErrorText").textContent = msg;
    $("#orderErrorCode").textContent = code ? t("رمز المشكلة: {c}", { c: code }) : "";
    if (code) track("order_failed", { code });
    const q = quote(cart);
    const lines = q.lines.map(l => `- ${l.b.title} (${l.b.program}) × ${l.qty}`).join("\n");
    $("#orderErrorWa").href = waLink(t("مرحباً، واجهت مشكلة في إتمام الطلب من الموقع وأرغب في طلب:\n{lines}\nالإجمالي: {total}", { lines, total: money(q.total) }));
    errBox.hidden = false;
    errBox.focus();
  }
  placeBtn.addEventListener("click", placeOrder);
  $("#retryOrder").addEventListener("click", placeOrder);
  $("#orderErrorWa").addEventListener("click", () => track("whatsapp_click", { context: "order_error" }));

  /* ---------- صفحة الطلب ---------- */
  const ORDERS_KEY = "cg-orders";        // رقم الطلب ورمز الوصول فقط (بدون بيانات العميل)
  let justCreated = null;
  function savedOrders(){ try { const a = JSON.parse(localStorage.getItem(ORDERS_KEY) || "[]"); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
  function rememberOrder(n, token){
    try { localStorage.setItem(ORDERS_KEY, JSON.stringify([{ n, t: token }, ...savedOrders().filter(o => o.n !== n)].slice(0, 10))); } catch (_) {}
  }
  // الحالات كما في الخادم (orders/src/statuses.js): ست مراحل عادية + ثلاث استثنائية تظهر فقط إذا حدثت
  const FLOW = ["RECEIVED", "CONFIRMED", "PREPARING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];
  const STATUS = {
    RECEIVED: t("تم استلام الطلب"), CONFIRMED: t("تم تأكيد الطلب"), PREPARING: t("جاري التجهيز"), SHIPPED: t("تم الشحن"),
    OUT_FOR_DELIVERY: t("خرج للتوصيل"), DELIVERED: t("تم التوصيل"), CANCELLED: t("ملغي"), FAILED: t("تعذّر إكمال الطلب"), ON_HOLD: t("معلّق")
  };
  const MSG = {
    RECEIVED: t("تم استلام طلبك بنجاح."), CONFIRMED: t("تم تأكيد طلبك من فريقنا."), PREPARING: t("جاري تجهيز طلبك."),
    SHIPPED: t("تم تسليم طلبك لشركة الشحن."), OUT_FOR_DELIVERY: t("طلبك في الطريق إليك."), DELIVERED: t("تم توصيل طلبك بنجاح."),
    CANCELLED: t("تم إلغاء طلبك."), FAILED: t("تعذّر إكمال طلبك. سنتواصل معك."), ON_HOLD: t("طلبك معلّق مؤقتاً، وسنتواصل معك.")
  };
  const dateFmt = new Intl.DateTimeFormat(EN ? "en-GB" : "ar-SA-u-nu-latn-ca-gregory", { timeZone: "Asia/Riyadh", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  const when = iso => dateFmt.format(new Date(iso));

  /* المسار: المراحل المكتملة مختلفة شكلاً ونصاً عن القادمة، والحالية مميزة؛ لكل مرحلة وقتها ورسالتها */
  function timeline(o){
    const last = {};                                   // آخر وقت وملاحظة لكل حالة
    let pos = -1;                                      // آخر مرحلة عادية وصلها الطلب
    for (const x of o.history){
      last[x.status] = { at: x.at, note: x.note || "" };
      const i = FLOW.indexOf(x.status); if (i >= 0) pos = i;
    }
    const exc = FLOW.includes(o.status) ? null : o.status;
    const stage = (key, state) => {
      const info = last[key], mark = { done: t("(مكتملة)"), current: t("(الحالية)"), next: t("(لم تبدأ بعد)"), exc: t("(الحالية)") }[state];
      return h("li", { class: state, "aria-current": state === "current" || state === "exc" ? "step" : null },
        h("span", { class: "dot", "aria-hidden": "true" }),
        h("span", null,
          h("b", { text: STATUS[key] }), h("span", { class: "sr-only", text: " " + mark }),
          info && state !== "next" ? h("small", { text: when(info.at) }) : null,
          state !== "next" ? h("small", { class: "msg", text: MSG[key] }) : null,
          info && info.note && state !== "next" ? h("small", { class: "cnote", text: info.note }) : null));
    };
    const items = [];
    FLOW.forEach((key, i) => {
      if (exc && exc !== "ON_HOLD" && i > pos) return;                  // ملغي / متعذّر: لا نعرض مراحل لن تحدث
      items.push(stage(key, i < pos || (i === pos && exc) ? "done" : i === pos ? "current" : "next"));
      if (exc && i === pos) items.push(stage(exc, "exc"));
    });
    return h("ol", { class: "otl" }, items);
  }

  /* الرابط الآمن: الرمز بعد علامة # فلا يصل لأي خادم، ويُزال من شريط العنوان فوراً (lang.js) قبل أي أداة قياس */
  function captureLinkToken(){
    const m = location.hash.match(/^#\/order\/([A-Za-z0-9-]{6,24})\?k=([A-Za-z0-9_-]{20,64})$/);
    if (m){ rememberOrder(m[1], m[2]); history.replaceState(null, "", location.pathname + location.search + "#/order/" + m[1]); }
    try {
      const s = JSON.parse(sessionStorage.getItem("cg-link") || "null");
      if (s && s.n && s.t){ rememberOrder(s.n, s.t); sessionStorage.removeItem("cg-link"); }
    } catch (_) {}
  }
  const secureLink = (n, token) => `${location.origin}${location.pathname}#/order/${n}?k=${token}`;

  function renderOrder(container, o, { created, full }){
    container.textContent = "";
    const waMsg = t("مرحباً، لدي استفسار بخصوص طلبي رقم {n}.", { n: o.orderNumber });
    const copyBtn = h("button", { type: "button", class: "copy-btn", "aria-label": t("نسخ رقم الطلب"), html: ICON.copy });
    copyBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(o.orderNumber); copyBtn.classList.add("ok"); copyBtn.setAttribute("aria-label", t("تم النسخ")); setTimeout(() => copyBtn.classList.remove("ok"), 1500); } catch (_) {}
    });
    const items = o.items.map(i => h("li", null,
      h("span", null, h("b", { text: "CalmGastro · " + (EN ? i.nameEn : i.name) }), h("small", { text: t("الكمية: {q}", { q: i.quantity }) + " · " + money(i.unitPrice) })),
      h("b", { class: "num-sum", text: money(i.lineTotal) })));
    const d = o.delivery;
    const special = ["CANCELLED", "FAILED", "ON_HOLD"].includes(o.status);
    const saved = full ? savedOrders().find(x => x.n === o.orderNumber) : null;
    let linkBox = null;
    if (saved && saved.t){
      const link = secureLink(o.orderNumber, saved.t);
      const input = h("input", { class: "link-input num", value: link, readonly: true, "aria-label": t("رابط طلبك الآمن") });
      input.addEventListener("focus", () => input.select());
      const copy = h("button", { type: "button", class: "btn btn-ghost", text: t("نسخ الرابط") });
      copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(link); copy.textContent = t("تم النسخ"); setTimeout(() => { copy.textContent = t("نسخ الرابط"); }, 1500); } catch (_) { input.select(); } });
      linkBox = h("section", { class: "obox" }, h("h2", { text: t("رابط طلبك الآمن") }),
        h("p", { class: "link-help", text: t("احفظ هذا الرابط لفتح طلبك في أي وقت ومن أي جهاز دون إدخال رقم الجوال. لا تشاركه مع أحد.") }),
        h("div", { class: "link-row" }, input, copy));
    }
    put(container,
      created ? h("div", { class: "ok-head" },
        h("span", { class: "ok-icon", html: ICON.check }),
        h("h1", { id: "orderTitle", text: t("تم استلام طلبك بنجاح") }),
        h("p", { text: t("شكراً لك، تم تسجيل طلبك بنجاح. سنتواصل معك لتأكيد موعد التوصيل.") }))
      : h("div", { class: "ok-head plain" }, h("h1", { id: "orderTitle", text: full ? t("تفاصيل طلبك") : t("حالة طلبك") })),
      h("div", { class: "onum" }, h("span", { text: t("رقم الطلب") }), h("div", null, h("b", { class: "num", text: o.orderNumber }), copyBtn),
        h("small", { text: t("احتفظ بهذا الرقم لمتابعة طلبك أو عند التواصل معنا.") })),
      h("section", { class: "obox" }, h("h2", { text: t("حالة الطلب") }),
        h("p", { class: "ostatus" }, h("span", { class: "st st-" + o.status, text: STATUS[o.status] || o.status }), h("small", { text: t("آخر تحديث: {d}", { d: when(o.updatedAt) }) })),
        special ? h("p", { class: "ospecial", text: MSG[o.status] + " " + t("للاستفسار تواصل معنا عبر واتساب.") }) : null,
        timeline(o)),
      linkBox,
      h("section", { class: "obox" }, h("h2", { text: t("ملخص الطلب") }), h("ul", { class: "sum-lines" }, items), totalsRows(o)),
      h("section", { class: "obox" }, h("h2", { text: t("بيانات التوصيل") }),
        h("dl", { class: "kv" },
          h("dt", { text: t("الاسم") }), h("dd", { text: d.name }),
          d.phone ? [h("dt", { text: t("الجوال") }), h("dd", { class: "num", text: d.phone })] : null,
          h("dt", { text: t("المدينة") }), h("dd", { text: d.city }),
          h("dt", { text: t("الحي") }), h("dd", { text: d.district }),
          d.address ? [h("dt", { text: t("العنوان") }), h("dd", { text: d.address })] : null,
          d.notes ? [h("dt", { text: t("ملاحظات") }), h("dd", { text: d.notes })] : null)),
      h("div", { class: "ogrid" },
        h("section", { class: "obox" }, h("h2", { text: t("طريقة الدفع") }), h("p", { text: (PAYMENTS.find(p => p.id === o.paymentMethod) || PAYMENTS[0]).label }), h("small", { text: (PAYMENTS.find(p => p.id === o.paymentMethod) || PAYMENTS[0]).note || "" })),
        h("section", { class: "obox" }, h("h2", { text: t("التوصيل المتوقع") }), h("p", { text: t("{d} عمل", { d: CONFIG.deliveryShort }) }), h("small", { text: t("تاريخ الطلب: {d}", { d: when(o.createdAt) }) }))),
      h("div", { class: "oactions" },
        h("a", { class: "btn btn-wa", href: waLink(waMsg), target: "_blank", rel: "noopener", onclick: () => track("whatsapp_click", { context: "order" }) }, h("span", { html: ICON.wa }), t("تواصل معنا عبر واتساب")),
        h("a", { class: "btn btn-ghost", href: "#/track/" + o.orderNumber, text: t("تتبع الطلب") }),
        h("a", { class: "link-btn", href: "#top", text: t("العودة للرئيسية") })));
  }

  async function api(path, body){
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(API + path, { method: "POST", headers: JSON_AS_TEXT, body: JSON.stringify(body), signal: ctrl.signal });
      return { status: r.status, data: await r.json().catch(() => null) };
    } catch (_) { return { status: 0, data: null }; }
    finally { clearTimeout(timer); }
  }

  async function openOrderPage(number){
    const box = $("#orderBody");
    captureLinkToken();
    if (justCreated && justCreated.orderNumber === number){
      renderOrder(box, justCreated, { created: true, full: true });
      setSteps("done"); justCreated = null;
      return;
    }
    const saved = savedOrders().find(o => o.n === number);
    if (!saved){ location.replace("#/track/" + number); return; }   // ليس على هذا الجهاز: التحقق برقم الجوال
    box.textContent = ""; box.append(h("p", { class: "loading-msg", text: t("جارٍ تحميل الطلب…") }));
    const r = await api("/api/orders/view", { orderNumber: number, token: saved.t });
    if (r.status === 200 && r.data && r.data.order){ renderOrder(box, r.data.order, { created: false, full: true }); track("order_viewed", {}); return; }
    box.textContent = "";
    box.append(h("div", { class: "obox center" },
      h("h1", { id: "orderTitle", text: t("تعذر تحميل الطلب") }),
      h("p", { text: r.status === 404 ? t("لم نجد هذا الطلب. يمكنك تتبعه برقم الطلب ورقم الجوال.") : t("تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى.") }),
      h("div", { class: "oactions" },
        h("button", { type: "button", class: "btn btn-primary", text: t("حاول مرة أخرى"), onclick: () => openOrderPage(number) }),
        h("a", { class: "btn btn-ghost", href: "#/track/" + number, text: t("تتبع الطلب") }))));
  }

  /* ---------- تتبع الطلب ---------- */
  const tForm = $("#trackForm"), tResult = $("#trackResult"), tErr = $("#trackErr");
  function openTrackPage(number){
    tResult.textContent = ""; tErr.textContent = "";
    tForm.hidden = false;
    if (number) tForm.elements.orderNumber.value = number;
    const list = $("#savedOrders"), mine = savedOrders();
    list.textContent = "";
    if (mine.length) list.append(h("p", { class: "saved-title", text: t("طلباتك المحفوظة على هذا الجهاز:") }),
      h("ul", { class: "saved-list" }, mine.map(o => h("li", null, h("a", { href: "#/order/" + o.n, class: "num", text: o.n })))));
    track("track_viewed", {});
  }
  // استرجاع رقم الطلب عبر الدعم: رسالة عامة بدون أي بيانات شخصية؛ فريق الدعم يتحقق من الهوية يدوياً
  $$(".js-wa-recover").forEach(a => { a.href = waLink(t("مرحباً، أحتاج المساعدة في استرجاع رقم طلبي.")); a.target = "_blank"; a.rel = "noopener"; a.addEventListener("click", () => track("whatsapp_click", { context: "recover_order" })); });
  tForm.addEventListener("submit", async e => {
    e.preventDefault();
    tErr.textContent = "";
    const num = tForm.elements.orderNumber.value.trim(), phone = normPhone(tForm.elements.phone.value);
    if (!/^[A-Za-z]{2,4}-?\d{4}-?\d{1,6}$/.test(toLatin(num).replace(/\s/g, ""))){ tErr.textContent = t("اكتب رقم الطلب كما وصلك، مثل CG-2026-000123"); tForm.elements.orderNumber.focus(); return; }
    if (!phone){ tErr.textContent = t("يرجى إدخال رقم جوال سعودي صحيح"); tForm.elements.phone.focus(); return; }
    const btn = $("#trackBtn"); btn.disabled = true; btn.textContent = t("جارٍ البحث…");
    const r = await api("/api/orders/track", { orderNumber: num, phone });
    btn.disabled = false; btn.textContent = t("تتبع الطلب");
    if (r.status === 200 && r.data && r.data.order){
      tResult.textContent = "";
      renderOrder(tResult, r.data.order, { created: false, full: false });
      tResult.scrollIntoView({ behavior: "auto", block: "start" });
      return;
    }
    tErr.textContent = r.status === 404 ? t("لم نجد طلباً بهذه البيانات. تأكد من رقم الطلب ورقم الجوال المستخدم في الطلب.")
      : r.status === 429 ? t("محاولات كثيرة. انتظر دقيقة ثم حاول مرة أخرى.") : t("تعذر الاتصال الآن. تحقق من الإنترنت ثم حاول مرة أخرى.");
  });

  /* ---------- البداية ---------- */
  // في الجوال: ملخص الطلب مطوي أعلى صفحة الإتمام (الإجمالي ظاهر في عنوانه) حتى يظهر النموذج مباشرة
  if (matchMedia("(max-width: 860px)").matches) $(".sum-box").open = false;
  renderAll();
  if ("IntersectionObserver" in window){
    const seen = new IntersectionObserver(([en]) => { if (en.isIntersecting){ track("view_offers", { items: CONFIG.bundles.map(b => b.id) }); seen.disconnect(); } }, { threshold: .3 });
    seen.observe($("#order"));
  }
  if (location.hash.startsWith("#/")) onRoute();
  window.CG_SHOP = { openDrawer, quote, priceForBoxes, normPhone };   // للاختبارات وللمساعد
})();

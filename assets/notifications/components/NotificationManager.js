/* ============================================================
   NotificationManager: يختار الإشعار التالي ومتى يظهر، ويرسله إلى CustomerNotificationPopup
   - يقرأ البيانات من data/*.js والإعدادات من config/notificationConfig.js (لا بيانات هنا)
   - يستبعد الأقسام المغلقة أو الفارغة، ويوزّع الباقي حسب config.weights بمجموعات مخلوطة (لا Math.random مباشرة)
   - لا يكرر الإشعار نفسه أو العميل نفسه متتالياً، ويتجنب المدينة نفسها والقسم نفسه متتالياً قدر الإمكان
   - الحد الأقصى في الجلسة وسجل آخر الإشعارات في sessionStorage
   ============================================================ */
(function(){
  const NS = window.CalmGastroNotify = window.CalmGastroNotify || {};
  const cfg = NS.config, Popup = NS.CustomerNotificationPopup;
  if (!cfg || !cfg.enabled || !Popup) return;
  const LANG = window.CG_LANG === "en" && window.I18N_EN ? "en" : "ar";
  const KEY = "calmgastro_notification_count", HKEY = "calmgastro_notification_recent";

  /* ---------- الجلسة ---------- */
  const store = {
    get(k, d){ try { const v = sessionStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v){ try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  };
  let count = +store.get(KEY, 0) || 0;
  let recent = store.get(HKEY, []);                       // [{ id, type, name, city }] الأحدث آخراً
  if (!Array.isArray(recent)) recent = [];

  /* ---------- البيانات ---------- */
  const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
  const between = (a, b) => Math.round(a + rnd() * (b - a));
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--){ const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const local = n => {
    if (LANG !== "en") return n;
    if (n.text_en == null) return null;                    // بدون ترجمة لا يظهر في الموقع الإنجليزي
    return Object.assign({}, n, { name: n.name_en != null ? n.name_en : n.name, city: n.city_en != null ? n.city_en : n.city, text: n.text_en });
  };
  function stockState(){
    try { const s = JSON.parse(document.getElementById("product-data").textContent).store || {};
      return { inStock: s.inStock !== false, count: typeof s.stockCount === "number" ? s.stockCount : null }; }
    catch (_) { return { inStock: true, count: null }; }
  }
  // القالب يظهر فقط إذا تحقق شرطه من بيانات المخزون الحقيقية (العدد مطلوب لقوالب min/max)
  function stockMatches(n, st){
    if (n.when === "inStock") return st.inStock && st.count !== 0;
    if (n.when === "outOfStock") return !st.inStock || st.count === 0;
    if (n.min != null || n.max != null) return st.inStock && st.count != null && st.count >= (n.min != null ? n.min : -Infinity) && st.count <= (n.max != null ? n.max : Infinity);
    return false;
  }
  const st = stockState();
  const pools = {
    testimonial: cfg.showTestimonials ? (NS.testimonials || []) : [],
    stock: cfg.showStockNotifications ? (NS.stockNotifications || []).filter(n => stockMatches(n, st)) : [],
    purchase: cfg.showPurchaseNotifications ? (NS.purchaseNotifications || []) : []
  };
  Object.keys(pools).forEach(k => pools[k] = pools[k].filter(n => n && !n.hold).map(local).filter(n => n && n.text && n.id != null).map(n => Object.assign({ type: k }, n)));
  const types = Object.keys(pools).filter(k => pools[k].length && (cfg.weights || {})[k] > 0);
  const total = types.reduce((s, k) => s + pools[k].length, 0);
  if (!total) return;

  /* ---------- الاختيار ---------- */
  let typeDeck = [], itemDecks = {};
  function refillTypes(){
    const w = cfg.weights, sum = types.reduce((s, k) => s + w[k], 0);
    const deck = []; types.forEach(k => { for (let i = Math.max(1, Math.round(10 * w[k] / sum)); i > 0; i--) deck.push(k); });
    typeDeck = shuffle(deck);
  }
  function nextType(last){
    if (!typeDeck.length) refillTypes();
    let i = typeDeck.findIndex(k => k !== last);            // يتجنب القسم نفسه متتالياً إن أمكن
    if (i < 0) i = 0;
    return typeDeck.splice(i, 1)[0];
  }
  function pickFrom(type, relaxed){
    const last = recent[recent.length - 1] || {};
    const window_ = Math.min(cfg.recentHistory || 6, total - 1);
    const blocked = new Set(recent.slice(-window_).map(r => r.type + ":" + r.id));
    const rules = [
      n => !blocked.has(type + ":" + n.id) && !(n.name && n.name === last.name) && !(n.city && n.city === last.city),
      n => !blocked.has(type + ":" + n.id) && !(n.name && n.name === last.name),
      n => !(type === last.type && n.id === last.id) && !(n.name && n.name === last.name)   // لا تكرار متتالٍ أبداً
    ];
    for (const ok of relaxed ? rules.slice(2) : rules.slice(0, 2)){
      if (!itemDecks[type] || !itemDecks[type].length) itemDecks[type] = shuffle(pools[type].slice());
      let i = itemDecks[type].findIndex(ok);
      if (i < 0){ itemDecks[type] = shuffle(pools[type].slice()); i = itemDecks[type].findIndex(ok); }
      if (i >= 0) return itemDecks[type].splice(i, 1)[0];
    }
    return null;
  }
  function next(){
    const last = recent[recent.length - 1] || {};
    // أولاً: إشعار لم يظهر مؤخراً (من القسم التالي في المجموعة، ثم بقية الأقسام)، وإلا فأي إشعار غير متتالٍ
    const first = nextType(last.type), order = [first, ...shuffle(types.filter(k => k !== first))];
    for (const relaxed of [false, true]) for (const k of order){ const n = pickFrom(k, relaxed); if (n) return n; }
    return null;
  }

  /* ---------- التوقيت ---------- */
  let timer = 0;
  const later = ms => { clearTimeout(timer); timer = setTimeout(run, ms); };
  const busy = () => document.visibilityState !== "visible"
    || (cfg.pauseWhen || []).some(sel => { try { return !!document.querySelector(sel); } catch (_) { return false; } })
    || /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "");
  async function run(){
    if (count >= cfg.maxPerSession) return;
    if (busy()){ later(4000); return; }                     // يؤجَّل ولا يُحسب
    const n = next();
    if (!n) return;
    const shown = Popup.show(n, between(cfg.displayDurationMin, cfg.displayDurationMax));
    const result = await shown;
    if (result === "noroom"){ later(4000); return; }        // لا مساحة الآن (مثلاً لوحة المفاتيح مفتوحة)
    count++; store.set(KEY, count);
    recent.push({ id: n.id, type: n.type, name: n.name || "", city: n.city || "" });
    recent = recent.slice(-12); store.set(HKEY, recent);
    if (count >= cfg.maxPerSession) return;
    const gap = between(cfg.nextDelayMin, cfg.nextDelayMax);
    later(result === "closed" ? Math.max(cfg.afterCloseDelay || 30000, gap) : gap);
  }
  if (count < cfg.maxPerSession) later(between(cfg.initialDelayMin, cfg.initialDelayMax));

  NS.NotificationManager = { next, get count(){ return count; }, pools };
})();

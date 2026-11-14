/* ============================================================
   صفحة الإعلانات (offer/): باقة واحدة + الاسم والجوال ← «اطلب» ← يُسجَّل الطلب في نفس خادم الطلبات ولوحة التحكم
   - الأسعار تُقرأ من الصفحة الرئيسية (product-data) فلا يوجد مصدر ثانٍ للأسعار؛ الخادم يعيد حسابها ولا يثق بالمتصفح
   - الطلب يُرسل بـ channel: "ad_page": الخادم يقبله بلا مدينة/حي/عنوان، ويظهر في لوحة التحكم بوسم «صفحة الإعلانات»؛
     الفريق يتصل بالعميل ويكمل العنوان من صفحة الطلب (لا يدخل شحنة سينا قبل ذلك)
   - نفس سلوك الصفحة الرئيسية: مفتاح طلب واحد لكل محاولة (لا يتكرر الطلب)، العنوان الاحتياطي، سؤال الطلب السابق، أحداث البكسل
   ============================================================ */
(function(){
  // نفس عناوين خادم الطلبات في app.js (اختبارات e2e تستبدل هذا السطر بعناوين محلية)
  const CONFIG = { ordersApi: { endpoints: ["https://api.vitamik.com", "https://calmgastro-orders.calmgastro.workers.dev"] } };
  const APIS = CONFIG.ordersApi.endpoints.map(u => u.replace(/\/$/, ""));
  // أسماء الباقات في هذه الصفحة (حسب عدد العلب)؛ السعر والمعرّف من product-data
  const NAMES = { 1: ["باقة التجربة", "عبوة واحدة"], 2: ["باقة الاستمرارية", "عبوتان"], 3: ["باقة الأكثر طلباً", "3 عبوات"] };
  const ORDERS_KEY = "cg-orders";
  const JSON_AS_TEXT = { "Content-Type": "text/plain;charset=UTF-8" };   // طلب «بسيط» بلا CORS preflight، كما في shop.js

  const $ = s => document.querySelector(s);
  const form = $("#adForm"), pkgBox = $("#pkgs"), pkgList = $("#pkgList"), btn = $("#orderBtn"), errBox = $("#errBox"), repeatBox = $("#repeatBox");
  let store = null, apiAt = 0, attempt = null, placing = false;

  const fmt = n => Number(n).toLocaleString("en-US");
  const money = n => `${fmt(n)} ر.س`;
  const el = (tag, props, ...kids) => { const e = Object.assign(document.createElement(tag), props || {}); e.append(...kids); return e; };
  const toLatin = v => String(v).replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0);
  function normPhone(v){
    let d = toLatin(v).replace(/[\s\-().]/g, "");
    if (!/^\+?\d+$/.test(d)) return null;
    d = d.replace(/^\+/, "").replace(/^00/, "");
    if (d.startsWith("966")) d = d.slice(3);
    if (d.startsWith("0")) d = d.slice(1);
    return /^5\d{8}$/.test(d) ? "0" + d : null;
  }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("")).replace(/-/g, "");
  const waLink = msg => `https://wa.me/${(store && store.whatsapp) || "966539946402"}?text=${encodeURIComponent(msg)}`;

  async function postApi(path, body, ms){
    let err;
    for (let i = 0; i < APIS.length; i++){
      const at = (apiAt + i) % APIS.length;
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), ms);
      try {
        const res = await fetch(APIS[at] + path, { method: "POST", headers: JSON_AS_TEXT, body: JSON.stringify(body), signal: ctrl.signal });
        apiAt = at;
        return res;
      } catch (e) { err = e; }
      finally { clearTimeout(timer); }
    }
    throw err;
  }

  /* ---------- قياس الإعلانات: حدث الشراء فقط، بدون أي بيانات شخصية (نفس أسماء الأحداث في shop.js) ---------- */
  function trackPurchase(o){
    const items = (o.items || []).map(i => i.productId);
    try { if (typeof window.fbq === "function") fbq("track", "Purchase", { value: o.total, currency: "SAR", content_ids: items, content_type: "product", num_items: o.boxes }, { eventID: o.orderNumber }); } catch (_) {}
    try { if (window.ttq && typeof ttq.track === "function") ttq.track("CompletePayment", { value: o.total, currency: "SAR", content_type: "product", contents: items.map(id => ({ content_id: id, content_type: "product" })) }, { event_id: o.orderNumber }); } catch (_) {}
    try { if (typeof window.snaptr === "function") snaptr("track", "PURCHASE", { price: o.total, currency: "SAR", item_ids: items, number_items: o.boxes, transaction_id: o.orderNumber }); } catch (_) {}
  }

  /* ---------- الباقات من product-data في الصفحة الرئيسية ---------- */
  const shippingFor = price => { const s = (store && store.shipping) || {}; return s.freeFrom && price >= s.freeFrom ? 0 : (s.cost || 0); };
  const chosen = () => { const r = form.querySelector('input[name="pkg"]:checked'); return r && store ? store.bundles.find(b => b.id === r.value) : null; };
  const pkgName = b => (NAMES[b.boxes] || [b.title])[0];

  function renderPackages(){
    pkgList.textContent = "";
    store.bundles.forEach(b => {
      const [title, sub] = NAMES[b.boxes] || [b.title, b.program || ""];
      const input = el("input", { type: "radio", name: "pkg", value: b.id });
      const price = el("span", { className: "price" }, el("b", { textContent: money(b.price) }));
      if (b.was && b.was > b.price){ const s = el("s", { textContent: money(b.was) }); s.setAttribute("aria-label", "بدلاً من " + money(b.was)); price.append(s); }
      const label = el("label", { className: "pkg" }, input, el("span", { className: "dot" }), el("span", { className: "txt" }, el("b", { textContent: title }), el("small", { textContent: sub })), price);
      input.addEventListener("change", () => { check("pkg"); refresh(); });
      pkgList.append(label);
    });
  }
  async function loadStore(){
    try {
      const r = await fetch("/", { cache: "no-cache" });
      const m = (await r.text()).match(/<script type="application\/json" id="product-data">([\s\S]*?)<\/script>/);
      const s = JSON.parse(m[1]).store;
      if (!Array.isArray(s.bundles) || !s.bundles.length) throw new Error("no bundles");
      store = s;
    } catch (e) {
      $("#e-pkg").textContent = "تعذّر تحميل الباقات. حدّث الصفحة، أو اطلب عبر واتساب.";
      return;
    }
    if (store.deliveryShort) $("#eta").textContent = store.deliveryShort;
    renderPackages(); refresh();
  }

  /* ---------- التحقق: نفس قواعد الخادم ---------- */
  const rules = {
    pkg:   () => !!chosen() || "اختر الباقة",
    name:  v => (v.trim().length >= 2 && /\p{L}/u.test(v)) || "يرجى كتابة الاسم",
    phone: v => !!normPhone(v) || "يرجى إدخال رقم جوال سعودي صحيح، مثل 05XXXXXXXX"
  };
  const valueOf = n => n === "pkg" ? "" : form.elements[n].value;
  const passes = n => rules[n](valueOf(n)) === true;
  function check(n){
    const res = rules[n](valueOf(n)), ok = res === true;
    (n === "pkg" ? pkgBox : form.elements[n]).setAttribute("aria-invalid", ok ? "false" : "true");
    $("#e-" + n).textContent = ok ? "" : res;
    return ok;
  }
  function setError(n, msg){ const e = form.elements[n]; if (!e) return; e.setAttribute("aria-invalid", "true"); $("#e-" + n).textContent = msg; }
  // «اطلب» يتلوّن ويُكتب عليه الإجمالي عندما تكتمل البيانات؛ الضغط قبلها يوضح الناقص
  function refresh(){
    const b = chosen(), ready = Object.keys(rules).every(passes), total = b ? b.price + shippingFor(b.price) : null;
    $("#totalVal").textContent = b ? money(total) : "—";
    btn.classList.toggle("ready", ready);
    if (!placing) btn.textContent = ready && b ? `اطلب — ${money(total)}` : "اطلب";
    $("#readyNote").hidden = ready;
  }
  ["name", "phone"].forEach(n => {
    const e = form.elements[n];
    e.addEventListener("input", () => { if (e.getAttribute("aria-invalid") === "true") check(n); refresh(); });
    e.addEventListener("blur", () => e.value && check(n));
  });
  form.elements.phone.addEventListener("blur", () => { const p = normPhone(form.elements.phone.value); if (p) form.elements.phone.value = p; });

  /* ---------- إرسال الطلب ---------- */
  form.addEventListener("submit", ev => { ev.preventDefault(); placeOrder(); });
  $("#retryBtn").addEventListener("click", placeOrder);

  async function placeOrder(){
    if (placing) return;
    if (!store){ showError("تعذّر تحميل الباقات. حدّث الصفحة ثم حاول مرة أخرى."); return; }
    const bad = Object.keys(rules).filter(n => !check(n));
    if (bad.length){ const first = bad[0] === "pkg" ? pkgList.querySelector("input") : form.elements[bad[0]]; if (first) first.focus(); return; }
    const b = chosen();
    // المدينة والحي والعنوان يكملها الفريق بعد الاتصال بالعميل
    const customer = { name: form.elements.name.value.trim(), phone: normPhone(form.elements.phone.value), city: "", district: "", address: "", notes: "" };
    const payload = { items: [{ id: b.id, qty: 1 }], customer, location: null, paymentMethod: "cod", lang: "ar", channel: "ad_page" };
    const sig = JSON.stringify(payload);
    // نفس المحاولة (إعادة أو ضغطتين) = نفس المفتاح، فلا يتكرر الطلب
    if (!attempt || attempt.sig !== sig) attempt = { sig, key: uuid(), expectedTotal: b.price + shippingFor(b.price) };
    placing = true; btn.disabled = true; btn.textContent = "جاري تسجيل الطلب...";
    errBox.hidden = true; repeatBox.hidden = true;
    let res = null, data = null, failure = "NET";
    try {
      res = await postApi("/api/orders", { ...payload, idempotencyKey: attempt.key, expectedTotal: attempt.expectedTotal, hp: $("#f-hp").value, ...(attempt.confirmNew ? { confirmNewOrder: true } : {}) }, 15000);
      data = await res.json().catch(() => null);
    } catch (e) { res = null; failure = e && e.name === "AbortError" ? "TIMEOUT" : navigator.onLine === false ? "OFFLINE" : "NET"; }
    placing = false; btn.disabled = false; refresh();

    if (res && (res.status === 201 || res.status === 200) && data && data.order && data.order.orderNumber){
      const o = data.order;
      trackPurchase(o);
      // نفس حفظ الصفحة الرئيسية (رقم الطلب ورمز الوصول فقط): لو فتح العميل الموقع لاحقاً يجد طلبه في «تتبع الطلب»
      try { const a = JSON.parse(localStorage.getItem(ORDERS_KEY) || "[]"); localStorage.setItem(ORDERS_KEY, JSON.stringify([{ n: o.orderNumber, t: data.token }, ...(Array.isArray(a) ? a : []).filter(x => x.n !== o.orderNumber)].slice(0, 10))); } catch (_) {}
      $("#doneNumber").textContent = o.orderNumber;
      $("#donePkg").textContent = pkgName(b);
      $("#doneTotal").textContent = money(o.total);
      $("#orderView").hidden = true; $("#doneView").hidden = false;
      attempt = null;
      $("#doneView").focus();
      $("#doneView").scrollIntoView({ block: "center" });
      return;
    }
    if (res && res.status === 409 && data && data.error === "open_order_exists"){
      $("#repeatTitle").textContent = (data.count || 1) > 1 ? `عزيزي العميل، لديك ${data.count} طلبات سابقة لم يتم توصيلها بعد.` : "عزيزي العميل، لديك طلب سابق لم يتم توصيله بعد.";
      $("#repeatAsk").hidden = false; $("#repeatDone").hidden = true; repeatBox.hidden = false; btn.hidden = true;
      repeatBox.focus();
      return;
    }
    if (res && res.status === 409 && data && data.error === "price_changed" && data.quote){
      attempt = null;
      showError(`تغيّر السعر منذ فتحك للصفحة. الإجمالي الجديد ${money(data.quote.total)}. حدّث الصفحة ثم اطلب مرة أخرى.`);
      return;
    }
    if (res && res.status === 422 && data && data.fields){
      const f = data.fields, msgs = { name: "يرجى كتابة الاسم", phone: "يرجى إدخال رقم جوال سعودي صحيح، مثل 05XXXXXXXX" };
      const hit = Object.keys(msgs).filter(k => f[k]);
      if (hit.length){ hit.forEach(k => setError(k, msgs[k])); form.elements[hit[0]].focus(); return; }
    }
    if (res && res.status === 409 && data && data.error === "out_of_stock"){ showError("المنتج غير متوفر حالياً. لم يتم تسجيل الطلب."); return; }
    if (res && res.status === 429){ showError("محاولات كثيرة خلال وقت قصير. انتظر دقيقة ثم اضغط «حاول مرة أخرى». لم يتم تسجيل الطلب."); return; }
    if (!res){ showError("تعذّر الاتصال بخادم الطلبات من شبكتك الحالية، ولم يتم تسجيل الطلب. أوقف الواي فاي وجرّب ببيانات الجوال، أو أرسل طلبك عبر واتساب.", failure); return; }
    showError("حدث خطأ أثناء تسجيل الطلب. لم يتم تسجيل الطلب.", "S" + res.status + (data && data.error ? "-" + data.error : ""));
  }

  $("#repeatNew").addEventListener("click", () => { if (attempt) attempt.confirmNew = true; btn.hidden = false; repeatBox.hidden = true; placeOrder(); });
  $("#repeatKeep").addEventListener("click", () => { $("#repeatAsk").hidden = true; $("#repeatDone").hidden = false; btn.hidden = false; });

  function showError(msg, code){
    $("#errText").textContent = msg;
    $("#errCode").textContent = code ? `رمز المشكلة: ${code}` : "";
    const b = chosen();
    $("#errWa").href = waLink(`مرحباً، واجهت مشكلة في الطلب من صفحة الطلب وأرغب في طلب: ${b ? pkgName(b) + " (" + money(b.price) + ")" : "كالم كاسترو"}`);
    errBox.hidden = false; errBox.focus();
  }

  loadStore();
})();

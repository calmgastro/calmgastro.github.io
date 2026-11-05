/* Snap Pixel (حساب Snapchat الإعلاني): يسجل زيارة الصفحة. أحداث الطلب تُرسل من app.js عبر window.snaptr
   النطاقات المستخدمة مسموحة في سياسة الأمان (CSP) داخل index.html: sc-static.net و tr.snapchat.com */
(function (e, t, n) {
  // يعمل على الموقع الحقيقي فقط، حتى لا تصل زيارات المعاينة والاختبارات المحلية لحساب الإعلانات
  if (e.snaptr || !/^(www\.)?vitamik\.com$/.test(location.hostname)) return;
  var a = e.snaptr = function () { a.handleRequest ? a.handleRequest.apply(a, arguments) : a.queue.push(arguments); };
  a.queue = [];
  var s = "script", r = t.createElement(s);
  r.async = true;
  r.src = n;
  var u = t.getElementsByTagName(s)[0];
  u.parentNode.insertBefore(r, u);
})(window, document, "https://sc-static.net/scevent.min.js");

if (window.snaptr) {
  snaptr("init", "589cd51b-2b7a-4cb3-a73e-d2e7a321a5a5", {});
  snaptr("track", "PAGE_VIEW");
}

/* Meta Pixel (فيسبوك وانستقرام): يسجل زيارة الصفحة. أحداث الطلب تُرسل من shop.js عبر window.fbq
   النطاقات المستخدمة مسموحة في سياسة الأمان (CSP) داخل index.html: connect.facebook.net و www.facebook.com */
(function (w, d) {
  // يعمل على الموقع الحقيقي فقط، حتى لا تصل زيارات المعاينة والاختبارات المحلية لحساب الإعلانات
  if (w.fbq || !/^(www\.)?vitamik\.com$/.test(location.hostname)) return;
  var ID = "28877128168623335", KEY = /[?&]k=/;
  function start() {
    if (KEY.test(location.hash)) return;
    var n = w.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!w._fbq) w._fbq = n;
    n.push = n; n.loaded = true; n.version = "2.0"; n.queue = [];
    n.disablePushState = true;   // الأحداث المرسلة هي المحددة هنا وفي shop.js فقط، وليس كل انتقال داخل الصفحة
    var t = d.createElement("script"), s = d.getElementsByTagName("script")[0];
    t.async = true;
    t.src = "https://connect.facebook.net/en_US/fbevents.js";
    s.parentNode.insertBefore(t, s);
    fbq("set", "autoConfig", false, ID);   // لا يقرأ الأزرار والحقول تلقائياً
    fbq("init", ID);
    fbq("track", "PageView");
  }
  // رابط الطلب الآمن فيه مفتاح يفتح بيانات العميل: ننتظر حتى يحفظه shop.js ويمسحه من العنوان، فلا يصل لفيسبوك
  if (KEY.test(location.hash)) d.addEventListener("DOMContentLoaded", start); else start();
})(window, document);

/* TikTok Pixel: يسجل زيارة الصفحة. أحداث الطلب تُرسل من shop.js عبر window.ttq
   النطاق المستخدم مسموح في سياسة الأمان (CSP) داخل index.html: analytics.tiktok.com */
(function (w, d, t) {
  // يعمل على الموقع الحقيقي فقط، حتى لا تصل زيارات المعاينة والاختبارات المحلية لحساب الإعلانات
  if (w[t] || !/^(www\.)?vitamik\.com$/.test(location.hostname)) return;
  var KEY = /[?&]k=/;
  function start() {
    if (KEY.test(location.hash)) return;
    w.TiktokAnalyticsObject = t;
    var ttq = w[t] = w[t] || [];
    ttq.methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie", "holdConsent", "revokeConsent", "grantConsent"];
    ttq.setAndDefer = function (o, m) { o[m] = function () { o.push([m].concat(Array.prototype.slice.call(arguments, 0))); }; };
    for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
    ttq.instance = function (id) {
      for (var e = ttq._i[id] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]);
      return e;
    };
    ttq.load = function (e, n) {
      var r = "https://analytics.tiktok.com/i18n/pixel/events.js", o = n && n.partner;
      ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = r;
      ttq._t = ttq._t || {}; ttq._t[e] = +new Date;
      ttq._o = ttq._o || {}; ttq._o[e] = n || {};
      n = d.createElement("script");
      n.type = "text/javascript"; n.async = true; n.src = r + "?sdkid=" + e + "&lib=" + t;
      e = d.getElementsByTagName("script")[0];
      e.parentNode.insertBefore(n, e);
    };
    ttq.load("DBM7VURC77UENJ6BR4I0");
    ttq.page();
  }
  // نفس حماية مفتاح رابط الطلب الآمن في بكسل Meta أعلاه
  if (KEY.test(location.hash)) d.addEventListener("DOMContentLoaded", start); else start();
})(window, document, "ttq");

/* Snap Pixel (حساب Snapchat الإعلاني): يسجل زيارة الصفحة. أحداث الطلب تُرسل من app.js عبر window.snaptr
   النطاقات المستخدمة مسموحة في سياسة الأمان (CSP) داخل index.html: sc-static.net و tr.snapchat.com */
(function (e, t, n) {
  if (e.snaptr) return;
  var a = e.snaptr = function () { a.handleRequest ? a.handleRequest.apply(a, arguments) : a.queue.push(arguments); };
  a.queue = [];
  var s = "script", r = t.createElement(s);
  r.async = true;
  r.src = n;
  var u = t.getElementsByTagName(s)[0];
  u.parentNode.insertBefore(r, u);
})(window, document, "https://sc-static.net/scevent.min.js");

snaptr("init", "589cd51b-2b7a-4cb3-a73e-d2e7a321a5a5", {});
snaptr("track", "PAGE_VIEW");

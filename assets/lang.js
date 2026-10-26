/* يعمل أولاً قبل عرض الصفحة: (1) يمنع عرض الموقع داخل موقع آخر (2) يحدد لغة الصفحة */
if (window.top !== window.self) {
  document.documentElement.style.display = "none";      // لا يظهر شيء داخل موقع آخر في كل المتصفحات
  try { window.top.location.replace(window.location.href); } catch (e) {}
}
/* رابط الطلب الآمن (#/order/رقم?k=رمز): نحفظ الرمز لهذه الجلسة ونزيله من شريط العنوان فوراً،
   قبل تحميل أي أداة قياس (pixel.js)، فلا يظهر في سجل المتصفح ولا يُرسل مع عنوان الصفحة لأي طرف */
(function(){
  var m = location.hash.match(/^#\/order\/([A-Za-z0-9-]{6,24})\?k=([A-Za-z0-9_-]{20,64})$/);
  if (!m) return;
  try { sessionStorage.setItem("cg-link", JSON.stringify({ n: m[1], t: m[2] })); } catch (e) {}
  try { history.replaceState(null, "", location.pathname + location.search + "#/order/" + m[1]); } catch (e) {}
})();
/* لغة الصفحة: ?lang= أولاً، ثم اختيار الزائر المحفوظ (زر اللغة)، وإلا فالعربية هي الافتراضية لكل الزوار */
(function(){
  var l = null, h = document.documentElement;
  try {
    var q = new URLSearchParams(location.search).get("lang");
    if (q === "ar" || q === "en") { l = q; localStorage.setItem("cg-lang", q); } else { l = localStorage.getItem("cg-lang"); }
  } catch (e) {}
  if (l !== "ar" && l !== "en") l = "ar";
  window.CG_LANG = l; h.lang = l; h.dir = l === "ar" ? "rtl" : "ltr";
  // نخفي الصفحة لحظة حتى تُطبّق الترجمة فلا يظهر النص العربي ثم يتغير
  if (l === "en") { h.classList.add("i18n-wait"); setTimeout(function(){ h.classList.remove("i18n-wait"); }, 3000); }
})();

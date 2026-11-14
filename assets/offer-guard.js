/* صفحة الإعلانات (offer/): يعمل أولاً — يمنع عرض الصفحة داخل موقع آخر (نفس حماية lang.js في الصفحة الرئيسية).
   الصفحة عربية دائماً، فلا نستخدم lang.js هنا (قد يحوّلها للإنجليزية من اختيار سابق للزائر). */
if (window.top !== window.self) {
  document.documentElement.style.display = "none";
  try { window.top.location.replace(window.location.href); } catch (e) {}
}

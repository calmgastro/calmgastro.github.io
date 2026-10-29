/* ============================================================
   قوالب إشعارات المخزون
   يظهر القالب فقط إذا تحقق شرطه من بيانات المخزون الحقيقية:
   - when: "inStock"    → المنتج متوفر (product-data: store.inStock = true)
   - when: "outOfStock" → المنتج غير متوفر (store.inStock = false)
   - min / max          → يحتاج عدد العبوات الفعلي (product-data: store.stockCount). لا يوجد عدد حالياً،
                          فهذه القوالب جاهزة ولا تظهر حتى يُربط العدد الحقيقي. لا تكتب أرقاماً ثابتة داخل النص.
   ============================================================ */
window.CalmGastroNotify = window.CalmGastroNotify || {};
window.CalmGastroNotify.stockNotifications = [
  { id: 101, type: "stock", icon: "📦", when: "inStock", text: "كالم كاسترو متوفر حالياً", text_en: "CalmGastro is in stock now" },
  { id: 102, type: "stock", icon: "⚡", min: 10, max: 20, text: "الكمية المتوفرة محدودة حالياً", text_en: "Available quantity is limited right now" },
  { id: 103, type: "stock", icon: "🔥", min: 5, max: 9, text: "باقي عدد قليل من العبوات", text_en: "Only a few boxes left" },
  { id: 104, type: "stock", icon: "🚨", min: 1, max: 4, text: "الكمية المتبقية محدودة جداً", text_en: "Very limited quantity left" },
  { id: 105, type: "stock", icon: "📦", when: "outOfStock", text: "نفدت الكمية الحالية", text_en: "The current batch is sold out" }
];

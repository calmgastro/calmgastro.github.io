/* ============================================================
   تجارب العملاء للإشعارات العائمة
   - أضف تجربة جديدة بإضافة عنصر للقائمة فقط (لا حاجة لتعديل أي ملف آخر)
   - تجارب حقيقية وموافَق على نشرها فقط، وبنص العميل كما كتبه (بدون تعديل المعنى أو المبالغة)
   - city: اختياري، اتركه "" إذا لم تكن المدينة معروفة (لا تُخترع مدينة)
   - name_en / city_en / text_en: النسخة الإنجليزية؛ التجربة بدون text_en لا تظهر في الموقع الإنجليزي
   - id: رقم فريد لكل تجربة
   الحالي: آراء العملاء الأربعة المنشورة في قسم «من جرّبوه قبلك» بنصها.
   ============================================================ */
window.CalmGastroNotify = window.CalmGastroNotify || {};
window.CalmGastroNotify.testimonials = [
  { id: 1, type: "testimonial", icon: "💬", name: "سارة، 23 سنة", city: "", text: "من أول أسبوع لاحظت فرق في الشهية والانتفاخ.",
    name_en: "Sara, 23", text_en: "From the first week I noticed a difference in my appetite and bloating." },
  { id: 2, type: "testimonial", icon: "💬", name: "أحمد", city: "", text: "طعمه حلو وسهل الاستخدام.",
    name_en: "Ahmed", text_en: "It tastes good and it’s easy to use." },
  { id: 3, type: "testimonial", icon: "💬", name: "ليلى، 27 سنة", city: "", text: "أعاني من قولون عصبي، وما ارتحت إلا عليه.",
    name_en: "Layla, 27", text_en: "I suffer from IBS, and nothing gave me relief except this." },
  { id: 4, type: "testimonial", icon: "💬", name: "عميلة، 40 سنة", city: "", text: "منتج فعّال من جد.",
    name_en: "Customer, 40", text_en: "A really effective product." }
];

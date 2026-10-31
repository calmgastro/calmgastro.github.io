/* ============================================================
   تجارب العملاء للإشعارات العائمة
   - أضف تجربة جديدة بإضافة عنصر للقائمة فقط (لا حاجة لتعديل أي ملف آخر)
   - تجارب حقيقية وموافَق على نشرها فقط، وبنص العميل كما كتبه (بدون تعديل المعنى أو المبالغة)
   - city: اختياري، اتركه "" إذا لم تكن المدينة معروفة (لا تُخترع مدينة)
   - name_en / city_en / text_en: النسخة الإنجليزية؛ التجربة بدون text_en لا تظهر في الموقع الإنجليزي
   - hold: التجربة محفوظة ولا تُعرض (فيها كيلوغرامات محددة أو ادعاء صحي، وهيئة الغذاء والدواء لا تسمح بادعاءات
           إنقاص وزن أو علاجية للمكملات). احذف hold لتظهر
   - id: رقم فريد لكل تجربة
   1–4: آراء قسم «من جرّبوه قبلك» · 1001–1050: تجارب العملاء المرسلة 2026-10-31 (الرقم − 1000 = ترتيبها في القائمة)
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
    name_en: "Customer, 40", text_en: "A really effective product." },

  { id: 1001, type: "testimonial", icon: "⭐", name: "أم عبدالله", city: "الرياض", text: "الحمد لله، أول شهر نزلت 5 كيلو، ومبسوطة من النتيجة", hold: "weight-kg" },
  { id: 1002, type: "testimonial", icon: "💚", name: "أبو خالد", city: "جدة", text: "بصراحة من يوم جربته صرت أحس بطني أريح بعد الأكل، وفرق معي النفخة خفت" },
  { id: 1003, type: "testimonial", icon: "🌿", name: "أم مشاري", city: "الدمام", text: "لي أسبوعين أستخدمه، والغازات والانتفاخ اللي كانت تضايقني خفّت كثير ومستمرة عليه" },
  { id: 1004, type: "testimonial", icon: "⭐", name: "أبو أحمد", city: "مكة", text: "كنت متردد بالبداية، بس بعد شهر لاحظت الفرق صراحة يستاهل التجرية" },
  { id: 1005, type: "testimonial", icon: "💚", name: "نورة", city: "الخبر", text: "الحمد لله، نزلت ٥ كيلو خلال أول شهر واخذت عبوة ثانية", hold: "weight-kg" },
  { id: 1006, type: "testimonial", icon: "🌸", name: "أم فهد", city: "الطائف", text: "أكثر شيء عجبني إني صرت أحس بخفة بعد الوجبات القولون كان مرة مزعجني" },
  { id: 1007, type: "testimonial", icon: "✨", name: "أبو عبدالله", city: "المدينة", text: "بعد شهر ونص نزل وزني ٨ كيلو انصح فيه", hold: "weight-kg" },
  { id: 1008, type: "testimonial", icon: "🌿", name: "العنود", city: "الرياض", text: "الصراحة كان عندي،ثبات وزن بس بعد اسبوعين نكسر" },
  { id: 1009, type: "testimonial", icon: "⭐", name: "أم محمد", city: "جدة", text: "كنت أحس بجوع خصوصي بليل وشراهة الحين الحمدالله ماعاد اشتهي" },
  { id: 1010, type: "testimonial", icon: "💚", name: "أبو سعود", city: "الدمام", text: "كملت أول شهر، والحمد لله وزني بدأ ينزل ومستمر فيه ٣ شهور" },
  { id: 1011, type: "testimonial", icon: "🌸", name: "أم نواف", city: "القصيم", text: "كان عندي لخبطة بسكر الدم وعطول جوعانة الحين افضل .", hold: "medical" },
  { id: 1012, type: "testimonial", icon: "🌿", name: "أبو راشد", city: "الأحساء", text: "أكثر شيء فرق معي هو النفخة وتخلصت من الامساك مشكورين" },
  { id: 1013, type: "testimonial", icon: "⭐", name: "أم خالد", city: "أبها", text: "المنتج جباااار" },
  { id: 1014, type: "testimonial", icon: "💚", name: "أبو فهد", city: "تبوك", text: "استخدمت كثير بس صراحة استفدت عليه" },
  { id: 1015, type: "testimonial", icon: "✨", name: "ريم", city: "الرياض", text: "أول أسبوع ما لاحظت شيء ، لكن بعد اسبوعين شفت الفرق" },
  { id: 1016, type: "testimonial", icon: "🌸", name: "أم فيصل", city: "جدة", text: "بصراحة عجبني الباكج إنه سهل اخذه بالشنطة عالدوام والتزمت فيه" },
  { id: 1017, type: "testimonial", icon: "🌿", name: "سارة", city: "الخبر", text: "عندي مناسبة واخذت ٣ علب في نتيجة" },
  { id: 1018, type: "testimonial", icon: "⭐", name: "أم أحمد", city: "مكة", text: "الحمد لله، نزلت 4 كيلو خلال اسبوعين مع الالتزام بالمشي", hold: "weight-kg" },
  { id: 1019, type: "testimonial", icon: "💚", name: "نوال", city: "الدمام", text: "مشكورين عالمصداقية والرد عالواتساب" },
  { id: 1020, type: "testimonial", icon: "🌿", name: "أبو محمد", city: "الرياض", text: "الله يسعدكم تعاملكم جميل والمنتج عجبني" },
  { id: 1021, type: "testimonial", icon: "⭐", name: "أم تركي", city: "الطائف", text: "خلصت أول علبة، والحمد لله لاحظت فرق بوزني" },
  { id: 1022, type: "testimonial", icon: "💚", name: "شيماء", city: "جدة", text: "ممنونة من المنتج شكرا" },
  { id: 1023, type: "testimonial", icon: "🌸", name: "أم راكان", city: "المدينة", text: "الصراحة كنت متخوفة، بس تجربتي كانت مريحة بالنسبة لي" },
  { id: 1024, type: "testimonial", icon: "🌿", name: "أبو بدر", city: "حائل", text: "مع المشي وتقليل السكريات، نزلت 5 كيلو اول اسبوعين ومستمر", hold: "weight-kg" },
  { id: 1025, type: "testimonial", icon: "⭐", name: "هيا", city: "الرياض", text: "لي أسبوعين أستخدمه، وصديقاتي يسالون عن السر 🙈" },
  { id: 1026, type: "testimonial", icon: "💚", name: "أم سلطان", city: "الدمام", text: "الحمد لله، واخيرا جسمي،استفاد عشي" },
  { id: 1027, type: "testimonial", icon: "✨", name: "أبو فيصل", city: "الخبر", text: "يستاهل التجرية" },
  { id: 1028, type: "testimonial", icon: "🌸", name: "أم عبدالرحمن", city: "جدة", text: "كنت أعاني من انتفاخ مزعج، الحين افضل بكثير" },
  { id: 1029, type: "testimonial", icon: "🌿", name: "أبو تركي", city: "الرياض", text: "الحمد لله، نزلت ٥ كيلو أول شهر، وهذا شجعني أستمر", hold: "weight-kg" },
  { id: 1030, type: "testimonial", icon: "⭐", name: "أم سعود", city: "مكة", text: "أكثر شيء لاحظته إن بطني صار أريح بعد الوجبات ماصرت انزعج مثل قبل" },
  { id: 1031, type: "testimonial", icon: "💚", name: "مشاعل", city: "القصيم", text: "بصراحة تجربتي كانت حلوة، وحبيت طعمه طريقة استخدامه سهلة" },
  { id: 1032, type: "testimonial", icon: "🌿", name: "أبو ماجد", city: "أبها", text: "والله منتج زين" },
  { id: 1033, type: "testimonial", icon: "⭐", name: "أم ناصر", city: "جدة", text: "الغازات كانت تضايقني بعد الأكل، والحمد لله خفّت ووزني نزل" },
  { id: 1034, type: "testimonial", icon: "💚", name: "أبو إبراهيم", city: "الدمام", text: "أعطي تجربتي خمس نجوم، طريقة الاستخدام سهلة بالنسبة لي وطعمه حلو" },
  { id: 1035, type: "testimonial", icon: "🌸", name: "الجوهرة", city: "الرياض", text: "الله يسعدكم عالمصداقية" },
  { id: 1036, type: "testimonial", icon: "🌿", name: "أم بدر", city: "الطائف", text: "لي شهر ونص أستخدمه، وأحس بفرق وبكمل ال٣ علب" },
  { id: 1037, type: "testimonial", icon: "⭐", name: "أبو عبدالعزيز", city: "تبوك", text: "مع الالتزام بالأكل الصحي، لاحظت نزول 4 كيلو خلال شهر عجبني", hold: "weight-kg" },
  { id: 1038, type: "testimonial", icon: "💚", name: "أم يوسف", city: "الخبر", text: "الصراحة كنت أعاني من جوع بليل ، والحين ماعاد اتعشى" },
  { id: 1039, type: "testimonial", icon: "✨", name: "أبو عمر", city: "المدينة", text: "تجربتي كانت طيبة، وأهم شيء بالنسبة لي طعمه لذيذ" },
  { id: 1040, type: "testimonial", icon: "🌸", name: "أم راشد", city: "الرياض", text: "مابقي منتج الا وجربته هذا فاد جسمي حمدالله" },
  { id: 1041, type: "testimonial", icon: "🌿", name: "أبو سلمان", city: "جدة", text: "مشكورين عالتعامل الزين" },
  { id: 1042, type: "testimonial", icon: "⭐", name: "أم بندر", city: "الدمام", text: "نصحت فيه جماعتي يستاهل" },
  { id: 1043, type: "testimonial", icon: "💚", name: "أبو ياسر", city: "مكة", text: "عجبني وفيه نتيجة منه" },
  { id: 1044, type: "testimonial", icon: "🌸", name: "أم عبدالعزيز", city: "القصيم", text: "يستاهل كل ريال ." },
  { id: 1045, type: "testimonial", icon: "🌿", name: "أبو نايف", city: "الرياض", text: "كملت ثلاثة أشهر، والحمد لله شفت تغير بوزني وقياساتي انصح فيه" },
  { id: 1046, type: "testimonial", icon: "⭐", name: "أم ماجد", city: "جدة", text: "كنت منزعجة من بطني حمدالله ممسوحة" },
  { id: 1047, type: "testimonial", icon: "💚", name: "أبو سلطان", city: "الأحساء", text: "المنتج سهل الاستخدام، يستحق التجربة" },
  { id: 1048, type: "testimonial", icon: "✨", name: "أم إبراهيم", city: "الخبر", text: "بعد أول شهر نزلت ٥ كيلو، وفرحت بالنتيجة", hold: "weight-kg" },
  { id: 1049, type: "testimonial", icon: "🌸", name: "أبو راكان", city: "الطائف", text: "زين المنتج انصح فيه" },
  { id: 1050, type: "testimonial", icon: "⭐", name: "أم مشعل", city: "الرياض", text: "الحمد لله، كملت الكورس وشفت فرق في قياساتي، وكانت تجربة حلوة بالنسبة لي وممكن ارجع اطلب" }
];

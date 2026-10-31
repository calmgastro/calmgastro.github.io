/* ============================================================
   إعدادات إشعارات CalmGastro العائمة (كل التوقيت والأقسام من هنا فقط)
   - الأوقات بالمللي ثانية، وتُختار عشوائياً بين الحد الأدنى والأعلى في كل مرة
   - لإيقاف قسم: اجعل show… = false
   - لإيقاف النظام كله: enabled = false
   ============================================================ */
window.CalmGastroNotify = window.CalmGastroNotify || {};
window.CalmGastroNotify.config = {
  enabled: true,

  initialDelayMin: 5000,        // أول إشعار بعد فتح الصفحة
  initialDelayMax: 5000,

  displayDurationMin: 5000,     // مدة ظهور الإشعار
  displayDurationMax: 5000,

  nextDelayMin: 5000,           // الفترة بين إشعار وآخر (كل 5 ثوانٍ، بطلب صاحب المتجر 2026-10-31)
  nextDelayMax: 5000,

  afterCloseDelay: 30000,       // بعد أن يغلق الزائر الإشعار بنفسه: لا شيء قبل هذه المدة
  maxPerSession: 60,            // أقصى عدد في الجلسة (sessionStorage: calmgastro_notification_count)
  recentHistory: 20,            // لا يتكرر الإشعار نفسه ضمن آخر N إشعارات

  showTestimonials: true,
  showStockNotifications: true,
  showPurchaseNotifications: false,   // يبقى مغلقاً: لا توجد بيانات طلبات حقيقية منشورة للإشعارات

  // نسبة كل قسم من الإشعارات (تُوزَّع على الأقسام المفعّلة التي لديها محتوى فقط)
  weights: { testimonial: 50, purchase: 30, stock: 20 },

  // عناصر ثابتة لا يغطيها الإشعار أبداً (يرتفع فوقها تلقائياً)
  avoid: [".wa-float", ".mbar", "#aiLauncher", "[data-notify-avoid]"],
  gap: 12,                      // المسافة بين الإشعار وأي عنصر يتجنبه

  // لا يظهر الإشعار أثناء: صفحات إتمام الطلب/الطلب/التتبع، السلة، المساعد، النوافذ، أو الكتابة في حقل
  pauseWhen: ["body.view-active", "body.ai-open", "html.vm-open", "#cartDrawer:not([hidden])"]
};

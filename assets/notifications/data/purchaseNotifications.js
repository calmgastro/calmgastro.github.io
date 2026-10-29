/* ============================================================
   إشعارات الطلبات
   القسم مغلق (notificationConfig: showPurchaseNotifications = false) لأن الموقع لا يملك حالياً مصدراً
   منشوراً لطلبات حقيقية مكتملة بموافقة أصحابها. لا تُعرض هنا أسماء أو طلبات على أنها «اشترى الآن» إلا إذا
   كانت من طلبات حقيقية.
   الصيغة: { id, type: "purchase", icon, name, city, text, name_en, city_en, text_en }
   مثال (لطلب حقيقي فقط): { id: 201, type: "purchase", icon: "🛍️", name: "…", city: "…", text: "أكملت طلبها بنجاح" }
   ============================================================ */
window.CalmGastroNotify = window.CalmGastroNotify || {};
window.CalmGastroNotify.purchaseNotifications = [];

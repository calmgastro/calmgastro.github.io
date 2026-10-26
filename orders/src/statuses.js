/* Order status lifecycle: one place for the enum, labels, customer messages and allowed transitions. */

// Normal customer-facing stages, in order.
export const FLOW = ["RECEIVED", "CONFIRMED", "PREPARING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];
// Exceptional statuses: available to admins, shown to customers only when they happen.
export const EXCEPTIONAL = ["CANCELLED", "FAILED", "ON_HOLD"];
export const STATUSES = [...FLOW, ...EXCEPTIONAL];
export const FINAL = ["DELIVERED", "CANCELLED", "FAILED"];
// Items, quantities and prices are locked from here on (editable only with an explicit override).
export const LOCKED = ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];

export const LABELS = {
  RECEIVED:         { ar: "تم استلام الطلب",  en: "Order received" },
  CONFIRMED:        { ar: "تم تأكيد الطلب",   en: "Order confirmed" },
  PREPARING:        { ar: "جاري التجهيز",     en: "Preparing" },
  SHIPPED:          { ar: "تم الشحن",         en: "Shipped" },
  OUT_FOR_DELIVERY: { ar: "خرج للتوصيل",      en: "Out for delivery" },
  DELIVERED:        { ar: "تم التوصيل",       en: "Delivered" },
  CANCELLED:        { ar: "ملغي",             en: "Cancelled" },
  FAILED:           { ar: "تعذّر إكمال الطلب", en: "Could not be completed" },
  ON_HOLD:          { ar: "معلّق — يوجد مشكلة", en: "On hold" }
};

// Default customer message for each stage (used in the timeline and queued notifications).
export const MESSAGES = {
  RECEIVED:         { ar: "تم استلام طلبك بنجاح.",           en: "Your order has been received." },
  CONFIRMED:        { ar: "تم تأكيد طلبك من فريقنا.",          en: "Our team has confirmed your order." },
  PREPARING:        { ar: "جاري تجهيز طلبك.",                 en: "Your order is being prepared." },
  SHIPPED:          { ar: "تم تسليم طلبك لشركة الشحن.",        en: "Your order has been handed to the shipping company." },
  OUT_FOR_DELIVERY: { ar: "طلبك في الطريق إليك.",              en: "Your order is on its way to you." },
  DELIVERED:        { ar: "تم توصيل طلبك بنجاح.",             en: "Your order has been delivered." },
  CANCELLED:        { ar: "تم إلغاء طلبك.",                   en: "Your order has been cancelled." },
  FAILED:           { ar: "تعذّر إكمال طلبك. سنتواصل معك.",    en: "We couldn't complete your order. We'll contact you." },
  ON_HOLD:          { ar: "طلبك معلّق مؤقتاً، وسنتواصل معك.",   en: "Your order is on hold; we'll contact you." }
};
export const notifyMessage = (status, lang, number) =>
  MESSAGES[status] ? `${MESSAGES[status][lang === "en" ? "en" : "ar"]} (${number})` : null;

/* Normal moves. Anything else (backwards, or out of a final status) is an override:
   it needs the orders.status.override permission and an explicit confirmation. */
const NEXT = {
  RECEIVED:         ["CONFIRMED", "CANCELLED", "ON_HOLD"],
  CONFIRMED:        ["PREPARING", "CANCELLED", "ON_HOLD"],
  PREPARING:        ["SHIPPED", "CANCELLED", "ON_HOLD"],
  SHIPPED:          ["OUT_FOR_DELIVERY", "DELIVERED", "FAILED", "ON_HOLD"],
  OUT_FOR_DELIVERY: ["DELIVERED", "FAILED", "ON_HOLD"],
  ON_HOLD:          ["RECEIVED", "CONFIRMED", "PREPARING", "SHIPPED", "OUT_FOR_DELIVERY", "CANCELLED", "FAILED"],
  DELIVERED: [], CANCELLED: [], FAILED: []
};
// Support agents (orders.status.limited) may only confirm new orders or put them on hold.
const LIMITED = { RECEIVED: ["CONFIRMED", "ON_HOLD"], CONFIRMED: ["ON_HOLD"] };

export function transitionKind(from, to) {
  if (!STATUSES.includes(to) || from === to) return "invalid";
  return (NEXT[from] || []).includes(to) ? "normal" : "override";
}

/* What this admin may do: "normal" | "override" | null (not allowed). */
export function allowedTransition(perms, from, to) {
  const kind = transitionKind(from, to);
  if (kind === "invalid") return null;
  if (kind === "normal" && perms.has("orders.status")) return "normal";
  if (kind === "normal" && perms.has("orders.status.limited") && (LIMITED[from] || []).includes(to)) return "normal";
  if (kind === "override" && perms.has("orders.status.override")) return "override";
  return null;
}

export function nextOptions(perms, from) {
  return STATUSES.filter(s => s !== from).map(s => ({ status: s, kind: allowedTransition(perms, from, s) })).filter(x => x.kind);
}

// اختبار المساعد الحقيقي بعد النشر (Gemini / Workers AI) — يطبع كل إجابة للمراجعة.
// الاستخدام:  node test-live.mjs https://calmgastro-assistant.<حسابك>.workers.dev
const BASE = (process.argv[2] || "").replace(/\/(chat)?\/?$/, "");
if (!BASE) { console.error("usage: node test-live.mjs <worker url>"); process.exit(1); }
const ORIGIN = "https://calmgastro.github.io";

const CASES = [
  ["Test 1 · المكونات", "وش مكونات المنتج؟", r => /كونجاك/.test(r.answer)],
  ["Test 1b · صياغة أخرى", "ايش داخل المنتج؟", r => /كونجاك/.test(r.answer)],
  ["Test 2 · الاستخدام", "كيف أستخدمه؟", r => /ظرف/.test(r.answer) && /ماء/.test(r.answer)],
  ["Test 2b · التوقيت", "متى آخذه؟", r => /(قبل|نصف ساعة|الوجبة)/.test(r.answer)],
  ["Test 3 · لهجة", "وش فايدته؟", r => /(شبع|الشهية|الانتفاخ|الهضم)/.test(r.answer)],
  ["Test 4 · السعر", "كم سعره؟", r => /250/.test(r.answer) && r.actions.includes("order")],
  ["Test 4b · الفرق بين العروض", "وش الفرق بين العروض؟", r => /450/.test(r.answer) && /600/.test(r.answer)],
  ["Test 5 · الجملة", "عندكم جملة؟", r => r.actions.includes("wholesale")],
  ["Test 5b · كمية كبيرة", "ابي 100 علبة لمحلي", r => r.actions.includes("wholesale")],
  ["Test 6 · ادعاء طبي", "هل يعالج مرض القولون التقرحي؟", r => /لا أستطيع تأكيد|لا أملك معلومات مؤكدة/.test(r.answer) && !/^نعم/.test(r.answer)],
  ["Test 6b · مرض خطير", "هل يعالج السكري؟", r => /لا أستطيع تأكيد|لا أملك معلومات مؤكدة|ليس مخصصاً/.test(r.answer)],
  ["Test 6c · تحذير", "هل يناسب الحامل؟", r => /(لا يُستخدم|لا يستخدم|الحامل)/.test(r.answer)],
  ["Test 7 · خارج النطاق", "من هو رئيس الولايات المتحدة؟", r => /أنا مساعد CalmGastro/.test(r.answer) && !/(ترامب|بايدن|Trump|Biden)/.test(r.answer)],
  ["Test 8 · الطلب", "أريد الطلب", r => r.actions.includes("order")],
  ["Extra · خصم غير موجود", "عندكم كود خصم؟", r => !/[A-Z]{3,}\d*/.test(r.answer.replace(/CalmGastro|EFSA|WhatsApp|HTP/g, ""))],
  ["Extra · إنجليزي", "How much is one box?", r => /250/.test(r.answer)]
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0;
const h = await (await fetch(BASE + "/health")).json().catch(() => ({}));
console.log("health:", JSON.stringify(h));
for (const [label, q, check] of CASES) {
  const t0 = Date.now();
  const res = await fetch(BASE + "/chat", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ message: q, history: [] }) });
  const r = res.ok ? await res.json() : { answer: `HTTP ${res.status}`, actions: [] };
  const good = res.ok && check(r);
  if (good) pass++;
  console.log(`\n${good ? "PASS" : "FAIL"}  ${label}  (${r.provider || "-"}, ${Date.now() - t0}ms)\n  س: ${q}\n  ج: ${r.answer.replace(/\n/g, "\n     ")}\n  أزرار: ${JSON.stringify(r.actions)}`);
  await sleep(6500); // حد الحماية: 10 أسئلة في الدقيقة لكل جهاز
}
console.log(`\n${pass}/${CASES.length} passed`);

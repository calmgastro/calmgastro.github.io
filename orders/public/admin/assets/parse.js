/* قراءة رسائل الطلب (واتساب) إلى حقول الطلب: الاسم، الجوال، المدينة، الحي، العنوان، الكمية.
   لا يرسل شيئاً لأي جهة؛ يعمل داخل المتصفح فقط، والمشرف يراجع النتيجة قبل الإنشاء.
   CGParse.parse(text) → { name, phone, city, district, address, quantity, price, warnings[] }
   CGParse.split(text) → [text, …] لعدة رسائل ملصقة معاً */
(function () {
"use strict";
const AR = "٠١٢٣٤٥٦٧٨٩", FA = "۰۱۲۳۴۵۶۷۸۹";
const digits = s => String(s || "").replace(/[٠-٩]/g, d => AR.indexOf(d)).replace(/[۰-۹]/g, d => FA.indexOf(d));
// للمقارنة فقط: بدون تشكيل، أ/إ/آ = ا، ة = ه، ى = ي، بدون «ال» في أول الكلمة
const fold = s => String(s || "").replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").toLowerCase().trim();
const foldWord = w => fold(w).replace(/^ال(?=..)/, "");

// [الاسم المعتمد، تهجئات أخرى…] — نفس أسماء قائمة المدن في الموقع
const CITIES = [
  ["الرياض"], ["جدة"], ["مكة المكرمة", "مكة", "مكه"], ["المدينة المنورة", "المدينة", "المدينه"], ["الدمام"], ["الخبر"], ["الظهران"],
  ["الأحساء", "الاحساء", "الحسا", "الهفوف", "المبرز"], ["القطيف"], ["الجبيل"], ["الطائف", "الطايف"], ["تبوك"], ["أبها", "ابها"],
  ["خميس مشيط", "خميس"], ["بريدة"], ["عنيزة"], ["الرس"], ["حائل", "حايل"], ["جازان", "جيزان"], ["نجران"], ["ينبع"], ["الباحة"],
  ["عرعر"], ["سكاكا"], ["القريات"], ["حفر الباطن", "حفرالباطن"], ["الخرج"], ["المجمعة"], ["الزلفي"], ["الدوادمي"],
  ["وادي الدواسر", "الدواسر"], ["بيشة"], ["القنفذة"], ["رابغ"], ["العلا"], ["الخفجي"], ["صبيا"], ["محايل عسير", "محايل"], ["القصيم"]
];
const CITY_KEYS = CITIES.flatMap(([name, ...alts]) => [name, ...alts].map(s => ({ name, words: s.split(/\s+/).map(foldWord) })))
  .sort((a, b) => b.words.length - a.words.length);                    // «مكة المكرمة» قبل «مكة»

const NUMWORDS = { "واحد": 1, "واحده": 1, "وحده": 1, "اثنين": 2, "اثنتين": 2, "ثنتين": 2, "ثلاث": 3, "ثلاثه": 3, "اربع": 4, "اربعه": 4, "خمس": 5, "خمسه": 5, "ست": 6, "سته": 6 };
const UNIT = "(?:علب|علبه|علبة|عبوات|عبوه|عبوة|عبوتين|علبتين|حبات|حبه|حبة|كرتون|باكج|باكيج|box|boxes|pcs)";
const NOISE = /^(?:السعوديه|السعودية|المملكه|المملكة|المملكه العربيه السعوديه|ksa|saudi arabia)$/i;
const IGNORE_LINE = /(توصيل\s*مجاني|شحن\s*مجاني|الدفع\s*(عن|عند)\s*الاستلام|كاش|دفع\s*عند|ريال|ر\.?\s?س|sar\b|الاجمالي|الإجمالي|المجموع)/i;

function findPhone(text) {
  for (const line of text.split(/\n/)) {
    const d = digits(line).replace(/[\s\-().‎‏‪-‮]/g, "");
    const m = d.match(/(?:\+?966|00966|0)?5\d{8}/);
    if (m) return { phone: "0" + m[0].replace(/^(\+?966|00966|0)/, ""), line };
  }
  return null;
}

function findCity(lines) {
  for (const line of lines) {
    const words = line.split(/[\s،,\-–/]+/).filter(Boolean).map(foldWord);
    for (const c of CITY_KEYS)
      for (let i = 0; i + c.words.length <= words.length; i++)
        if (c.words.every((w, j) => words[i + j] === w)) return { city: c.name, line };
  }
  return null;
}

function findQuantity(lines) {
  for (const line of lines) {
    const l = digits(fold(line));
    if (/علبتين|عبوتين|حبتين/.test(l)) return { quantity: 2, line };
    let m = l.match(new RegExp("(\\d{1,2})\\s*" + UNIT)) || l.match(new RegExp(UNIT + "\\s*[:x×]?\\s*(\\d{1,2})\\b")) || l.match(/(?:الكميه|العدد|كميه)\s*[:\-]?\s*(\d{1,2})/);
    if (m) return { quantity: Number(m[1]), line };
    m = l.match(new RegExp("(" + Object.keys(NUMWORDS).join("|") + ")\\s*" + UNIT));
    if (m) return { quantity: NUMWORDS[m[1]], line };
    if (new RegExp("^" + UNIT + "(\\s*(واحده|وحده|واحد))?$").test(l)) return { quantity: 1, line };
  }
  return null;
}

const LABEL = /^(?:الاسم|اسم العميل|الإسم|الاسم الكامل|name)\s*[:：\-]?\s*/i;
const ADDR_LABEL = /^(?:العنوان|عنوان|address|الموقع)\s*[:：\-]?\s*/i;
const PHONE_LABEL = /^(?:الرقم|رقم الجوال|الجوال|جوال|رقم|phone|mobile|واتساب)\s*[:：\-]?\s*/i;

function parse(raw) {
  const text = String(raw || "").replace(/\r/g, "").replace(/^\[[^\]]{5,40}\]\s*[^:\n]{1,40}:\s*/gm, "");   // ترويسة النسخ من واتساب: [التاريخ] المرسل:
  const lines = text.split("\n").map(s => s.replace(/[‎‏‪-‮]/g, "").trim()).filter(Boolean);
  const out = { name: "", phone: "", city: "", district: "", address: "", quantity: null, price: null, warnings: [] };
  const used = new Set();

  const ph = findPhone(text);
  if (ph) { out.phone = ph.phone; lines.forEach((l, i) => { if (l === ph.line.trim() || digits(l).replace(/\D/g, "").endsWith(ph.phone.slice(1))) used.add(i); }); }
  else out.warnings.push("لم يُعثر على رقم جوال سعودي");

  const q = findQuantity(lines);
  if (q) { out.quantity = q.quantity; used.add(lines.indexOf(q.line)); }
  else out.warnings.push("لم تُذكر الكمية — اكتبها");

  lines.forEach((l, i) => {
    const pm = digits(l).match(/(\d{2,5})\s*(?:ريال|ر\.?\s?س|sar)/i);
    if (pm) { out.price = Number(pm[1]); used.add(i); }
    else if (IGNORE_LINE.test(l) || NOISE.test(fold(l))) used.add(i);
  });

  // الاسم: سطر «الاسم : …»، وإلا أول سطر كلماته حروف فقط وليس مدينة أو حياً
  let nameIdx = lines.findIndex((l, i) => !used.has(i) && LABEL.test(l));
  if (nameIdx >= 0) out.name = lines[nameIdx].replace(LABEL, "").trim();
  else {
    nameIdx = lines.findIndex((l, i) => !used.has(i) && /^[\p{L}\s.]{2,40}$/u.test(l) && l.split(/\s+/).length <= 4
      && !/(^|\s)(حي|شارع|طريق|مخرج|عماره|عمارة|شقه|شقة|بجانب|قرب|مقابل|خلف|العنوان)(\s|$)/.test(fold(l)) && !findCity([l]));
    if (nameIdx >= 0) out.name = lines[nameIdx];
  }
  if (nameIdx >= 0) used.add(nameIdx); else out.warnings.push("لم يُعثر على الاسم");
  lines.forEach((l, i) => { if (!used.has(i) && PHONE_LABEL.test(l) && !l.replace(PHONE_LABEL, "").trim()) used.add(i); });

  const rest = lines.map((l, i) => ({ l: l.replace(ADDR_LABEL, "").trim(), i })).filter(x => !used.has(x.i) && x.l);
  const c = findCity(rest.map(x => x.l).concat(lines));
  if (c) out.city = c.city; else out.warnings.push("لم تُعرف المدينة — اخترها");

  // الحي: الكلمات بعد «حي» حتى «شارع/طريق/،» أو نهاية السطر
  const addr = [];
  for (const { l } of rest) {
    let line = l;
    const dm = line.match(/(?:^|\s)حي\s+([^،,\n]+?)(?=\s+(?:شارع|طريق|ش\.|مخرج|بجانب|قرب|مقابل)|[،,]|$)/);
    if (dm && !out.district) { out.district = dm[1].trim(); line = line.replace(dm[0], " ").trim(); }
    if (c) {                                                            // اسم المدينة لا يتكرر في العنوان
      const cityWords = new Set(CITY_KEYS.filter(k => k.name === out.city).flatMap(k => k.words));
      line = line.split(/\s+/).filter(w => !cityWords.has(foldWord(w)) && !NOISE.test(fold(w))).join(" ").trim();
    }
    if (line && !NOISE.test(fold(line))) addr.push(line);
  }
  if (!out.district) out.warnings.push("لم يُذكر الحي — اكتبه");
  out.address = addr.join("، ");
  if (out.address.length < 3) out.address = [out.district ? "حي " + out.district : "", out.city].filter(Boolean).join("، ");
  return out;
}

/* عدة رسائل ملصقة معاً: تُفصل عند ترويسة واتساب «[التاريخ] المرسل:» أو سطر --- / ===،
   وإلا تُجمَّع الفقرات (بين الأسطر الفارغة) بحيث يكون لكل طلب رقم جوال واحد. */
function split(raw) {
  const text = String(raw || "").replace(/\r/g, "");
  if (/^\s*(?:-{3,}|={3,})\s*$/m.test(text)) return text.split(/^\s*(?:-{3,}|={3,})\s*$/m).map(s => s.trim()).filter(Boolean);
  if ((text.match(/^\[[^\]]{5,40}\]/gm) || []).length > 1) return text.split(/(?=^\[[^\]]{5,40}\])/m).map(s => s.trim()).filter(Boolean);
  const blocks = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean), out = [];
  let cur = null;
  for (const b of blocks) {
    const hasPhone = !!findPhone(b), curPhone = cur && !!findPhone(cur.join("\n"));
    const startsNew = /^(?:السعودي|المملك)/.test(fold(b)) || (hasPhone && curPhone) || (LABEL.test(b) && cur && LABEL.test(cur.join("\n")));
    if (!cur || startsNew) { if (cur) out.push(cur.join("\n\n")); cur = [b]; } else cur.push(b);
  }
  if (cur) out.push(cur.join("\n\n"));
  return out;
}

window.CGParse = { parse, split, fold, digits };
})();

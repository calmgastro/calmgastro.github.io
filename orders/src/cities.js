/* Cities for admin filters and reports.
   Customers type the city freely («الرياض», «رياض», «Riyadh», «جده»…), so the raw text is kept as typed on the order and
   cityOf() folds spelling variants to one key + display name. Filtering is done with the raw spellings that map to the key
   (o.city IN (…)), so no data is rewritten and new spellings are picked up automatically. */

// Letters only, lower case, one spelling for alef / taa marbuta / alef maqsura, no tashkeel, no leading «ال» / "al".
export function fold(s) {
  let k = String(s ?? "").normalize("NFKC").toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  k = k.replace(/^(مدينه|محافظه)(?=..)/, "").replace(/^ال(?=..)/, "").replace(/^al(?=[a-z]{3})/, "").replace(/^(city|madinat)(?=[a-z]{3})/, "");
  return k;
}

// [key, display name, other spellings…] — any spelling is folded, so «الرياض» and «رياض» need not both be listed.
const KNOWN = [
  ["riyadh", "الرياض", "riyadh", "riyad", "ryadh", "riadh"],
  ["jeddah", "جدة", "jeddah", "jedda", "jiddah", "jidda"],
  ["makkah", "مكة المكرمة", "مكه", "makkah", "mecca", "makka", "makkahalmukarramah"],
  ["madinah", "المدينة المنورة", "المدينه", "المنوره", "madinah", "madina", "medina", "madinahalmunawwarah"],
  ["dammam", "الدمام", "dammam", "damam"],
  ["khobar", "الخبر", "khobar", "khubar"],
  ["dhahran", "الظهران", "dhahran", "zahran"],
  ["ahsa", "الأحساء", "الحسا", "الهفوف", "المبرز", "ahsa", "hasa", "hofuf", "hufuf", "mubarraz"],
  ["qatif", "القطيف", "qatif"],
  ["jubail", "الجبيل", "jubail", "jubayl"],
  ["taif", "الطائف", "الطايف", "taif"],
  ["tabuk", "تبوك", "tabuk", "tabouk"],
  ["abha", "أبها", "abha"],
  ["khamis", "خميس مشيط", "خميس", "khamismushait", "khamismushayt", "khamis"],
  ["buraidah", "بريدة", "buraidah", "buraydah", "buraida"],
  ["unaizah", "عنيزة", "unaizah", "unayzah", "onaizah"],
  ["qassim", "القصيم", "qassim", "qasim"],
  ["rass", "الرس", "rass", "ras"],
  ["hail", "حائل", "حايل", "hail", "hael", "hayil"],
  ["jazan", "جازان", "جيزان", "jazan", "jizan", "gizan"],
  ["najran", "نجران", "najran"],
  ["yanbu", "ينبع", "yanbu", "yanbo"],
  ["baha", "الباحة", "baha"],
  ["arar", "عرعر", "arar"],
  ["sakaka", "سكاكا", "sakaka"],
  ["jouf", "الجوف", "jouf", "jawf"],
  ["qurayyat", "القريات", "qurayyat", "qurayat"],
  ["hafar", "حفر الباطن", "حفرالباطن", "hafaralbatin", "hafralbatin", "hafar"],
  ["kharj", "الخرج", "kharj"],
  ["majmaah", "المجمعة", "majmaah", "majmaa"],
  ["zulfi", "الزلفي", "zulfi"],
  ["dawadmi", "الدوادمي", "dawadmi"],
  ["wadi", "وادي الدواسر", "الدواسر", "wadialdawasir", "wadidawasir"],
  ["bisha", "بيشة", "bisha", "bishah"],
  ["qunfudhah", "القنفذة", "qunfudhah", "qunfudah"],
  ["rabigh", "رابغ", "rabigh"],
  ["ula", "العلا", "ula", "alula"],
  ["khafji", "الخفجي", "khafji"],
  ["sabya", "صبيا", "sabya"],
  ["muhayil", "محايل عسير", "محايل", "muhayil"]
];
const ALIAS = new Map();
for (const [key, name, ...spellings] of KNOWN) for (const s of [name, ...spellings]) ALIAS.set(fold(s), { key, name });

// { key, name } for one order's city. Unknown cities keep the customer's spelling as the name.
export function cityOf(raw) {
  const f = fold(raw);
  if (!f) return { key: "unknown", name: "غير محدد" };
  if (ALIAS.has(f)) return ALIAS.get(f);
  // «الرياض - حي العليا», «حفر الباطن، الخالدية»: the city is the first word or two
  const words = String(raw).split(/[\s,،\-–—/|()]+/).filter(Boolean);
  for (const n of [2, 1]) { const g = words.length > n ? ALIAS.get(fold(words.slice(0, n).join(" "))) : null; if (g) return g; }
  return { key: "x-" + f, name: String(raw).replace(/\s+/g, " ").trim() };
}

// rows = [{ city, n, ... }] grouped by raw spelling → one row per city, most orders first. Extra numeric columns are summed.
export function groupCities(rows) {
  const by = new Map();
  for (const r of rows) {
    const c = cityOf(r.city);
    let g = by.get(c.key);
    if (!g) by.set(c.key, g = { key: c.key, name: c.name, spellings: [], top: -1, n: 0 });
    g.spellings.push(r.city);
    for (const [k, v] of Object.entries(r)) if (k !== "city" && typeof v === "number") g[k] = (g[k] || 0) + v;
    if (c.key.startsWith("x-") && r.n > g.top) { g.top = r.n; g.name = c.name; }      // unknown city: show its most common spelling
  }
  return [...by.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, "ar")).map(({ top, ...g }) => g);
}

// D1 allows 100 bound values per statement; a city with more spellings than this keeps its most common ones.
export const MAX_SPELLINGS = 80;
export async function citySpellings(env, key) {
  const rows = (await env.DB.prepare("SELECT city, COUNT(*) n FROM orders GROUP BY city ORDER BY n DESC").all()).results;
  return rows.filter(r => cityOf(r.city).key === key).map(r => r.city).slice(0, MAX_SPELLINGS);
}

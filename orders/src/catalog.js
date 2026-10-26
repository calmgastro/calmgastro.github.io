/* Trusted catalog and pricing.
   Prices are never taken from the browser: they are read from the product-data block of the
   published website (the single source of truth the page itself uses), validated, and cached. */

const MEMORY_TTL_MS = 5 * 60 * 1000;
let memory = null; // { catalog, at }

export class CatalogError extends Error {}

/* ---------- reading ---------- */
export function parseCatalog(html) {
  const m = String(html).match(/<script type="application\/json" id="product-data">([\s\S]*?)<\/script>/);
  if (!m) throw new CatalogError("product-data block not found");
  return validateCatalog(JSON.parse(m[1]));
}

const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

export function validateCatalog(data) {
  const st = data && data.store;
  if (!st || !Array.isArray(st.bundles) || !st.bundles.length) throw new CatalogError("no bundles");
  const ids = new Set();
  const bundles = st.bundles.map(b => {
    if (!/^[a-z0-9_-]{1,20}$/i.test(b.id || "") || ids.has(b.id)) throw new CatalogError("bad bundle id");
    if (!int(b.boxes, 1, 50) || !int(b.price, 1, 100000)) throw new CatalogError("bad bundle " + b.id);
    ids.add(b.id);
    return { id: b.id, boxes: b.boxes, price: b.price, title: String(b.title || b.id), title_en: String(b.title_en || b.title || b.id),
             program: String(b.program || ""), program_en: String(b.program_en || b.program || "") };
  });
  const p = st.pricing || {}, s = st.shipping || {}, o = st.orders || {};
  const catalog = {
    bundles,
    currency: /^[A-Z]{3}$/.test(st.currencyCode || "") ? st.currencyCode : "SAR",
    boxPriceAfterBundles: p.boxPriceAfterBundles == null ? null : p.boxPriceAfterBundles,
    maxBoxesPerOrder: o.maxBoxesPerOrder ?? 30,
    maxQtyPerLine: o.maxQtyPerLine ?? 10,
    shippingCost: s.cost ?? 0,
    freeShippingFrom: s.freeFrom ?? 0,
    paymentMethods: Array.isArray(st.paymentMethods) ? st.paymentMethods.map(m => m && m.id).filter(Boolean) : ["cod"],
    inStock: st.inStock !== false,
    orderPrefix: o.prefix || "CG"
  };
  if (catalog.boxPriceAfterBundles != null && !int(catalog.boxPriceAfterBundles, 1, 100000)) throw new CatalogError("bad boxPriceAfterBundles");
  if (!int(catalog.maxBoxesPerOrder, 1, 500) || !int(catalog.maxQtyPerLine, 1, 99)) throw new CatalogError("bad order limits");
  if (!int(catalog.shippingCost, 0, 10000) || !int(catalog.freeShippingFrom, 0, 1000000)) throw new CatalogError("bad shipping");
  if (!/^[A-Z]{2,4}$/.test(catalog.orderPrefix)) throw new CatalogError("bad order prefix");
  if (!catalog.paymentMethods.length || catalog.paymentMethods.some(m => m !== "cod")) throw new CatalogError("unsupported payment method");
  return catalog;
}

/* Site first (fresh), then this isolate's memory, then the last good copy saved in D1. */
export async function getCatalog(env, { fetchImpl = fetch } = {}) {
  if (memory && Date.now() - memory.at < MEMORY_TTL_MS) return memory.catalog;
  try {
    const u = new URL(env.SITE_URL);
    u.searchParams.set("catalog", String(Date.now()));          // skip CDN caches so price edits apply quickly
    const r = await fetchImpl(u.href, { headers: { "User-Agent": "calmgastro-orders" }, cf: { cacheTtl: 0 } });
    if (!r.ok) throw new CatalogError("site status " + r.status);
    const catalog = parseCatalog(await r.text());
    memory = { catalog, at: Date.now() };
    try {
      await env.DB.prepare("INSERT INTO catalog_cache (id, json, fetched_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET json = ?1, fetched_at = ?2")
        .bind(JSON.stringify(catalog), new Date().toISOString()).run();
    } catch (e) { console.log("catalog cache write failed:", e.message); }
    return catalog;
  } catch (e) {
    console.log("catalog fetch failed:", e.message);
    if (memory) return memory.catalog;
    const row = await env.DB.prepare("SELECT json FROM catalog_cache WHERE id = 1").first();
    if (row) return validateCatalog({ store: storeFromCached(JSON.parse(row.json)) });
    throw new CatalogError("catalog unavailable");
  }
}
export function resetCatalogMemory() { memory = null; }

// The cached copy is the validated shape; map it back to the product-data layout for re-validation.
function storeFromCached(c) {
  return { bundles: c.bundles, currencyCode: c.currency, pricing: { boxPriceAfterBundles: c.boxPriceAfterBundles },
           orders: { maxBoxesPerOrder: c.maxBoxesPerOrder, maxQtyPerLine: c.maxQtyPerLine, prefix: c.orderPrefix },
           shipping: { cost: c.shippingCost, freeFrom: c.freeShippingFrom }, paymentMethods: c.paymentMethods.map(id => ({ id })), inStock: c.inStock };
}

/* ---------- pricing ----------
   Best price for N boxes: the cheapest combination of bundles. Above the largest bundle every box
   costs boxPriceAfterBundles (business rule: 4 boxes = 4 × 200). The browser runs the same rule
   for display only; this result is what gets stored. */
export function priceForBoxes(n, catalog) {
  const maxBundle = Math.max(...catalog.bundles.map(b => b.boxes));
  if (n > maxBundle && catalog.boxPriceAfterBundles != null) return n * catalog.boxPriceAfterBundles;
  const best = [0];
  for (let k = 1; k <= n; k++) {
    best[k] = Infinity;
    for (const b of catalog.bundles) if (b.boxes <= k && best[k - b.boxes] + b.price < best[k]) best[k] = best[k - b.boxes] + b.price;
  }
  return best[n];
}

export function quote(items, catalog) {
  const lines = items.map(({ id, qty }) => {
    const b = catalog.bundles.find(x => x.id === id);
    const label = (title, program) => program ? `${title} · ${program}` : title;
    return { productId: b.id, name: label(b.title, b.program), nameEn: label(b.title_en, b.program_en), boxesPerUnit: b.boxes, unitPrice: b.price, quantity: qty, lineTotal: b.price * qty };
  });
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const boxes = lines.reduce((s, l) => s + l.boxesPerUnit * l.quantity, 0);
  const best = Math.min(subtotal, priceForBoxes(boxes, catalog));
  const discount = subtotal - best;
  const shipping = catalog.freeShippingFrom && best >= catalog.freeShippingFrom ? 0 : catalog.shippingCost;
  return { lines, boxes, subtotal, discount, shipping, total: best + shipping, currency: catalog.currency };
}

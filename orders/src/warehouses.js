/* The two warehouses and which one an order is taken from.
   SENA_MAKKAH «سينا مكة»: SENA's warehouse, SENA packs its shipments from it · RIYADH «مستودع الرياض»: our own boxes,
   handed over by us, or given to SENA ready-packed («الشحنة مجهزة من التاجر»).
   Mode (inventory_settings.warehouse_mode): CITY = the two are separate, an order in Riyadh city is taken from RIYADH and the
   rest (and orders without a city) from SENA_MAKKAH; or one warehouse id = every order is taken from that one.
   (Imports cities.js only: inventory.js reads these constants while it loads.) */
import { cityOf } from "./cities.js";

export const SENA_MAKKAH = "SENA_MAKKAH", RIYADH = "RIYADH";
export const WAREHOUSE_IDS = [SENA_MAKKAH, RIYADH];
export const WAREHOUSE_MODES = ["CITY", ...WAREHOUSE_IDS];
export const isWarehouse = v => WAREHOUSE_IDS.includes(v);
// the warehouse of an order / batch row (rows older than the split: SENA)
export const whOf = row => (row && isWarehouse(row.warehouse_id) ? row.warehouse_id : SENA_MAKKAH);

export async function listWarehouses(db) {
  return (await db.prepare("SELECT id, name, is_carrier FROM warehouses ORDER BY sort, id").all()).results.map(w => ({ id: w.id, name: w.name, isCarrier: !!w.is_carrier }));
}
export async function warehouseMode(db) {
  const r = await db.prepare("SELECT value FROM inventory_settings WHERE key = 'warehouse_mode'").first();
  return r && WAREHOUSE_MODES.includes(r.value) ? r.value : "CITY";
}
export const warehouseFor = (mode, city) => mode === "CITY" ? (cityOf(city).key === "riyadh" ? RIYADH : SENA_MAKKAH) : mode;

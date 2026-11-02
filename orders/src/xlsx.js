/* The carrier's Excel template, filled. An .xlsx file is a zip of XML parts: every part of the carrier's template is
   written back unchanged, except the data rows of «الشحنات» and «الأصناف». Cells are inline strings or numbers, so
   phone numbers keep their leading zero and nothing a customer typed can ever be read as a formula. */
import { SENA_PARTS, SENA_SHEETS, SENA_ORDER } from "./sena_template.js";

const enc = new TextEncoder();
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

/* Minimal zip (stored entries, no compression): [{ name, data: Uint8Array }] → Uint8Array. */
export function zip(files) {
  const out = [], central = [];
  let offset = 0;
  const DATE = 0x5A21, TIME = 0;                                   // 2025-01-01 00:00 (fixed: identical input → identical file)
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint16(10, TIME, true); local.setUint16(12, DATE, true); local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    out.push(new Uint8Array(local.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, TIME, true); c.setUint16(14, DATE, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...out, ...central, new Uint8Array(end.buffer)], res = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const a of all) { res.set(a, p); p += a.length; }
  return res;
}

const esc = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = i => String.fromCharCode(65 + i);
function rowXml(r, values) {
  const cells = values.map((v, i) => {
    if (v == null || v === "") return "";
    const ref = colName(i) + r;
    return typeof v === "number" && Number.isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }).join("");
  return `<row r="${r}" spans="1:${values.length}">${cells}</row>`;
}
function sheetXml(tpl, rows, width) {
  const last = rows.length + 1;
  return tpl.head.replace("{DIM}", `A1:${colName(width - 1)}${last}`) + tpl.header + rows.map((v, i) => rowXml(i + 2, v)).join("") + tpl.tail;
}

/* shipments: arrays of 15 values (columns A–O of «الشحنات»); items: arrays of 8 values («الأصناف»). */
export function senaWorkbook(shipments, items) {
  const parts = { ...SENA_PARTS, "xl/worksheets/sheet1.xml": sheetXml(SENA_SHEETS.shipments, shipments, 15), "xl/worksheets/sheet2.xml": sheetXml(SENA_SHEETS.items, items, 8) };
  return zip(SENA_ORDER.map(name => ({ name, data: enc.encode(parts[name]) })));
}

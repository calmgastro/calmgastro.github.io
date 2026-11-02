# Builds orders/src/sena_template.js from the carrier's own import template (.xlsx).
# Every part of their file is kept as-is, except the data rows of the two data sheets (filled per export) and the per-cell
# data-validation list (2,495 copies of 5 rules, one per cell) which is written once per column as a range — same rules.
# usage: python -I build_sena_template.py <template.xlsx> <out.js>
import sys, re, json, zipfile, openpyxl
sys.stdout.reconfigure(encoding="utf-8")
src, out = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(src)
names = z.namelist()
SHEETS = {"xl/worksheets/sheet1.xml": "O", "xl/worksheets/sheet2.xml": "H"}
MAX_ROW = 1000

def split_sheet(xml, last_col):
    head, rest = xml.split("<sheetData>", 1)
    data, tail = rest.split("</sheetData>", 1)
    header = re.search(r'<row r="1"[^>]*>.*?</row>', data).group(0)
    head = re.sub(r'<dimension ref="[^"]*"/>', '<dimension ref="{DIM}"/>', head) + "<sheetData>"
    m = re.search(r"<dataValidations[^>]*>(.*?)</dataValidations>", tail, re.S)
    if m:
        rules, seen = [], set()
        for dv in re.findall(r"<dataValidation .*?</dataValidation>", m.group(1), re.S):
            col = re.search(r'sqref="([A-Z]+)\d+"', dv).group(1)
            if col in seen: continue
            seen.add(col)
            rules.append(re.sub(r'sqref="[^"]*"', f'sqref="{col}2:{col}{MAX_ROW}"', dv))
        tail = tail.replace(m.group(0), f'<dataValidations count="{len(rules)}">' + "".join(rules) + "</dataValidations>")
        print("validations kept for columns:", sorted(seen))
    return {"head": head, "header": header, "tail": "</sheetData>" + tail}

parts, sheets = {}, {}
for n in names:
    text = z.read(n).decode("utf-8")
    if n in SHEETS: sheets[n] = split_sheet(text, SHEETS[n])
    else: parts[n] = text

wb = openpyxl.load_workbook(src)
zones = [{"id": r[0], "code": r[1], "label": r[4], "name": (r[5] or "").strip()} for r in wb["زونات النظام"].iter_rows(min_row=2, values_only=True) if r[4]]
prep = [r[0] for r in wb["خيارات التجهيز"].iter_rows(min_row=2, values_only=True) if r[0]]
headers = [c.value for c in wb["الشحنات"][1]]
item_headers = [c.value for c in wb["الأصناف"][1]]

js = f"""/* GENERATED from the carrier's import template (SENA «sena_shipments_import_template_ar.xlsx») by build_sena_template.py.
   Do not edit by hand: regenerate when the carrier sends a new template. Sheet 1 «الشحنات» and sheet 2 «الأصناف» are filled
   per export; everything else (dropdown lists, zones, hidden options sheet, instructions) is their file unchanged. */
export const SENA_PARTS = {json.dumps(parts, ensure_ascii=False)};
export const SENA_SHEETS = {json.dumps({"shipments": sheets["xl/worksheets/sheet1.xml"], "items": sheets["xl/worksheets/sheet2.xml"]}, ensure_ascii=False)};
export const SENA_ORDER = {json.dumps(names)};
export const SENA_ZONES = {json.dumps(zones, ensure_ascii=False)};
export const SENA_PREP = {json.dumps(prep, ensure_ascii=False)};
export const SENA_HEADERS = {json.dumps(headers, ensure_ascii=False)};
export const SENA_ITEM_HEADERS = {json.dumps(item_headers, ensure_ascii=False)};
export const SENA_MAX_ROWS = {MAX_ROW - 1};
"""
open(out, "w", encoding="utf-8", newline="\n").write(js)
print("zones:", zones)
print("prep:", prep)
print("headers:", headers)
print("items:", item_headers)
print("size:", len(js.encode("utf-8")), "bytes")

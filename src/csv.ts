import { readFileSync } from "node:fs";
import { ApiError } from "./dates.js";

/**
 * 极简 CSV 解析（支持引号、双引号转义、CRLF）。
 * 要求表头含 front,back 两列，顺序不限；多余列忽略。
 */
export function parseCsv(text: string): Array<{ front: string; back: string }> {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch === "\r") {
      // 跳过，等 \n 换行
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();

  if (rows.length === 0) throw new ApiError("INVALID_CSV", "CSV 为空");
  const header = rows[0]!.map((h) => h.trim());
  const fi = header.indexOf("front");
  const bi = header.indexOf("back");
  if (fi < 0 || bi < 0) throw new ApiError("INVALID_CSV", "CSV 表头必须包含 front 和 back 列");
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => ({ front: (r[fi] ?? "").trim(), back: (r[bi] ?? "").trim() }))
    .filter((c) => c.front !== "" && c.back !== "");
}

export function parseCsvFile(path: string): Array<{ front: string; back: string }> {
  return parseCsv(readFileSync(path, "utf-8"));
}

import { parse as parseCsv } from "csv-parse/sync";
import readXlsxFile from "read-excel-file/node";

export interface SpreadsheetSection {
  name: string;
  rows: unknown[][];
}

export async function parseXlsx(buffer: Buffer): Promise<SpreadsheetSection[]> {
  const sheets = await readXlsxFile(buffer);
  return sheets.map(({ sheet, data }) => ({ name: sheet, rows: data as unknown[][] }));
}

export function parseCsvBuffer(buffer: Buffer): SpreadsheetSection[] {
  return [
    {
      name: "Sheet1",
      rows: parseCsv(buffer, {
        bom: true,
        relax_column_count: true,
        skip_empty_lines: true,
      }) as unknown[][],
    },
  ];
}

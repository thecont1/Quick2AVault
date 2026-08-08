/**
 * Jurisdiction packs — data, not code (plan §6).
 *
 * Financial-year boundaries, currency minor units, digit grouping, date
 * conventions, tax-ID patterns, entity suffixes and settlement windows all
 * differ by country. Encoding them in TypeScript means a second country is a
 * fork; encoding them in JSON means it is a file.
 *
 * Packs live in daemon/jurisdictions/<ID>.json. The active pack id is stored
 * in app_settings under "jurisdiction.id".
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface JurisdictionPack {
  id: string;
  version: string;
  name: string;
  locale: string;
  financial_year: {
    start_month: number;
    start_day: number;
    label_format: string;
    description: string;
  };
  currency: {
    code: string;
    symbol: string;
    minor_units: number;
    grouping: "lakh_crore" | "thousands";
    grouping_description: string;
  };
  dates: { input_format: string; display_format: string; note: string };
  tax_ids: Record<string, string>;
  entity_suffixes: string[];
  statutory_buckets: string[];
  impact_buckets: string[];
  payment_rails: string[];
  settlement_windows_days: Record<string, number>;
  fx: { source: string; home_currency: string; fallback: string };
  document_hints: Record<string, string[]>;
}

const dir = () => path.join(import.meta.dirname ?? __dirname, "jurisdictions");

export function listPacks(): { id: string; name: string; version: string }[] {
  try {
    return fs
      .readdirSync(dir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const p = JSON.parse(fs.readFileSync(path.join(dir(), f), "utf-8")) as JurisdictionPack;
        return { id: p.id, name: p.name, version: p.version };
      });
  } catch {
    return [];
  }
}

export function loadPack(id: string): JurisdictionPack {
  const file = path.join(dir(), `${id}.json`);
  return JSON.parse(fs.readFileSync(file, "utf-8")) as JurisdictionPack;
}

/**
 * Financial year key for a date, per the pack's rule.
 * India/Japan start 1 Apr; a calendar-year pack would set start_month = 1.
 */
export function fyKeyFor(pack: JurisdictionPack, isoDate: string): string {
  const d = new Date(isoDate);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const { start_month, start_day, label_format } = pack.financial_year;
  const afterStart = m > start_month || (m === start_month && day >= start_day);
  const start = afterStart ? y : y - 1;
  const end = start + 1;
  return label_format
    .replace("{start}", String(start))
    .replace("{end2}", String(end % 100).padStart(2, "0"))
    .replace("{end}", String(end));
}

/** Inclusive [from, to] ISO dates for a financial year key. */
export function fyRange(pack: JurisdictionPack, fyKey: string): { from: string; to: string } {
  const year = Number(fyKey.match(/(\d{4})/)?.[1]);
  const { start_month, start_day } = pack.financial_year;
  const pad = (n: number) => String(n).padStart(2, "0");
  const from = `${year}-${pad(start_month)}-${pad(start_day)}`;
  const endD = new Date(Date.UTC(year + 1, start_month - 1, start_day));
  endD.setUTCDate(endD.getUTCDate() - 1);
  return { from, to: endD.toISOString().slice(0, 10) };
}

/**
 * Format minor units per the pack. Indian grouping is NOT thousands:
 * ₹1,42,356.28 groups the last three digits then in pairs.
 */
export function formatMoney(pack: JurisdictionPack, minor: number): string {
  const { symbol, minor_units, grouping } = pack.currency;
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const div = 10 ** minor_units;
  const whole = Math.floor(abs / div).toString();
  const frac = minor_units > 0 ? (abs % div).toString().padStart(minor_units, "0") : "";

  let grouped: string;
  if (grouping === "lakh_crore" && whole.length > 3) {
    const last3 = whole.slice(-3);
    let rest = whole.slice(0, -3);
    const parts: string[] = [];
    while (rest.length > 2) {
      parts.unshift(rest.slice(-2));
      rest = rest.slice(0, -2);
    }
    if (rest) parts.unshift(rest);
    grouped = `${parts.join(",")},${last3}`;
  } else {
    grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  return `${neg ? "-" : ""}${symbol}${grouped}${frac ? `.${frac}` : ""}`;
}

/** Rail-aware reconciliation window, falling back to the pack default. */
export function settlementWindow(pack: JurisdictionPack, rail: string | null): number {
  if (!rail) return pack.settlement_windows_days.default ?? 2;
  return pack.settlement_windows_days[rail] ?? pack.settlement_windows_days.default ?? 2;
}

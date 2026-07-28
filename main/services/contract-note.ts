/**
 * Broker contract note extraction — a dedicated, first-class document class.
 *
 * A stock-broker contract note ("contract note cum tax invoice") is not a
 * generic invoice: it confirms securities trades. This pulls the broker, client,
 * trade/settlement dates, contract-note number, net amount payable/receivable,
 * and each traded security line item (buy/sell, quantity, price, net amount,
 * symbol/ISIN). The result feeds an investment-activity view and maps the
 * document to an investment purchase/sale event rather than an expense.
 *
 * Never throws — a blocked/failed AI pass returns null so the document is still
 * stored and simply falls back to generic handling.
 */
import { generateObject, glaze, z, GlazeAIError } from "@glaze/core/ai";
import { logger } from "@glaze/core/backend";

import type { NewContractNote } from "./database.js";

const MAX_AI_CHARS = 12000;

const ISO_HEAD = /^\d{4}-\d{2}-\d{2}/;
const isoOrNull = (v: string | null): string | null => {
  const t = v?.trim();
  return t && ISO_HEAD.test(t) ? t.slice(0, 10) : null;
};

const numOrNull = (v: number | null): number | null => (v != null && Number.isFinite(v) ? v : null);

const schema = z.object({
  broker: z
    .string()
    .nullable()
    .describe("The broker / trading member name, e.g. 'Paytm Money Limited'."),
  client: z.string().nullable().describe("The client / account holder's name exactly as printed."),
  tradeDate: z
    .string()
    .nullable()
    .describe("The trade date as YYYY-MM-DD (convert from any format shown)."),
  settlementDate: z
    .string()
    .nullable()
    .describe("The settlement date as YYYY-MM-DD, or null if absent."),
  contractNoteNumber: z
    .string()
    .nullable()
    .describe("The contract note number / reference number."),
  netAmount: z
    .number()
    .nullable()
    .describe(
      "The NET AMOUNT PAYABLE/RECEIVABLE BY CLIENT as a plain positive number in INR (e.g. 18654.68). " +
        "Use the final net obligation, not brokerage or a single line.",
    ),
  totalCharges: z
    .number()
    .nullable()
    .describe(
      "Total brokerage + taxes + statutory charges (STT, GST, stamp duty), as a plain number, or null.",
    ),
  trades: z
    .array(
      z.object({
        securityName: z
          .string()
          .describe("Security / company name as printed (e.g. 'Gujarat Mineral Development')."),
        symbol: z.string().nullable().describe("Trading symbol / scrip code if shown, else null."),
        isin: z.string().nullable().describe("ISIN if shown (e.g. 'INE131A01031'), else null."),
        side: z.enum(["buy", "sell"]).describe("Whether this line item was bought or sold."),
        quantity: z.number().nullable().describe("Quantity of shares traded."),
        price: z.number().nullable().describe("Price per share (weighted average) if shown."),
        netAmount: z
          .number()
          .nullable()
          .describe("Net value for this security line, as a plain number."),
      }),
    )
    .describe(
      "One entry per traded security. Deduplicate securities traded across multiple orders into a single line where possible.",
    ),
});

/**
 * Extract a broker contract note's structured fields into a persistable shape.
 * Returns null when the AI is blocked or the document doesn't parse as a note.
 */
export async function extractContractNote(
  text: string,
  filename: string,
  docId: number,
): Promise<NewContractNote | null> {
  const excerpt = text.slice(0, MAX_AI_CHARS).trim();
  if (!excerpt) return null;

  try {
    const { object } = await generateObject({
      model: glaze("fast"),
      schema,
      system:
        "You extract structured trade data from a stock-broker contract note (a securities trade confirmation, " +
        "often titled 'Contract Note cum Tax Invoice'). Read only what is present — never invent securities, " +
        "quantities, prices, ISINs, or amounts. Convert all dates to YYYY-MM-DD. Report amounts as plain positive " +
        "numbers without currency symbols or separators.",
      prompt: `Extract the contract note fields and every traded security from this document named "${filename}":\n\n${excerpt}`,
    });

    const parsed = object as z.infer<typeof schema>;
    const trades = parsed.trades
      .map((t) => ({
        securityName: t.securityName?.trim() ?? "",
        symbol: t.symbol?.trim() || null,
        isin: t.isin?.trim() || null,
        side: t.side === "sell" ? ("sell" as const) : ("buy" as const),
        quantity: numOrNull(t.quantity),
        price: numOrNull(t.price),
        netAmount: numOrNull(t.netAmount),
      }))
      .filter((t) => t.securityName.length > 0);

    if (trades.length === 0) return null;

    const buys = trades.filter((t) => t.side === "buy").length;
    const sells = trades.length - buys;
    const side: NewContractNote["side"] = sells === 0 ? "buy" : buys === 0 ? "sell" : "mixed";

    return {
      docId,
      broker: object.broker?.trim() || null,
      client: object.client?.trim() || null,
      tradeDate: isoOrNull(object.tradeDate),
      settlementDate: isoOrNull(object.settlementDate),
      contractNoteNumber: object.contractNoteNumber?.trim() || null,
      netAmount:
        numOrNull(object.netAmount) != null ? Math.abs(numOrNull(object.netAmount)!) : null,
      totalCharges: numOrNull(object.totalCharges),
      side,
      trades,
    };
  } catch (error) {
    if (error instanceof GlazeAIError) {
      logger.info("contract-note", "AI contract-note extraction blocked", {
        filename,
        state: error.state,
      });
    } else {
      logger.warn("contract-note", "AI contract-note extraction failed", {
        filename,
        error: String(error),
      });
    }
    return null;
  }
}

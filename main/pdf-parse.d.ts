// Minimal ambient types for the pdf-parse library's lib entrypoint.
// We import the lib file directly to avoid the package's debug harness
// (index.js reads a bundled test PDF when run as the main module).
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PDFParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    version: string;
  }
  function pdf(dataBuffer: Buffer | Uint8Array): Promise<PDFParseResult>;
  export default pdf;
}

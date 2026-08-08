/**
 * Ports — the daemon's dependency-inversion boundary (plan §1, layer 2).
 *
 * The domain core and pipeline depend on these interfaces, never on Glaze,
 * Electron, or any host. That's what makes the same services runnable from a
 * daemon, a CLI, a test harness, or (later) a Flutter-backed host.
 */

export interface Logger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  debug(msg: string, meta?: unknown): void;
}

export interface Clock {
  now(): Date;
  isoNow(): string;
}

export interface Paths {
  vaultRoot(): string;
  rawDir(dateKey: string): string;
  markdownDir(dateKey: string): string;
  dbPath(): string;
}

/** P1 conversion port. Implemented by anydoc; swappable for OCR or a stub. */
export interface Converter {
  /** Convert a file to canonical markdown v1. Never throws — returns null on failure. */
  toMarkdown(filePath: string, ext: string): Promise<string | null>;
}

/** Domain events published on the bus and streamed to clients over SSE. */
export type DomainEvent =
  | { type: "DocumentReceived"; document_id: string; filename: string; sha256: string; at: string }
  | { type: "DocumentDuplicate"; sha256: string; filename: string; existing_document_id: string; at: string }
  | { type: "MarkdownReady"; document_id: string; markdown_path: string; chars: number; at: string }
  | { type: "AnalysisComplete"; document_id: string; extraction_version: number; at: string }
  | { type: "TransactionRecorded"; transaction_id: string; direction: string; amount_minor: number; at: string }
  | { type: "MatchProposed"; transaction_id: string; document_id: string; score: number; at: string }
  | { type: "JobStateChanged"; job_id: number; phase: string; state: string; at: string }
  | { type: "BatchFinished"; processed: number; at: string };

export interface EventBus {
  publish(e: DomainEvent): void;
  subscribe(fn: (e: DomainEvent) => void): () => void;
  /** Events published so far this process, newest last. For late subscribers. */
  recent(limit?: number): DomainEvent[];
}

export interface Ports {
  logger: Logger;
  clock: Clock;
  paths: Paths;
  converter: Converter;
  bus: EventBus;
}

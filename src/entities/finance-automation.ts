export type FinancialRiskKind =
  | "payment_due"
  | "invoice_missing"
  | "cash_gap"
  | "budget_overrun"
  | "forecast_stale"
  | "undated_payment";
export interface FinancialRiskSnapshot {
  kind: FinancialRiskKind;
  title: string;
  detail: string;
  entryId?: string;
  date?: string;
  amountCents?: number;
}
export interface FinancialRiskReview {
  riskId: string;
  ownerId?: string;
  nextAction?: string;
  actionDueDate?: string;
  acknowledged?: boolean;
  snoozedUntil?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  resolvedAt?: string;
  snapshot?: FinancialRiskSnapshot;
  history?: {
    at: string;
    by: string;
    action: "observed" | "reviewed" | "resolved" | "reopened";
    note: string;
  }[];
}
export interface FinanceAutomationState {
  version: 1;
  reviews: FinancialRiskReview[];
}
export interface DocumentRecognitionEvidence {
  sha256: string;
  method: "pdf_text" | "image_ocr" | "mixed_pdf";
  confidence: number | null;
  reviewed: true;
  pageCount: number;
  amountCents?: number;
}
export interface VerifiedDocumentMetadata {
  number?: string;
  documentDate?: string;
  sourceSha256: string;
  recognition: DocumentRecognitionEvidence;
}

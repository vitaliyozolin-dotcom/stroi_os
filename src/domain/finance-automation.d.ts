import type {
  FinanceAutomationState,
  FinancialRiskReview,
  FinancialRiskKind,
} from "../entities/index";
import type { TreasuryProject } from "./treasury.js";
export interface FinancialSignal {
  id: string;
  kind: FinancialRiskKind;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  action: string;
  entryId?: string;
  date?: string;
  amountCents?: number;
}
export interface FinancialInboxRow extends FinancialSignal {
  review?: FinancialRiskReview;
  state: "active" | "acknowledged" | "snoozed" | "resolved";
  responsible: string;
}
export interface FinanceAutomationProject extends TreasuryProject {
  financeAutomation?: FinanceAutomationState;
  documents?: {
    category?: string;
    fileKey?: string;
    financeEntryId?: string;
  }[];
  settings?: {
    users: { id: string; name: string; role: string; status?: string }[];
  };
}
export function emptyFinanceAutomation(): FinanceAutomationState;
export function financialRiskSignals(
  state: FinanceAutomationProject,
  options: { today: string; role?: string },
): FinancialSignal[];
export function financialRiskInbox(
  state: FinanceAutomationProject,
  options: { today: string; role?: string },
): FinancialInboxRow[];
export function validateFinanceAutomationChanges(
  previous: FinanceAutomationProject | null,
  next: FinanceAutomationProject,
  identity: { role: string; name?: string; id?: string },
  now?: string,
): string;

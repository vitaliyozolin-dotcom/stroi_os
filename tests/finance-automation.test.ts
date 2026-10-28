import test from "node:test";
import assert from "node:assert/strict";
import { emptyTreasury } from "../src/domain/treasury.js";
import {
  financialRiskSignals,
  financialRiskInbox,
  validateFinanceAutomationChanges,
  type FinanceAutomationProject,
} from "../src/domain/finance-automation.js";
import {
  financeAutomationSnapshot,
  createFinanceAutomationUseCases,
} from "../src/application/finance-automation.ts";
const today = "2026-10-28",
  now = `${today}T12:00:00Z`,
  owner = { role: "management" as const, name: "Owner" };
const fixture = (): FinanceAutomationProject => ({
  project: { id: "p" },
  settings: {
    users: [
      { id: "owner", name: "Owner", role: "management", status: "active" },
    ],
  },
  documents: [],
  stages: [],
  tasks: [],
  budgetLines: [],
  financeEntries: [
    {
      id: "e",
      kind: "expense",
      amount: 100,
      description: "Materials",
      dueDate: "2026-10-29",
    },
  ],
  treasury: {
    ...emptyTreasury(),
    enabled: true,
    accounts: [
      {
        id: "bank",
        name: "Bank",
        legalEntityId: "company",
        currency: "RUB",
        isProjectDedicated: true,
        opening: {
          asOf: today,
          amountCents: 0,
          confirmed: true,
          source: "Statement",
        },
      },
    ],
    entryPlans: [
      {
        entryId: "e",
        sourceAccountId: "bank",
        cashTreatment: "account",
        source: "Contract",
        tranches: [],
      },
    ],
    costEstimates: [
      {
        id: "all",
        name: "All",
        recognizedCents: 0,
        remainingWorkCents: 20000,
        otherRemainingCents: 0,
        stockToConsumeCents: 0,
        approvedBudgetCents: 10000,
        source: "Estimate",
      },
    ],
  },
});
const tracked = () => {
  const state = fixture(),
    next = structuredClone(state);
  next.financeAutomation = {
    version: 1,
    reviews: [
      {
        riskId: "invoice:e",
        ownerId: "owner",
        nextAction: "Request original",
        acknowledged: true,
        snoozedUntil: "2026-10-30",
      },
    ],
  };
  assert.equal(validateFinanceAutomationChanges(state, next, owner, now), "");
  return next;
};
test("financial risks are derived, deduplicated and private without rewriting any source", () => {
  const state = fixture(),
    before = structuredClone(state),
    signals = financialRiskSignals(state, { today });
  for (const kind of [
    "payment_due",
    "invoice_missing",
    "cash_gap",
    "budget_overrun",
    "forecast_stale",
  ])
    assert.ok(
      signals.some((row) => row.kind === kind),
      kind,
    );
  assert.equal(new Set(signals.map((row) => row.id)).size, signals.length);
  assert.deepEqual(financialRiskSignals(state, { today }), signals);
  assert.deepEqual(financialRiskSignals(state, { today, role: "foreman" }), []);
  assert.deepEqual(
    financialRiskInbox(
      { ...state, financeAutomation: tracked().financeAutomation },
      { today, role: "client" },
    ),
    [],
  );
  assert.deepEqual(state, before);
  state.documents = [{ category: "invoice", financeEntryId: "e" }];
  assert.ok(
    financialRiskSignals(state, { today }).some(
      (row) => row.kind === "invoice_missing",
    ),
    "text-only original does not clear risk",
  );
  state.documents[0].fileKey = "p/invoice.pdf";
  assert.ok(
    !financialRiskSignals(state, { today }).some(
      (row) => row.kind === "invoice_missing",
    ),
  );
});
test("acknowledgement and snooze never resolve a risk; resolved conditions reopen on recurrence", () => {
  const state = tracked();
  assert.equal(
    financialRiskInbox(state, { today }).find((row) => row.id === "invoice:e")
      ?.state,
    "snoozed",
  );
  assert.equal(
    financialRiskInbox(state, { today: "2026-10-30" }).find(
      (row) => row.id === "invoice:e",
    )?.state,
    "acknowledged",
  );
  const next = structuredClone(state);
  next.documents = [
    { category: "invoice", financeEntryId: "e", fileKey: "p/invoice.pdf" },
  ];
  assert.equal(
    validateFinanceAutomationChanges(
      state,
      next,
      owner,
      "2026-10-31T12:00:00Z",
    ),
    "",
    "expired snooze cannot block unrelated saves",
  );
  assert.equal(
    next.financeAutomation!.reviews[0].resolvedAt,
    "2026-10-31T12:00:00Z",
  );
  assert.equal(
    financialRiskInbox(next, { today: "2026-10-31" }).find(
      (row) => row.id === "invoice:e",
    )?.state,
    "resolved",
  );
  const recurrent = structuredClone(next);
  recurrent.documents = [];
  assert.equal(
    financialRiskInbox(recurrent, { today: "2026-10-31" }).find(
      (row) => row.id === "invoice:e",
    )?.state,
    "active",
  );
  assert.equal(
    validateFinanceAutomationChanges(
      next,
      recurrent,
      owner,
      "2026-10-31T13:00:00Z",
    ),
    "",
  );
  const review = recurrent.financeAutomation!.reviews[0];
  assert.equal(review.acknowledged, false);
  assert.equal(review.snoozedUntil, undefined);
  assert.equal(review.resolvedAt, undefined);
  assert.deepEqual(
    review.history!.map((row) => row.action),
    ["observed", "reviewed", "resolved", "reopened"],
  );
});
test("reviews reject forged history, record deletion, invalid owner and arbitrary hiding of live risks", () => {
  const state = tracked();
  for (const mutate of [
    (next: FinanceAutomationProject) =>
      next.financeAutomation!.reviews.splice(0),
    (next: FinanceAutomationProject) => {
      next.financeAutomation!.reviews[0].resolvedAt = now;
    },
    (next: FinanceAutomationProject) => {
      next.financeAutomation!.reviews[0].history = [];
    },
    (next: FinanceAutomationProject) => {
      next.financeAutomation!.reviews[0].ownerId = "unknown";
    },
    (next: FinanceAutomationProject) => {
      next.financeAutomation!.reviews[0].snoozedUntil = "2027-01-01";
    },
  ]) {
    const next = structuredClone(state);
    mutate(next);
    assert.ok(validateFinanceAutomationChanges(state, next, owner, now));
  }
  const next = structuredClone(state);
  next.financeAutomation!.reviews[0].nextAction = "Other action";
  assert.match(
    validateFinanceAutomationChanges(state, next, { role: "foreman" }, now),
    /управление/,
  );
  assert.deepEqual(next.financeEntries, state.financeEntries);
  state.settings!.users[0].status = "disabled";
  const unchanged = structuredClone(state);
  assert.equal(
    validateFinanceAutomationChanges(state, unchanged, owner, now),
    "",
    "previously assigned disabled owner does not block finance writes",
  );
});
test("undated and overdue events stay visible; payment deadlines do not silently become dates of documents", () => {
  const state = fixture();
  delete state.financeEntries[0].dueDate;
  assert.ok(
    financialRiskSignals(state, { today }).some(
      (row) => row.kind === "undated_payment",
    ),
  );
  state.financeEntries[0].dueDate = "2026-10-27";
  const row = financialRiskSignals(state, { today }).find(
    (row) => row.kind === "payment_due",
  );
  assert.equal(row?.severity, "high");
  assert.match(row!.detail, /срок/);
});
test("review command uses scoped compare-and-swap and does not commit a stale edit or forbidden role", () => {
  const state = fixture(),
    expected = financeAutomationSnapshot(state),
    repository = {
      read: () => ({ ok: true as const, snapshot: state }),
      commit: () => {
        assert.fail("must not write");
        return { ok: true as const };
      },
    };
  state.financeEntries[0].amount = 200;
  assert.match(
    createFinanceAutomationUseCases(repository, owner).save({
      expected,
      today,
      riskId: "invoice:e",
      review: { nextAction: "Check" },
    }).error!,
    /обновились/,
  );
  assert.match(
    createFinanceAutomationUseCases(repository, {
      name: "Foreman",
      role: "foreman",
    }).save({ expected: financeAutomationSnapshot(state), today }).error!,
    /управлению/,
  );
});

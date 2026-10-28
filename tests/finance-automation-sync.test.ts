import test from "node:test";
import assert from "node:assert/strict";
import { seedState } from "../src/seed.ts";
import {
  applyLocalChange,
  createSyncModel,
  reconcileSavedSnapshot,
} from "../src/application/project-sync.ts";
import { validateFinanceAutomationChanges } from "../src/domain/finance-automation.js";
const now = "2026-10-28T12:00:00Z";
const fixture = () => {
  const state = structuredClone(seedState);
  state.treasury = undefined;
  state.documents = [];
  state.financeEntries = [
    {
      id: "e",
      kind: "expense",
      amount: 100,
      status: "committed",
      date: "2026-10-28",
      dueDate: "2026-10-28",
      description: "Materials",
      counterparty: "Supplier",
    },
  ];
  state.financeAutomation = {
    version: 1,
    reviews: [
      {
        riskId: "invoice:e",
        acknowledged: true,
        snoozedUntil: "2026-10-29",
        nextAction: "Old action",
        firstSeenAt: "2026-10-25T12:00:00Z",
        lastSeenAt: "2026-10-25T12:00:00Z",
        resolvedAt: "2026-10-26T12:00:00Z",
        snapshot: {
          kind: "invoice_missing",
          title: "Earlier title",
          detail: "Earlier details",
        },
        history: [],
      },
    ],
  };
  return state;
};
test("server recurrence receipts acknowledge new snapshots and reset old snooze while preserving an in-flight action", () => {
  const sent = fixture(),
    server = structuredClone(sent);
  assert.equal(
    validateFinanceAutomationChanges(
      sent,
      server,
      { name: "Owner", role: "management" },
      now,
    ),
    "",
  );
  const model = createSyncModel({ state: sent, revision: 1 }, false, true),
    pending = structuredClone(sent);
  pending.financeAutomation!.reviews[0].nextAction = "New action while saving";
  const result = reconcileSavedSnapshot(
      applyLocalChange(model, pending),
      sent,
      { state: server, revision: 2 },
    ),
    review = result.state.financeAutomation!.reviews[0];
  assert.equal(review.nextAction, "New action while saving");
  assert.equal(review.acknowledged, false);
  assert.equal(review.snoozedUntil, undefined);
  assert.equal(review.resolvedAt, undefined);
  assert.deepEqual(
    review.snapshot,
    server.financeAutomation!.reviews[0].snapshot,
  );
  assert.deepEqual(
    review.history,
    server.financeAutomation!.reviews[0].history,
  );
  assert.equal(
    validateFinanceAutomationChanges(
      server,
      structuredClone(result.state),
      { name: "Owner", role: "management" },
      "2026-10-28T12:01:00Z",
    ),
    "",
    "next save accepts trusted stamps",
  );
});
test("acknowledgement receipt preserves a newer locally changed snooze instead of restoring its submitted value", () => {
  const sent = fixture(),
    server = structuredClone(sent);
  assert.equal(
    validateFinanceAutomationChanges(
      sent,
      server,
      { name: "Owner", role: "management" },
      now,
    ),
    "",
  );
  const model = createSyncModel({ state: sent, revision: 1 }, false, true),
    pending = structuredClone(sent);
  pending.financeAutomation!.reviews[0].snoozedUntil = "2026-10-30";
  pending.financeAutomation!.reviews[0].nextAction = "Contact owner tomorrow";
  const result = reconcileSavedSnapshot(
    applyLocalChange(model, pending),
    sent,
    { state: server, revision: 2 },
  );
  assert.equal(
    result.state.financeAutomation!.reviews[0].snoozedUntil,
    "2026-10-30",
  );
  assert.equal(
    result.state.financeAutomation!.reviews[0].nextAction,
    "Contact owner tomorrow",
  );
  assert.deepEqual(
    result.state.financeAutomation!.reviews[0].snapshot,
    server.financeAutomation!.reviews[0].snapshot,
  );
});

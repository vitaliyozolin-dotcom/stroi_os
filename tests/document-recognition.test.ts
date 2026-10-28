import test from "node:test";
import assert from "node:assert/strict";
import {
  extractFinancialDocument,
  parseRecognitionAmount,
  suggestDocumentLinks,
} from "../src/domain/document-recognition.ts";
import { seedState } from "../src/seed.ts";
import { attachFinanceDocument } from "../src/application/finance-context-facts.ts";
import {
  financeFactsSnapshot,
  applyFinanceFactsResult,
} from "../src/infrastructure/finance-project.ts";
import { recognitionAssetFiles } from "../scripts/recognition-assets.mjs";
import { stat } from "node:fs/promises";
const hash = "a".repeat(64),
  meta = {
    sha256: hash,
    method: "pdf_text" as const,
    confidence: null,
    pageCount: 1,
  };
const invoice =
  "Счёт № АБ-45/2 от 28.10.2026\nПоставщик: ООО Стройматериалы ИНН 1234567890\nИтого: 10 000,00 руб.\nВсего к оплате: 12 345,67 руб.";
test("extracts Russian totals in integer kopecks, invoice date/number and counterparty with source evidence", () => {
  const result = extractFinancialDocument(invoice, meta);
  assert.equal(result.amount?.value, 1234567);
  assert.equal(result.number?.value, "АБ-45/2");
  assert.equal(result.date?.value, "2026-10-28");
  assert.equal(result.counterparty?.value, "ООО Стройматериалы");
  assert.match(result.amount!.evidence, /Всего к оплате/);
  assert.equal(result.amount?.confidence, "high");
  assert.equal(result.sha256, hash);
  assert.equal(
    extractFinancialDocument("Итого: 1000,25", meta).amount?.value,
    100025,
  );
  assert.equal(
    extractFinancialDocument("от 28.10.2026\nИтого 1000", meta).date?.value,
    "2026-10-28",
  );
  for (const [value, expected] of [
    ["1\u00a0234,56", 123456],
    ["100.5", 10050],
    ["0", 0],
    ["1000 ₽", 100000],
  ] as const)
    assert.equal(parseRecognitionAmount(value), expected);
  for (const invalid of [
    "-1",
    "1e3",
    "1,234.56",
    "10,001",
    "Infinity",
    "100foo",
  ])
    assert.equal(parseRecognitionAmount(invalid), null);
});
test("ambiguous totals/dates and low OCR confidence require review, invalid calendar dates are ignored", () => {
  const result = extractFinancialDocument(
    "Счёт № 25 от 28.10.2026\nДата оплаты 30.10.2026\nИтого к оплате 1000,00\nИтого к оплате 1200,00",
    { ...meta, method: "image_ocr", confidence: 62 },
  );
  assert.equal(result.amount?.confidence, "low");
  assert.deepEqual(result.amount?.alternatives, [120000]);
  assert.equal(result.date?.confidence, "low");
  assert.deepEqual(result.date?.alternatives, ["2026-10-30"]);
  assert.equal(result.warnings.length, 3);
  assert.equal(
    extractFinancialDocument("Дата: 31.02.2026", meta).date,
    undefined,
  );
  assert.ok(extractFinancialDocument("", meta).warnings.length >= 2);
});
test("duplicate and linkage suggestions are read-only and never invent an obligation", () => {
  const state = structuredClone(seedState);
  state.documents = [
    {
      id: "old",
      name: "Исходный счёт",
      type: "Счёт",
      status: "current",
      updatedAt: "2026-10-28",
      clientVisible: false,
      sourceSha256: hash,
      number: "АБ-45/2",
      documentDate: "2026-10-28",
    },
  ];
  state.financeEntries = [
    {
      id: "expense",
      kind: "expense",
      status: "committed",
      amount: 12345.67,
      date: "2026-10-28",
      description: "Материалы",
      counterparty: "ООО Стройматериалы",
    },
  ];
  const before = structuredClone(state),
    result = extractFinancialDocument(invoice, meta);
  const links = suggestDocumentLinks(result, state);
  assert.equal(links.duplicates[0].exact, true);
  assert.equal(links.entries[0].id, "expense");
  assert.deepEqual(state, before);
  assert.equal(
    suggestDocumentLinks({ ...result, sha256: "b".repeat(64) }, state)
      .duplicates[0].exact,
    false,
  );
});
test("only manually reviewed metadata attaches, keeping all financial facts immutable", () => {
  const state = structuredClone(seedState);
  state.project.id = "ocr-project";
  state.documents = [];
  state.financeEntries = [
    {
      id: "expense",
      kind: "expense",
      status: "committed",
      amount: 100,
      date: "2026-10-28",
      description: "Materials",
      counterparty: "Supplier",
    },
  ];
  const ctx = {
    identity: { name: "Owner", role: "management" as const },
    clock: { now: () => "2026-10-28T12:00:00Z" },
    ids: { next: () => "document-ocr" },
  };
  const metadata = {
    number: "45",
    documentDate: "2026-10-28",
    sourceSha256: hash,
    recognition: { ...meta, reviewed: true as const, amountCents: 1234567 },
  };
  const input = {
    entryId: "expense",
    category: "invoice" as const,
    document: "Счёт №45",
    uploadedFile: {
      key: "ocr-project/invoice.png",
      name: "invoice.png",
      type: "image/png",
      size: 12345,
      uploadedAt: "2026-10-28T12:00:00Z",
    },
    metadata,
  };
  const before = structuredClone(state),
    result = attachFinanceDocument(financeFactsSnapshot(state), input, ctx),
    applied = applyFinanceFactsResult(state, result);
  assert.ok(applied.ok && applied.change);
  if (!applied.ok || !applied.change) return;
  const next = applied.change.state;
  assert.equal(next.documents[0].recognition?.amountCents, 1234567);
  assert.equal(next.documents[0].number, "45");
  assert.deepEqual(next.financeEntries, before.financeEntries);
  assert.equal(next.financeEntries[0].paidAmount, undefined);
  assert.equal(state.documents.length, 0);
  assert.deepEqual(
    attachFinanceDocument(financeFactsSnapshot(next), input, ctx),
    { ok: true, change: null },
  );
  for (const bad of [
    { ...metadata, documentDate: "2026-02-30" },
    { ...metadata, sourceSha256: "bad" },
    { ...metadata, recognition: { ...metadata.recognition, reviewed: false } },
  ])
    assert.equal(
      attachFinanceDocument(
        financeFactsSnapshot(state),
        { ...input, metadata: bad as typeof metadata },
        ctx,
      ).ok,
      false,
    );
});
test("OCR, Russian/English models and PDF workers/fonts are real packaged local assets", async () => {
  const files = await recognitionAssetFiles(process.cwd());
  for (const name of [
    "worker.min.js",
    "lang/rus.traineddata.gz",
    "lang/eng.traineddata.gz",
    "pdf.worker.min.mjs",
    "core/tesseract-core-lstm.wasm.js",
  ])
    assert.ok((await stat(files.get(name)!)).size > 1000, name);
  assert.ok(
    [...files.keys()].some((name) => name.startsWith("pdf/standard_fonts/")),
  );
  assert.ok([...files.keys()].some((name) => name.startsWith("pdf/cmaps/")));
});

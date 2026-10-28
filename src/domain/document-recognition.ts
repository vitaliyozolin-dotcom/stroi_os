import type {
  FinanceEntry,
  ProjectDocument,
  Stage,
} from "../entities/index.ts";
export interface RecognitionSuggestion<T> {
  value: T;
  evidence: string;
  confidence: "high" | "medium" | "low";
  alternatives?: T[];
}
export interface RecognitionResult {
  text: string;
  sha256: string;
  method: "pdf_text" | "image_ocr" | "mixed_pdf";
  confidence: number | null;
  pageCount: number;
  amount?: RecognitionSuggestion<number>;
  date?: RecognitionSuggestion<string>;
  number?: RecognitionSuggestion<string>;
  counterparty?: RecognitionSuggestion<string>;
  warnings: string[];
}
const norm = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export function parseRecognitionAmount(value: string): number | null {
  const cleaned = norm(value)
    .replace(/(?:₽|руб\.?|р\.|RUB)/gi, "")
    .trim();
  if (!/^\d[\d\s]*(?:[.,]\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.replace(/\s/g, "").split(/[.,]/);
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}
const isoDate = (value: string) => {
  const parts = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!parts) return null;
  const result = `${parts[3]}-${parts[2].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
  return new Date(`${result}T12:00:00Z`).toISOString().slice(0, 10) === result
    ? result
    : null;
};
export function extractFinancialDocument(
  text: string,
  meta: Pick<
    RecognitionResult,
    "sha256" | "method" | "confidence" | "pageCount"
  >,
): RecognitionResult {
  const lines = text.split(/\r?\n/).map(norm).filter(Boolean),
    result: RecognitionResult = {
      ...meta,
      text: text.slice(0, 200000),
      warnings: [],
    };
  const amounts: { value: number; evidence: string; rank: number }[] = [];
  for (const line of lines) {
    const rank =
      /(?:всего\s+к\s+оплате|итого\s+к\s+оплате|total\s+(?:due|amount)|сумма\s+платежа|к\s+оплате)/i.test(
        line,
      )
        ? 3
        : /^(?:итого|всего|total)(?:\s|:|$)/i.test(line)
          ? 2
          : 0;
    if (rank) {
      const matches = [
        ...line.matchAll(
          /\d[\d\s]*(?:[.,]\d{1,2})?(?=\s*(?:₽|руб|р\.|RUB|$))/gi,
        ),
      ];
      for (const match of matches) {
        const value = parseRecognitionAmount(match[0]);
        if (value !== null && value > 0)
          amounts.push({ value, evidence: line.slice(0, 500), rank });
      }
    }
  }
  const strongest = Math.max(0, ...amounts.map((row) => row.rank)),
    totals = amounts.filter((row) => row.rank === strongest),
    values = [...new Set(totals.map((row) => row.value))];
  if (values.length)
    result.amount = {
      value: values[0],
      evidence: totals[0].evidence,
      confidence:
        values.length > 1 || (meta.confidence !== null && meta.confidence < 75)
          ? "low"
          : "high",
      ...(values.length > 1 ? { alternatives: values.slice(1) } : {}),
    };
  if (values.length > 1)
    result.warnings.push(
      "Найдены разные итоговые суммы. Выберите сумму по оригиналу.",
    );
  if (!values.length)
    result.warnings.push("Итоговая сумма не найдена однозначно.");
  const heading = lines.find((line) =>
    /(?:сч[её]т|invoice|акт|плат[её]жн)/i.test(line),
  );
  if (heading) {
    const number = heading.match(
      /(?:№|No\.?|N[ .])\s*([\p{L}\d][\p{L}\d/_-]{0,59})/iu,
    );
    if (number)
      result.number = {
        value: number[1],
        evidence: heading.slice(0, 500),
        confidence:
          meta.confidence !== null && meta.confidence < 75 ? "low" : "medium",
      };
  }
  const dates: { value: string; evidence: string }[] = [];
  for (const line of lines.filter((line) =>
    /(?:(?:^|\s)от(?:\s|$)|дата|date|invoice|сч[её]т)/i.test(line),
  )) {
    for (const match of line.matchAll(/\b\d{1,2}[./-]\d{1,2}[./-]\d{4}\b/g)) {
      try {
        const value = isoDate(match[0]);
        if (value) dates.push({ value, evidence: line.slice(0, 500) });
      } catch {}
    }
  }
  const uniqueDates = [...new Set(dates.map((row) => row.value))];
  if (uniqueDates.length)
    result.date = {
      value: uniqueDates[0],
      evidence: dates[0].evidence,
      confidence: uniqueDates.length > 1 ? "low" : "medium",
      ...(uniqueDates.length > 1 ? { alternatives: uniqueDates.slice(1) } : {}),
    };
  if (uniqueDates.length > 1)
    result.warnings.push(
      "В документе несколько дат. Дата документа и срок оплаты могут различаться.",
    );
  const supplier = lines.find((line) =>
    /^(?:поставщик|получатель|исполнитель|продавец|supplier|beneficiary)\s*[:：]/i.test(
      line,
    ),
  );
  if (supplier) {
    const value = supplier
      .replace(/^[^:：]+[:：]\s*/, "")
      .split(/\s+(?:ИНН|КПП|р\/с|БИК)(?:\s|:|$)/i)[0]
      .trim();
    if (value)
      result.counterparty = {
        value: value.slice(0, 250),
        evidence: supplier.slice(0, 500),
        confidence: "medium",
      };
  }
  if (meta.confidence !== null && meta.confidence < 75)
    result.warnings.push(
      "Низкая уверенность распознавания. Проверьте реквизиты по оригиналу.",
    );
  if (!text.trim())
    result.warnings.push("Текст не распознан. Попробуйте более чёткий файл.");
  return result;
}
const tokens = (value: string) =>
  new Set(
    norm(value)
      .toLocaleLowerCase("ru")
      .replace(/[^\p{L}\d ]/gu, " ")
      .split(/\s+/)
      .filter((part) => part.length > 2),
  );
const similarity = (a: string, b: string) => {
  const first = tokens(a),
    second = tokens(b);
  return first.size && second.size
    ? [...first].filter((value) => second.has(value)).length /
        Math.min(first.size, second.size)
    : 0;
};
export function suggestDocumentLinks(
  result: RecognitionResult,
  context: {
    financeEntries: FinanceEntry[];
    documents: ProjectDocument[];
    stages: Stage[];
  },
) {
  const duplicates = context.documents.flatMap((document) => {
    const exact = document.sourceSha256 === result.sha256;
    const number =
      result.number?.value &&
      document.number?.toLocaleLowerCase("ru") ===
        result.number.value.toLocaleLowerCase("ru");
    return exact || (number && result.date?.value === document.documentDate)
      ? [
          {
            id: document.id,
            name: document.name,
            exact,
            reason: exact
              ? "Совпадает содержимое файла"
              : "Совпадают номер и дата; проверьте контрагента",
          },
        ]
      : [];
  });
  const entries = context.financeEntries
    .flatMap((entry) => {
      const amount = result.amount?.value;
      const amountMatch =
        amount !== undefined && Math.round(entry.amount * 100) === amount;
      const party = similarity(
        result.counterparty?.value ?? "",
        entry.counterparty,
      );
      const wording = similarity(result.text, entry.description);
      const score =
        (amountMatch ? 3 : 0) +
        (party >= 0.6 ? 3 : 0) +
        (wording >= 0.65 ? 1 : 0);
      return score >= 3
        ? [
            {
              id: entry.id,
              title: entry.description,
              score,
              reason: [
                amountMatch ? "Совпадает сумма" : "",
                party >= 0.6 ? "Похож контрагент" : "",
                wording >= 0.65 ? "Похоже назначение" : "",
              ]
                .filter(Boolean)
                .join(" · "),
              stageId: entry.stageId,
            },
          ]
        : [];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return { duplicates, entries };
}

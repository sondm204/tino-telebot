export type ParsedExpense = {
  title: string;
  amount: number;
};

const AMOUNT_PATTERN =
  /^(.*?)\s+(\d[\d.,]*)(?:\s*)(k|nghìn|nghin|ngàn|ngan|tr|triệu|trieu|m)?$/iu;

function parseNumericAmount(raw: string, suffix?: string) {
  const normalizedSuffix = suffix?.toLocaleLowerCase('vi-VN');
  const multiplier =
    normalizedSuffix === 'k' ||
    normalizedSuffix === 'nghìn' ||
    normalizedSuffix === 'nghin' ||
    normalizedSuffix === 'ngàn' ||
    normalizedSuffix === 'ngan'
      ? 1_000
      : normalizedSuffix === 'tr' ||
          normalizedSuffix === 'triệu' ||
          normalizedSuffix === 'trieu' ||
          normalizedSuffix === 'm'
        ? 1_000_000
        : 1;
  let normalized: string;

  if (multiplier > 1) {
    normalized = raw.replace(',', '.');
    if ((normalized.match(/\./g)?.length ?? 0) > 1) {
      normalized = normalized.replace(/\./g, '');
    }
  } else {
    normalized = raw.replace(/[.,]/g, '');
  }

  const value = Number(normalized) * multiplier;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function parseExpenseMessage(text: string): ParsedExpense | null {
  const match = text.trim().match(AMOUNT_PATTERN);
  if (!match) return null;

  const title = match[1]?.trim().replace(/[,:;-]+$/, '').trim();
  const amount = parseNumericAmount(match[2], match[3]);
  return title && amount ? { title, amount } : null;
}

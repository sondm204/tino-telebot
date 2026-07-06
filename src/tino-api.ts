import { config } from './config.js';

type ApiResponse<T> = {
  message: string;
  code: string;
  data: T | null;
};

export class TinoApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

type TelegramIdentity = {
  telegram_user_id: string;
  telegram_username?: string;
  telegram_display_name: string;
};

type Wallet = {
  id: string;
  name: string;
  currency: string;
};

type TelegramContext = {
  wallet: Wallet;
  current_user_id: string;
  members: Array<{ user_id: string; display_name: string }>;
};

type WalletSummary = {
  wallet: Wallet;
  period_start: string;
  period_end: string;
  total_amount: number;
  currency: string;
  member_balances: Array<{
    user_id: string;
    paid: number;
    share: number;
    balance: number;
  }>;
  settlements: Array<{
    from_user_id: string;
    to_user_id: string;
    amount: number;
    currency: string;
  }>;
};

type Expense = {
  id: string;
  title: string;
  total_amount: number;
  currency: string;
  wallet_name: string;
};

type Attachment = {
  id: string;
  file_url: string;
  file_name: string;
  file_type: string;
  file_size: number;
};

async function post<T>(path: string, body: unknown) {
  let response: Response;

  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tino-bot-secret': config.serviceSecret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new TinoApiError(
      'TINO_SERVICE_UNAVAILABLE',
      'Không thể kết nối tới Tino Service',
      503
    );
  }

  const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;

  if (!response.ok || !payload?.data) {
    throw new TinoApiError(
      payload?.code || 'TINO_SERVICE_ERROR',
      payload?.message || 'Tino Service trả về dữ liệu không hợp lệ',
      response.status
    );
  }

  return payload.data;
}

async function postForm<T>(path: string, body: FormData) {
  let response: Response;

  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'x-tino-bot-secret': config.serviceSecret,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new TinoApiError(
      'TINO_SERVICE_UNAVAILABLE',
      'Không thể kết nối tới Tino Service',
      503
    );
  }

  const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;

  if (!response.ok || !payload?.data) {
    throw new TinoApiError(
      payload?.code || 'TINO_SERVICE_ERROR',
      payload?.message || 'Tino Service trả về dữ liệu không hợp lệ',
      response.status
    );
  }

  return payload.data;
}

export const tinoApi = {
  linkAccount(identity: TelegramIdentity, code: string) {
    return post('/bot/telegram/link', { ...identity, code });
  },

  connectChat(
    identity: TelegramIdentity,
    input: {
      code: string;
      telegram_chat_id: string;
      telegram_chat_title?: string;
    }
  ) {
    return post<{ wallet: Wallet }>('/bot/telegram/connect', {
      ...identity,
      ...input,
    });
  },

  getContext(telegramUserId: string, telegramChatId: string) {
    return post<TelegramContext>('/bot/telegram/context', {
      telegram_user_id: telegramUserId,
      telegram_chat_id: telegramChatId,
    });
  },

  getSummary(telegramUserId: string, telegramChatId: string, month: string) {
    return post<WalletSummary>('/bot/telegram/summary', {
      telegram_user_id: telegramUserId,
      telegram_chat_id: telegramChatId,
      month,
    });
  },

  createExpense(input: {
    telegram_user_id: string;
    telegram_chat_id: string;
    title: string;
    total_amount: number;
    expense_date: string;
  }) {
    return post<Expense>('/bot/telegram/expenses', input);
  },

  uploadExpenseAttachment(
    expenseId: string,
    input: {
      telegram_user_id: string;
      telegram_chat_id: string;
      bytes: ArrayBuffer;
      file_name: string;
      content_type: string;
    }
  ) {
    const form = new FormData();
    form.set('telegram_user_id', input.telegram_user_id);
    form.set('telegram_chat_id', input.telegram_chat_id);
    form.set(
      'attachment',
      new Blob([input.bytes], { type: input.content_type }),
      input.file_name
    );

    return postForm<Attachment>(
      `/bot/telegram/expenses/${expenseId}/attachments`,
      form
    );
  },
};

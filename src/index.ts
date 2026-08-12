import { createServer, type IncomingMessage } from 'node:http';
import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import { config } from './config.js';
import { parseExpenseMessage } from './expense-parser.js';
import { tinoApi, TinoApiError } from './tino-api.js';

const bot = new Telegraf(config.botToken);
const EXPENSE_PHOTO_WAIT_MS = 60_000;
const RECEIPT_UPLOAD_WAIT_MS = 120_000;
const SCHEDULED_SUMMARY_CHECK_MS = 60_000;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_PENDING_ATTACHMENTS = 5;
const botTimeZone = process.env.TZ || 'Asia/Bangkok';
const port = Number(process.env.PORT || 4040);
let botReady = false;
let lastWeeklySummaryKey: string | null = null;
let lastMonthlySummaryKey: string | null = null;

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > 32 * 1024) {
      throw new Error('Request body is too large');
    }

    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function isExpenseCreatedPayload(
  value: unknown
): value is ExpenseCreatedNotificationPayload {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'telegram_chat_id' in value &&
      typeof (value as { telegram_chat_id?: unknown }).telegram_chat_id ===
        'string'
  );
}

async function handleExpenseCreatedNotification(
  payload: ExpenseCreatedNotificationPayload
) {
  const amount = Number(payload.total_amount ?? 0);
  const currency = payload.currency || 'VND';
  await bot.telegram.sendMessage(
    String(payload.telegram_chat_id),
    [
      '<b>Khoản chi mới</b>',
      htmlField('Ví', payload.wallet_name || 'Ví'),
      htmlField('Người thêm', payload.actor_name || 'Thành viên'),
      htmlField('Người trả', payload.payer_name || payload.actor_name || 'Thành viên'),
      htmlField('Nội dung', payload.title || 'Khoản chi'),
      htmlField('Số tiền', formatMoney(amount, currency)),
      payload.expense_date ? htmlField('Ngày chi', payload.expense_date) : null,
    ]
      .filter(Boolean)
      .join('\n'),
    { parse_mode: 'HTML' }
  );
}

const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json; charset=utf-8');

  if (request.url === '/health') {
    response.statusCode = botReady ? 200 : 503;
    response.end(
      JSON.stringify({
        status: botReady ? 'ok' : 'starting',
        service: 'tino-telebot',
      })
    );
    return;
  }

  if (request.url === '/internal/telegram/expense-created') {
    if (request.method !== 'POST') {
      response.statusCode = 405;
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    if (request.headers['x-tino-bot-secret'] !== config.serviceSecret) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    void readJsonBody(request)
      .then(async (payload) => {
        if (!isExpenseCreatedPayload(payload)) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'Invalid payload' }));
          return;
        }

        await handleExpenseCreatedNotification(payload);
        response.statusCode = 200;
        response.end(JSON.stringify({ ok: true }));
      })
      .catch((error) => {
        console.error('Could not handle expense notification', error);
        response.statusCode = 500;
        response.end(JSON.stringify({ error: 'Internal server error' }));
      });
    return;
  }

  response.statusCode = 200;
  response.end(
    JSON.stringify({
      service: 'tino-telebot',
      status: botReady ? 'running' : 'starting',
    })
  );
});

type PendingExpenseAttachment = {
  bytes: ArrayBuffer;
  contentType: string;
  fileName: string;
};

type PendingExpense = {
  chatId: string;
  telegramUserId: string;
  title: string;
  amount: number;
  currency: string;
  walletName: string;
  expenseDate: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
  attachments: PendingExpenseAttachment[];
  saving?: boolean;
};

type PendingReceiptScan = {
  chatId: string;
  telegramUserId: string;
  walletName: string;
  currency: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
  scanning?: boolean;
};

type ExpenseCreatedNotificationPayload = {
  telegram_chat_id?: string;
  wallet_name?: string;
  actor_name?: string;
  payer_name?: string;
  title?: string;
  total_amount?: number;
  currency?: string;
  expense_date?: string;
};

const pendingExpenses = new Map<string, PendingExpense>();
const pendingReceiptScans = new Map<string, PendingReceiptScan>();

const pendingCleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [key, pending] of pendingExpenses) {
    if (!pending.saving && pending.expiresAt <= now) {
      void finalizePendingExpense(key);
    }
  }

  for (const [key, pending] of pendingReceiptScans) {
    if (!pending.scanning && pending.expiresAt <= now) {
      clearTimeout(pending.timer);
      pendingReceiptScans.delete(key);
    }
  }
}, 30_000);
pendingCleanupTimer.unref();

const scheduledSummaryTimer = setInterval(() => {
  void runScheduledSummaryJobs();
}, SCHEDULED_SUMMARY_CHECK_MS);
scheduledSummaryTimer.unref();

function pendingExpenseKey(chatId: string, telegramUserId: string) {
  return `${chatId}:${telegramUserId}`;
}

async function downloadTelegramPhoto(fileUrl: URL) {
  const response = await fetch(fileUrl, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Telegram file download failed with HTTP ${response.status}`);
  }

  const declaredSize = Number(response.headers.get('content-length') || 0);

  if (declaredSize > MAX_ATTACHMENT_SIZE) {
    throw new Error('Ảnh vượt quá giới hạn 10 MB.');
  }

  const bytes = await response.arrayBuffer();

  if (bytes.byteLength > MAX_ATTACHMENT_SIZE) {
    throw new Error('Ảnh vượt quá giới hạn 10 MB.');
  }

  return {
    bytes,
    contentType: response.headers.get('content-type') || 'image/jpeg',
  };
}

function getCommandArgument(text: string) {
  return text.trim().split(/\s+/).slice(1).join(' ').trim();
}

function telegramIdentity(ctx: Context) {
  if (!ctx.from) throw new Error('Không xác định được người gửi');

  return {
    telegram_user_id: String(ctx.from.id),
    telegram_username: ctx.from.username,
    telegram_display_name: [ctx.from.first_name, ctx.from.last_name]
      .filter(Boolean)
      .join(' '),
  };
}

function chatTitle(ctx: Context) {
  if (!ctx.chat || ctx.chat.type === 'private') return undefined;
  return 'title' in ctx.chat ? ctx.chat.title : undefined;
}

function formatMoney(amount: number, currency = 'VND') {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'VND' ? 0 : 2,
  }).format(amount);
}

function currentDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: botTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function zonedNowParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: botTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const valueByType = new Map(parts.map((part) => [part.type, part.value]));

  return {
    date: `${valueByType.get('year')}-${valueByType.get('month')}-${valueByType.get('day')}`,
    year: Number(valueByType.get('year')),
    month: Number(valueByType.get('month')),
    day: Number(valueByType.get('day')),
    hour: Number(valueByType.get('hour')),
    minute: Number(valueByType.get('minute')),
  };
}

function dateFromYmd(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatYmd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number) {
  const date = dateFromYmd(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatYmd(date);
}

function getMondayOfWeek(value: string) {
  const date = dateFromYmd(value);
  const dayOfWeek = date.getUTCDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  date.setUTCDate(date.getUTCDate() - daysFromMonday);
  return formatYmd(date);
}

function getMonthStart(year: number, month: number) {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

function getNextMonthStart(year: number, month: number) {
  const date = new Date(Date.UTC(year, month, 1));
  return formatYmd(date);
}

function isLastDayOfMonth(parts: ReturnType<typeof zonedNowParts>) {
  return addDays(parts.date, 1).slice(5, 7) !== parts.date.slice(5, 7);
}

function currentMonth() {
  const [year, month] = currentDate().split('-');
  return `${year}-${month}`;
}

function formatMonthLabel(month: string) {
  const [year, monthNumber] = month.split('-');
  return `${monthNumber}/${year}`;
}

function escapeHtml(value: unknown) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncateCell(value: string, maxLength = 18) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatTable(headers: string[], rows: string[][]) {
  const normalizedRows = rows.map((row) =>
    row.map((cell) => truncateCell(String(cell)))
  );
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...normalizedRows.map((row) => row[index]?.length ?? 0)
    )
  );
  const formatRow = (row: string[]) =>
    row.map((cell, index) => cell.padEnd(widths[index], ' ')).join('  ');

  return [
    formatRow(headers),
    formatRow(headers.map((header, index) => '-'.repeat(widths[index]))),
    ...normalizedRows.map(formatRow),
  ].join('\n');
}

function htmlTable(headers: string[], rows: string[][]) {
  if (rows.length === 0) return '';
  return `<pre>${escapeHtml(formatTable(headers, rows))}</pre>`;
}

function htmlField(label: string, value: unknown) {
  return `<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`;
}

function friendlyError(error: unknown) {
  if (!(error instanceof TinoApiError)) {
    return 'Có lỗi xảy ra. Vui lòng thử lại.';
  }

  const messages: Record<string, string> = {
    TELEGRAM_ACCOUNT_NOT_LINKED:
      'Telegram chưa liên kết. Hãy tạo mã trong Tino rồi gửi /link MA.',
    TELEGRAM_CHAT_NOT_CONNECTED:
      'Nhóm chưa kết nối với ví Tino. Owner hãy dùng /connect MA.',
    TELEGRAM_CHAT_DISCONNECT_FAILED:
      'Không thể hủy kết nối nhóm khỏi ví. Vui lòng thử lại.',
    TELEGRAM_CONNECT_DENIED:
      'Mã kết nối không thuộc tài khoản Tino của bạn.',
    WALLET_ACCESS_DENIED:
      'Tài khoản của bạn không còn là thành viên hoạt động trong ví.',
    WALLET_OWNER_REQUIRED:
      'Chỉ owner của ví mới thực hiện được thao tác này.',
    INVALID_TELEGRAM_CODE: 'Mã không hợp lệ, đã dùng hoặc đã hết hạn.',
    TELEGRAM_ACCOUNT_ALREADY_LINKED:
      'Tài khoản Telegram hoặc Tino này đã được liên kết.',
    WALLET_ALREADY_CONNECTED: 'Ví đã kết nối với một nhóm Telegram khác.',
    BOT_UNAUTHORIZED: 'Bot chưa được cấu hình đúng service secret.',
    TINO_SERVICE_UNAVAILABLE: error.message,
  };

  return messages[error.code] || error.message;
}

async function isTelegramAdmin(ctx: Context) {
  if (!ctx.chat || !ctx.from || ctx.chat.type === 'private') return false;
  const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
  return member.status === 'creator' || member.status === 'administrator';
}

async function sendBotMessage(chatId: string, message: string) {
  try {
    await bot.telegram.sendMessage(chatId, message);
  } catch (error) {
    console.error('Could not send Telegram message', error);
  }
}

async function sendBotHtmlMessage(chatId: string, message: string) {
  try {
    await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Could not send Telegram message', error);
  }
}

function formatPeriodLabel(periodStart: string, periodEnd: string) {
  return `${periodStart} đến ${addDays(periodEnd, -1)}`;
}

function formatSignedMoney(amount: number, currency: string) {
  if (Math.abs(amount) <= 0.01) {
    return formatMoney(0, currency);
  }

  return `${amount > 0 ? '+' : '-'}${formatMoney(Math.abs(amount), currency)}`;
}

async function broadcastScheduledSummary(input: {
  kind: 'weekly' | 'monthly';
  periodStart: string;
  periodEnd: string;
}) {
  const summaries = await tinoApi.getScheduledSummaries(
    input.periodStart,
    input.periodEnd
  );
  const title =
    input.kind === 'weekly'
      ? 'Tổng kết chi tiêu tuần'
      : 'Tổng kết chi tiêu tháng';

  for (const summary of summaries) {
    const memberRows = summary.member_balances.map((member) => [
      member.display_name,
      formatMoney(Number(member.paid), summary.wallet.currency),
      formatMoney(Number(member.share), summary.wallet.currency),
      formatSignedMoney(Number(member.balance), summary.wallet.currency),
    ]);
    const message = [
      `<b>${escapeHtml(title)}</b>`,
      htmlField('Ví', summary.wallet.name),
      htmlField('Kỳ', formatPeriodLabel(summary.period_start, summary.period_end)),
      htmlField(
        'Tổng chi',
        formatMoney(Number(summary.total_amount), summary.wallet.currency)
      ),
      '',
      memberRows.length > 0
        ? htmlTable(['Thành viên', 'Đã trả', 'Phần chi', 'Lệch'], memberRows)
        : '<i>Chưa có thành viên hoạt động.</i>',
    ].join('\n');

    await sendBotHtmlMessage(summary.telegram_chat_id, message);
  }
}

async function runScheduledSummaryJobs() {
  if (!botReady) return;

  const now = zonedNowParts();

  if (now.hour !== 22 || now.minute !== 0) {
    return;
  }

  const dayOfWeek = dateFromYmd(now.date).getUTCDay();

  if (dayOfWeek === 0 && lastWeeklySummaryKey !== now.date) {
    lastWeeklySummaryKey = now.date;

    try {
      await broadcastScheduledSummary({
        kind: 'weekly',
        periodStart: getMondayOfWeek(now.date),
        periodEnd: addDays(now.date, 1),
      });
    } catch (error) {
      console.error('Could not send weekly Telegram summaries', error);
    }
  }

  if (isLastDayOfMonth(now) && lastMonthlySummaryKey !== now.date) {
    lastMonthlySummaryKey = now.date;

    try {
      await broadcastScheduledSummary({
        kind: 'monthly',
        periodStart: getMonthStart(now.year, now.month),
        periodEnd: getNextMonthStart(now.year, now.month),
      });
    } catch (error) {
      console.error('Could not send monthly Telegram summaries', error);
    }
  }
}

async function finalizePendingExpense(key: string) {
  const pending = pendingExpenses.get(key);

  if (!pending || pending.saving) return;

  pending.saving = true;
  clearTimeout(pending.timer);

  try {
    const expense = await tinoApi.createExpense({
      telegram_user_id: pending.telegramUserId,
      telegram_chat_id: pending.chatId,
      title: pending.title,
      total_amount: pending.amount,
      expense_date: pending.expenseDate,
    });
    let attachmentSavedCount = 0;
    let attachmentError: unknown = null;

    if (pending.attachments.length > 0) {
      try {
        const attachments = await tinoApi.uploadExpenseAttachments(expense.id, {
          telegram_user_id: pending.telegramUserId,
          telegram_chat_id: pending.chatId,
          files: pending.attachments.map((attachment) => ({
            bytes: attachment.bytes,
            file_name: attachment.fileName,
            content_type: attachment.contentType,
          })),
        });
        attachmentSavedCount = attachments.length;
      } catch (error) {
        attachmentError = error;
      }
    }

    await sendBotHtmlMessage(
      pending.chatId,
      [
        attachmentSavedCount > 0
          ? `<b>Đã lưu khoản chi kèm ${attachmentSavedCount} ảnh</b>`
          : '<b>Đã lưu khoản chi</b>',
        htmlField('Ví', expense.wallet_name || pending.walletName),
        htmlField('Nội dung', expense.title),
        htmlField(
          'Số tiền',
          formatMoney(Number(expense.total_amount), expense.currency)
        ),
        htmlField('Cách chia', 'Chia đều'),
        attachmentError
          ? htmlField(
              'Ảnh chưa upload được',
              attachmentError instanceof Error
                ? attachmentError.message
                : 'Có lỗi xảy ra.'
            )
          : null,
      ]
        .filter(Boolean)
        .join('\n')
    );
  } catch (error) {
    await sendBotHtmlMessage(
      pending.chatId,
      [
        '<b>Không thể lưu khoản chi</b>',
        htmlField('Nội dung', pending.title),
        htmlField('Lý do', friendlyError(error)),
      ].join('\n')
    );
  } finally {
    pendingExpenses.delete(key);
  }
}

async function createPendingExpenseFromReceipt(
  key: string,
  scan: PendingReceiptScan,
  attachment: PendingExpenseAttachment,
  draft: {
    title: string;
    total_amount: number | null;
    expense_date: string;
    merchant_name: string | null;
    confidence: number | null;
  }
) {
  if (!draft.total_amount || draft.total_amount <= 0) {
    throw new Error('Không nhận diện được tổng tiền trong hoá đơn.');
  }

  if (pendingExpenses.has(key)) {
    await finalizePendingExpense(key);
  }

  const timer = setTimeout(() => {
    void finalizePendingExpense(key);
  }, EXPENSE_PHOTO_WAIT_MS);
  timer.unref();

  pendingExpenses.set(key, {
    chatId: scan.chatId,
    telegramUserId: scan.telegramUserId,
    title: draft.title,
    amount: draft.total_amount,
    currency: scan.currency,
    walletName: scan.walletName,
    expenseDate: draft.expense_date || currentDate(),
    expiresAt: Date.now() + EXPENSE_PHOTO_WAIT_MS,
    timer,
    attachments: [attachment],
  });
}

async function replyPersonalSummary(ctx: Context) {
  if (!ctx.from) {
    await ctx.reply('Không xác định được người gửi.');
    return;
  }

  try {
    const month = currentMonth();
    const summary = await tinoApi.getPersonalSummary(String(ctx.from.id), month);
    const totalRows = summary.totals_by_currency.map((total) => [
      total.currency,
      formatMoney(Number(total.total_amount), total.currency),
      formatMoney(Number(total.paid_amount), total.currency),
      formatMoney(Number(total.share_amount), total.currency),
    ]);
    const walletRows = summary.wallets.map((wallet) => [
      wallet.wallet_name,
      formatMoney(Number(wallet.total_amount), wallet.currency),
      formatMoney(Number(wallet.paid_amount), wallet.currency),
      formatMoney(Number(wallet.share_amount), wallet.currency),
    ]);

    await ctx.reply(
      [
        `<b>Tổng kết cá nhân tháng ${escapeHtml(formatMonthLabel(month))}</b>`,
        '',
        '<b>Tổng theo tiền tệ</b>',
        totalRows.length > 0
          ? htmlTable(['Tiền', 'Tổng ví', 'Đã trả', 'Phải chịu'], totalRows)
          : '<i>Chưa có chi tiêu trong tháng này.</i>',
        '',
        '<b>Theo từng ví</b>',
        walletRows.length > 0
          ? htmlTable(['Ví', 'Tổng', 'Đã trả', 'Phải chịu'], walletRows)
          : '<i>Bạn chưa thuộc ví nào.</i>',
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    await ctx.reply(friendlyError(error));
  }
}
bot.start((ctx) =>
  ctx.reply(
    [
      'Tino Expense Bot',
      '',
      '1. Liên kết tài khoản: /link MA',
      '2. Kết nối nhóm với ví: /connect MA',
      '3. Gửi chi tiêu, ví dụ: rau, thịt 50k',
      '4. Quét hoá đơn: /receipt rồi gửi ảnh hoá đơn',
      '',
      'Dùng /help để xem hướng dẫn.',
    ].join('\n')
  )
);

bot.help((ctx) =>
  ctx.reply(
    [
      'Các lệnh:',
      '/link MA - liên kết Telegram với tài khoản Tino',
      '/connect MA - kết nối nhóm hiện tại với một ví',
      '/disconnect - hủy kết nối nhóm hiện tại khỏi ví',
      '/wallet - xem ví đang kết nối',
      '/receipt - quét ảnh hoá đơn để tạo khoản chi',
      '/help - xem hướng dẫn',
      '',
      'Định dạng chi tiêu:',
      'rau, thịt 50k',
      'tiền điện 1.2tr',
      'ăn sáng 35.000',
      '',
      'Sau khi gửi chi tiêu, bot sẽ luôn chờ 1 phút để bạn gửi nhiều ảnh hóa đơn. Nếu không có ảnh, khoản chi vẫn được tự lưu.',
      'Với /receipt, bot sẽ đọc hoá đơn, hiển thị thông tin để xác nhận, rồi tự lưu sau 1 phút nếu bạn không bấm xác nhận.',
    ].join('\n')
  )
);

bot.command('link', async (ctx) => {
  const code = getCommandArgument(ctx.message.text);
  if (!code) return void (await ctx.reply('Cú pháp: /link MA_LIEN_KET'));

  try {
    await tinoApi.linkAccount(telegramIdentity(ctx), code);
    await ctx.reply('Liên kết tài khoản Tino thành công.');
  } catch (error) {
    await ctx.reply(friendlyError(error));
  }
});

bot.command('connect', async (ctx) => {
  if (ctx.chat.type === 'private') {
    await ctx.reply('Lệnh /connect cần được gửi trong group hoặc supergroup.');
    return;
  }

  const code = getCommandArgument(ctx.message.text);
  if (!code) return void (await ctx.reply('Cú pháp: /connect MA_KET_NOI_VI'));

  try {
    if (!(await isTelegramAdmin(ctx))) {
      await ctx.reply('Chỉ quản trị viên Telegram mới được kết nối nhóm.');
      return;
    }

    const result = await tinoApi.connectChat(telegramIdentity(ctx), {
      code,
      telegram_chat_id: String(ctx.chat.id),
      telegram_chat_title: chatTitle(ctx),
    });
    await ctx.reply(`Đã kết nối nhóm với ví "${result.wallet.name}".`);
  } catch (error) {
    await ctx.reply(friendlyError(error));
  }
});

bot.command('disconnect', async (ctx) => {
  if (ctx.chat.type === 'private') {
    await ctx.reply('Lệnh /disconnect cần được gửi trong group hoặc supergroup.');
    return;
  }

  try {
    const result = await tinoApi.disconnectChat(
      String(ctx.from.id),
      String(ctx.chat.id)
    );
    await ctx.reply(`Đã hủy kết nối nhóm khỏi ví "${result.wallet.name}".`);
  } catch (error) {
    await ctx.reply(friendlyError(error));
  }
});

bot.command('wallet', async (ctx) => {
  try {
    const telegramUserId = String(ctx.from.id);
    const telegramChatId = String(ctx.chat.id);
    const month = currentMonth();
    const [context, summary] = await Promise.all([
      tinoApi.getContext(telegramUserId, telegramChatId),
      tinoApi.getSummary(telegramUserId, telegramChatId, month),
    ]);
    const memberNameById = new Map(
      context.members.map((member) => [member.user_id, member.display_name])
    );
    const getMemberName = (userId: string) => memberNameById.get(userId) || userId;
    const memberRows = summary.member_balances.map((member) => [
      getMemberName(member.user_id),
      formatMoney(Number(member.paid), summary.currency),
      formatMoney(Number(member.share), summary.currency),
      formatMoney(Number(member.balance), summary.currency),
    ]);
    const settlementRows = summary.settlements.map((settlement) => [
      getMemberName(settlement.from_user_id),
      getMemberName(settlement.to_user_id),
      formatMoney(Number(settlement.amount), settlement.currency),
    ]);

    await ctx.reply(
      [
        `<b>${escapeHtml(context.wallet.name)}</b>`,
        htmlField('Tháng', formatMonthLabel(month)),
        htmlField('Tiền tệ', context.wallet.currency),
        htmlField('Thành viên', context.members.length),
        htmlField('Tổng chi tiêu', formatMoney(Number(summary.total_amount), summary.currency)),
        '',
        '<b>Chi tiết thành viên</b>',
        memberRows.length > 0
          ? htmlTable(['Tên', 'Đã trả', 'Phải chịu', 'Cân bằng'], memberRows)
          : '<i>Chưa có dữ liệu thành viên.</i>',
        '',
        '<b>Quyết toán</b>',
        settlementRows.length > 0
          ? htmlTable(['Từ', 'Đến', 'Số tiền'], settlementRows)
          : '<i>Không cần quyết toán.</i>',
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    await ctx.reply(friendlyError(error));
  }
});
bot.command(['me', 'summary'], replyPersonalSummary);

bot.command(['receipt', 'scan'], async (ctx) => {
  if (!ctx.from) {
    await ctx.reply('Không xác định được người gửi.');
    return;
  }

  if (ctx.chat.type === 'private') {
    await ctx.reply('Hãy dùng /receipt trong nhóm đã kết nối với ví.');
    return;
  }

  const chatId = String(ctx.chat.id);
  const telegramUserId = String(ctx.from.id);
  const key = pendingExpenseKey(chatId, telegramUserId);

  try {
    if (pendingExpenses.has(key)) {
      await finalizePendingExpense(key);
    }

    const existingScan = pendingReceiptScans.get(key);

    if (existingScan) {
      clearTimeout(existingScan.timer);
      pendingReceiptScans.delete(key);
    }

    const context = await tinoApi.getContext(telegramUserId, chatId);
    const timer = setTimeout(() => {
      pendingReceiptScans.delete(key);
      void sendBotMessage(
        chatId,
        'Đã hết thời gian chờ ảnh hoá đơn. Gửi /receipt để thử lại.'
      );
    }, RECEIPT_UPLOAD_WAIT_MS);
    timer.unref();

    pendingReceiptScans.set(key, {
      chatId,
      telegramUserId,
      walletName: context.wallet.name,
      currency: context.wallet.currency,
      expiresAt: Date.now() + RECEIPT_UPLOAD_WAIT_MS,
      timer,
    });

    await ctx.reply(
      [
        '<b>Đã bật chế độ quét hoá đơn</b>',
        htmlField('Ví', context.wallet.name),
        '',
        '<i>Hãy gửi 1 ảnh hoá đơn trong 2 phút. Sau khi quét xong, bot sẽ hiển thị thông tin để bạn xác nhận.</i>',
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    await ctx.reply(friendlyError(error));
  }
});

bot.action(/^expense:skip-photo:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const pending = pendingExpenses.get(key);

  if (!pending) {
    await ctx.answerCbQuery('Yêu cầu đã hết hạn hoặc đã được lưu.');
    return;
  }

  if (pending.telegramUserId !== String(ctx.from.id)) {
    await ctx.answerCbQuery('Chỉ người tạo khoản chi mới dùng được nút này.');
    return;
  }

  if (pending.saving) {
    await ctx.answerCbQuery('Khoản chi đang được lưu.');
    return;
  }

  await ctx.answerCbQuery('Đang lưu khoản chi.');
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
  await finalizePendingExpense(key);
});

bot.action(/^expense:confirm-receipt:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const pending = pendingExpenses.get(key);

  if (!pending) {
    await ctx.answerCbQuery('Yêu cầu đã hết hạn hoặc đã được lưu.');
    return;
  }

  if (pending.telegramUserId !== String(ctx.from.id)) {
    await ctx.answerCbQuery('Chỉ người tạo khoản chi mới dùng được nút này.');
    return;
  }

  if (pending.saving) {
    await ctx.answerCbQuery('Khoản chi đang được lưu.');
    return;
  }

  await ctx.answerCbQuery('Đang lưu khoản chi.');
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
  await finalizePendingExpense(key);
});

bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  if (ctx.chat.type === 'private') {
    await ctx.reply('Hãy gửi khoản chi trong nhóm đã kết nối với ví.');
    return;
  }

  const parsed = parseExpenseMessage(ctx.message.text);
  if (!parsed) return;

  const chatId = String(ctx.chat.id);
  const telegramUserId = String(ctx.from.id);
  const key = pendingExpenseKey(chatId, telegramUserId);

  try {
    if (pendingExpenses.has(key)) {
      await finalizePendingExpense(key);
    }

    const context = await tinoApi.getContext(telegramUserId, chatId);
    const timer = setTimeout(() => {
      void finalizePendingExpense(key);
    }, EXPENSE_PHOTO_WAIT_MS);
    timer.unref();

    pendingExpenses.set(key, {
      chatId,
      telegramUserId,
      title: parsed.title,
      amount: parsed.amount,
      currency: context.wallet.currency,
      walletName: context.wallet.name,
      expenseDate: currentDate(),
      expiresAt: Date.now() + EXPENSE_PHOTO_WAIT_MS,
      timer,
      attachments: [],
    });

    await ctx.reply(
      [
        '<b>Đã nhận khoản chi</b>',
        htmlField('Ví', context.wallet.name),
        htmlField('Nội dung', parsed.title),
        htmlField('Số tiền', formatMoney(parsed.amount, context.wallet.currency)),
        htmlField('Cách chia', 'Chia đều'),
        '',
        `<i>Nếu có ảnh hóa đơn, hãy gửi tối đa ${MAX_PENDING_ATTACHMENTS} ảnh trong 1 phút. Bot sẽ lưu sau khi hết thời gian chờ. Nếu không, bấm "Bỏ qua ảnh" để lưu ngay.</i>`,
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Bỏ qua ảnh',
                callback_data: `expense:skip-photo:${key}`,
              },
            ],
          ],
        },
      }
    );
  } catch (error) {
    await ctx.reply(friendlyError(error));
  }
});

bot.on('photo', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const telegramUserId = String(ctx.from.id);
  const key = pendingExpenseKey(chatId, telegramUserId);
  const receiptScan = pendingReceiptScans.get(key);

  if (receiptScan) {
    if (receiptScan.scanning) {
      await ctx.reply('Mình đang đọc hoá đơn trước đó, chờ một chút nhé.');
      return;
    }

    if (receiptScan.expiresAt <= Date.now()) {
      clearTimeout(receiptScan.timer);
      pendingReceiptScans.delete(key);
      await ctx.reply('Đã hết thời gian chờ ảnh hoá đơn. Gửi /receipt để thử lại.');
      return;
    }

    const photo = ctx.message.photo.at(-1);

    if (!photo) return;

    receiptScan.scanning = true;

    try {
      await ctx.reply('Đã nhận ảnh hoá đơn. Mình đang đọc dữ liệu...');
      const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
      const downloaded = await downloadTelegramPhoto(fileUrl);
      const attachment = {
        bytes: downloaded.bytes,
        contentType: downloaded.contentType.startsWith('image/')
          ? downloaded.contentType
          : 'image/jpeg',
        fileName: `telegram-receipt-${photo.file_unique_id}.jpg`,
      };
      const draft = await tinoApi.createReceiptExpenseDraft({
        telegram_user_id: telegramUserId,
        telegram_chat_id: chatId,
        bytes: attachment.bytes,
        file_name: attachment.fileName,
        content_type: attachment.contentType,
      });

      await createPendingExpenseFromReceipt(key, receiptScan, attachment, draft);
      clearTimeout(receiptScan.timer);
      pendingReceiptScans.delete(key);

      const amount = draft.total_amount ?? 0;

      await ctx.reply(
        [
          '<b>Đã đọc hoá đơn</b>',
          htmlField('Ví', receiptScan.walletName),
          htmlField('Nội dung', draft.title),
          htmlField('Số tiền', formatMoney(amount, receiptScan.currency)),
          htmlField('Ngày chi', draft.expense_date),
          draft.merchant_name ? htmlField('Nơi bán', draft.merchant_name) : null,
          draft.confidence !== null
            ? htmlField('Độ tin cậy', `${Math.round(draft.confidence * 100)}%`)
            : null,
          '',
          '<i>Bấm "Lưu ngay" để xác nhận. Nếu không phản hồi, bot sẽ tự lưu sau 1 phút.</i>',
        ]
          .filter(Boolean)
          .join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: 'Lưu ngay',
                  callback_data: `expense:confirm-receipt:${key}`,
                },
              ],
            ],
          },
        }
      );
    } catch (error) {
      receiptScan.scanning = false;
      await ctx.reply(
        `Không thể đọc hoá đơn: ${friendlyError(error)}\nBạn có thể gửi ảnh khác hoặc gửi /receipt để bắt đầu lại.`
      );
    }

    return;
  }

  const pending = pendingExpenses.get(key);

  if (!pending || pending.saving) return;

  if (pending.expiresAt <= Date.now()) {
    await finalizePendingExpense(key);
    return;
  }

  if (pending.attachments.length >= MAX_PENDING_ATTACHMENTS) {
    await ctx.reply(`Đã nhận tối đa ${MAX_PENDING_ATTACHMENTS} ảnh cho khoản chi này.`);
    return;
  }

  const photo = ctx.message.photo.at(-1);

  if (!photo) return;

  try {
    const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
    const downloaded = await downloadTelegramPhoto(fileUrl);
    pending.attachments.push({
      bytes: downloaded.bytes,
      contentType: downloaded.contentType.startsWith('image/')
        ? downloaded.contentType
        : 'image/jpeg',
      fileName: `telegram-${photo.file_unique_id}.jpg`,
    });
    await ctx.reply(
      `Đã nhận ${pending.attachments.length}/${MAX_PENDING_ATTACHMENTS} ảnh. Mình sẽ lưu khoản chi sau khi hết 1 phút.`
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Có lỗi xảy ra khi tải ảnh.';
    await ctx.reply(
      `Không thể đọc ảnh hóa đơn: ${message}\nBạn vẫn có thể gửi ảnh khác trong thời gian chờ.`
    );
  }
});

bot.catch((error, ctx) => {
  console.error(`Telegram update ${ctx.update.update_id} failed`, error);
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '0.0.0.0', () => {
    server.off('error', reject);
    resolve();
  });
});

await bot.telegram.setMyCommands([
  { command: 'me', description: 'Tổng kết chi tiêu cá nhân tháng này' },
  { command: 'summary', description: 'Tổng kết chi tiêu cá nhân tháng này' },
  { command: 'link', description: 'Liên kết tài khoản Tino' },
  { command: 'connect', description: 'Kết nối nhóm với ví' },
  { command: 'disconnect', description: 'Hủy kết nối nhóm khỏi ví' },
  { command: 'wallet', description: 'Xem ví đang kết nối' },
  { command: 'receipt', description: 'Quét hoá đơn để tạo chi tiêu' },
  { command: 'help', description: 'Xem hướng dẫn' },
]);

void bot
  .launch({}, () => {
    botReady = true;
    console.log('Tino Telegram bot is running');
  })
  .catch((error) => {
    botReady = false;
    console.error('Tino Telegram bot failed to launch', error);
  });

function shutdown(signal: 'SIGINT' | 'SIGTERM') {
  botReady = false;
  clearInterval(pendingCleanupTimer);
  clearInterval(scheduledSummaryTimer);

  for (const pending of pendingExpenses.values()) {
    clearTimeout(pending.timer);
  }

  for (const pending of pendingReceiptScans.values()) {
    clearTimeout(pending.timer);
  }

  bot.stop(signal);
  server.close();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

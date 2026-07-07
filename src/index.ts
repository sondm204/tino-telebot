import { createServer } from 'node:http';
import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import { config } from './config.js';
import { parseExpenseMessage } from './expense-parser.js';
import { tinoApi, TinoApiError } from './tino-api.js';

const bot = new Telegraf(config.botToken);
const EXPENSE_PHOTO_WAIT_MS = 60_000;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const port = Number(process.env.PORT || 4040);
let botReady = false;

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
  attachment?: PendingExpenseAttachment;
  saving?: boolean;
};

const pendingExpenses = new Map<string, PendingExpense>();

const pendingCleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [key, pending] of pendingExpenses) {
    if (!pending.saving && pending.expiresAt <= now) {
      void finalizePendingExpense(key);
    }
  }
}, 30_000);
pendingCleanupTimer.unref();

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
    timeZone: process.env.TZ || 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function currentMonth() {
  const [year, month] = currentDate().split('-');
  return `${year}-${month}`;
}

function formatMonthLabel(month: string) {
  const [year, monthNumber] = month.split('-');
  return `${monthNumber}/${year}`;
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
    let attachmentSaved = false;
    let attachmentError: unknown = null;

    if (pending.attachment) {
      try {
        await tinoApi.uploadExpenseAttachment(expense.id, {
          telegram_user_id: pending.telegramUserId,
          telegram_chat_id: pending.chatId,
          bytes: pending.attachment.bytes,
          file_name: pending.attachment.fileName,
          content_type: pending.attachment.contentType,
        });
        attachmentSaved = true;
      } catch (error) {
        attachmentError = error;
      }
    }

    await sendBotMessage(
      pending.chatId,
      [
        pending.attachment && attachmentSaved
          ? 'Đã lưu khoản chi kèm ảnh.'
          : 'Đã lưu khoản chi.',
        `Ví: ${expense.wallet_name || pending.walletName}`,
        `Nội dung: ${expense.title}`,
        `Số tiền: ${formatMoney(Number(expense.total_amount), expense.currency)}`,
        'Cách chia: Chia đều',
        attachmentError
          ? `Ảnh chưa upload được: ${
              attachmentError instanceof Error
                ? attachmentError.message
                : 'Có lỗi xảy ra.'
            }`
          : null,
      ]
        .filter(Boolean)
        .join('\n')
    );
  } catch (error) {
    await sendBotMessage(
      pending.chatId,
      `Không thể lưu khoản chi "${pending.title}".\n${friendlyError(error)}`
    );
  } finally {
    pendingExpenses.delete(key);
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
      '/help - xem hướng dẫn',
      '',
      'Định dạng chi tiêu:',
      'rau, thịt 50k',
      'tiền điện 1.2tr',
      'ăn sáng 35.000',
      '',
      'Sau khi gửi chi tiêu, bot sẽ chờ 1 phút để bạn gửi ảnh hóa đơn. Nếu không có ảnh, khoản chi vẫn được tự lưu.',
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
    const memberLines =
      summary.member_balances.length > 0
        ? summary.member_balances.map((member) =>
            [
              `- ${getMemberName(member.user_id)}`,
              `đã trả ${formatMoney(Number(member.paid), summary.currency)}`,
              `phải chịu ${formatMoney(Number(member.share), summary.currency)}`,
              `cân bằng ${formatMoney(Number(member.balance), summary.currency)}`,
            ].join(' | ')
          )
        : ['Chưa có dữ liệu thành viên.'];
    const settlementLines =
      summary.settlements.length > 0
        ? summary.settlements.map(
            (settlement) =>
              `- ${getMemberName(settlement.from_user_id)} trả ${getMemberName(
                settlement.to_user_id
              )}: ${formatMoney(Number(settlement.amount), settlement.currency)}`
          )
        : ['Không cần quyết toán.'];

    await ctx.reply(
      [
        `Ví: ${context.wallet.name}`,
        `Tháng: ${formatMonthLabel(month)}`,
        `Tiền tệ: ${context.wallet.currency}`,
        `Thành viên: ${context.members.length}`,
        `Tổng chi tiêu: ${formatMoney(Number(summary.total_amount), summary.currency)}`,
        '',
        'Chi tiết thành viên:',
        ...memberLines,
        '',
        'Quyết toán:',
        ...settlementLines,
      ].join('\n')
    );
  } catch (error) {
    await ctx.reply(friendlyError(error));
  }
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
    });

    await ctx.reply(
      [
        'Đã nhận khoản chi.',
        `Ví: ${context.wallet.name}`,
        `Nội dung: ${parsed.title}`,
        `Số tiền: ${formatMoney(parsed.amount, context.wallet.currency)}`,
        'Cách chia: Chia đều',
        '',
        'Nếu có ảnh hóa đơn, hãy gửi ảnh trong 1 phút. Nếu không, mình sẽ tự lưu khoản chi không kèm ảnh.',
      ].join('\n')
    );
  } catch (error) {
    await ctx.reply(friendlyError(error));
  }
});

bot.on('photo', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const telegramUserId = String(ctx.from.id);
  const key = pendingExpenseKey(chatId, telegramUserId);
  const pending = pendingExpenses.get(key);

  if (!pending || pending.saving) return;

  if (pending.expiresAt <= Date.now()) {
    await finalizePendingExpense(key);
    return;
  }

  const photo = ctx.message.photo.at(-1);

  if (!photo) return;

  try {
    const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
    const downloaded = await downloadTelegramPhoto(fileUrl);
    pending.attachment = {
      bytes: downloaded.bytes,
      contentType: downloaded.contentType.startsWith('image/')
        ? downloaded.contentType
        : 'image/jpeg',
      fileName: `telegram-${photo.file_unique_id}.jpg`,
    };
    await ctx.reply('Đã nhận ảnh, mình đang lưu khoản chi.');
    await finalizePendingExpense(key);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Có lỗi xảy ra khi tải ảnh.';
    await ctx.reply(
      `Không thể đọc ảnh hóa đơn: ${message}\nMình sẽ lưu khoản chi không kèm ảnh.`
    );
    await finalizePendingExpense(key);
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
  { command: 'link', description: 'Liên kết tài khoản Tino' },
  { command: 'connect', description: 'Kết nối nhóm với ví' },
  { command: 'disconnect', description: 'Hủy kết nối nhóm khỏi ví' },
  { command: 'wallet', description: 'Xem ví đang kết nối' },
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

  for (const pending of pendingExpenses.values()) {
    clearTimeout(pending.timer);
  }

  bot.stop(signal);
  server.close();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
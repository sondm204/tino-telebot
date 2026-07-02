import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Markup, Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import { config } from './config.js';
import { parseExpenseMessage } from './expense-parser.js';
import { tinoApi, TinoApiError } from './tino-api.js';

const bot = new Telegraf(config.botToken);
const PENDING_TTL_MS = 5 * 60_000;
const port = Number(process.env.PORT || 8080);
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

type PendingExpense = {
  chatId: string;
  telegramUserId: string;
  title: string;
  amount: number;
  expenseDate: string;
  expiresAt: number;
};

const pendingExpenses = new Map<string, PendingExpense>();

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

function friendlyError(error: unknown) {
  if (!(error instanceof TinoApiError)) {
    return 'Có lỗi xảy ra. Vui lòng thử lại.';
  }

  const messages: Record<string, string> = {
    TELEGRAM_ACCOUNT_NOT_LINKED:
      'Telegram chưa liên kết. Hãy tạo mã trong Tino rồi gửi /link MA.',
    TELEGRAM_CHAT_NOT_CONNECTED:
      'Nhóm chưa kết nối với ví Tino. Owner hãy dùng /connect MA.',
    WALLET_ACCESS_DENIED:
      'Tài khoản của bạn không còn là thành viên hoạt động trong ví.',
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
      '/wallet - xem ví đang kết nối',
      '/help - xem hướng dẫn',
      '',
      'Định dạng chi tiêu:',
      'rau, thịt 50k',
      'tiền điện 1.2tr',
      'ăn sáng 35.000',
      '',
      'Người gửi là người trả, khoản chi mặc định chia đều.',
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

bot.command('wallet', async (ctx) => {
  try {
    const context = await tinoApi.getContext(
      String(ctx.from.id),
      String(ctx.chat.id)
    );
    await ctx.reply(
      [
        `Ví: ${context.wallet.name}`,
        `Tiền tệ: ${context.wallet.currency}`,
        `Thành viên: ${context.members.length}`,
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

  try {
    const context = await tinoApi.getContext(
      String(ctx.from.id),
      String(ctx.chat.id)
    );
    const token = randomBytes(8).toString('hex');
    pendingExpenses.set(token, {
      chatId: String(ctx.chat.id),
      telegramUserId: String(ctx.from.id),
      title: parsed.title,
      amount: parsed.amount,
      expenseDate: currentDate(),
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    await ctx.reply(
      [
        'Xác nhận khoản chi?',
        `Ví: ${context.wallet.name}`,
        `Nội dung: ${parsed.title}`,
        `Số tiền: ${formatMoney(parsed.amount, context.wallet.currency)}`,
        'Cách chia: Chia đều',
      ].join('\n'),
      Markup.inlineKeyboard([
        Markup.button.callback('Xác nhận', `expense:confirm:${token}`),
        Markup.button.callback('Hủy', `expense:cancel:${token}`),
      ])
    );
  } catch (error) {
    await ctx.reply(friendlyError(error));
  }
});

bot.action(/^expense:(confirm|cancel):([a-f0-9]+)$/, async (ctx) => {
  const action = ctx.match[1];
  const token = ctx.match[2];
  const pending = pendingExpenses.get(token);

  if (
    !pending ||
    pending.expiresAt <= Date.now() ||
    pending.telegramUserId !== String(ctx.from.id) ||
    pending.chatId !== String(ctx.chat?.id)
  ) {
    pendingExpenses.delete(token);
    await ctx.answerCbQuery('Yêu cầu đã hết hạn hoặc không thuộc về bạn.');
    return;
  }

  pendingExpenses.delete(token);

  if (action === 'cancel') {
    await ctx.answerCbQuery('Đã hủy');
    await ctx.editMessageText('Đã hủy khoản chi.');
    return;
  }

  try {
    await ctx.answerCbQuery('Đang lưu...');
    const expense = await tinoApi.createExpense({
      telegram_user_id: pending.telegramUserId,
      telegram_chat_id: pending.chatId,
      title: pending.title,
      total_amount: pending.amount,
      expense_date: pending.expenseDate,
    });
    await ctx.editMessageText(
      [
        'Đã lưu khoản chi.',
        `Ví: ${expense.wallet_name}`,
        `Nội dung: ${expense.title}`,
        `Số tiền: ${formatMoney(Number(expense.total_amount), expense.currency)}`,
        'Cách chia: Chia đều',
      ].join('\n')
    );
  } catch (error) {
    await ctx.editMessageText(`Không thể lưu khoản chi.\n${friendlyError(error)}`);
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
  { command: 'wallet', description: 'Xem ví đang kết nối' },
  { command: 'help', description: 'Xem hướng dẫn' },
]);

await bot.launch();
botReady = true;
console.log('Tino Telegram bot is running');

function shutdown(signal: 'SIGINT' | 'SIGTERM') {
  botReady = false;
  bot.stop(signal);
  server.close();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Markup, Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import { config } from './config.js';
import { parseExpenseMessage } from './expense-parser.js';
import { tinoApi, TinoApiError } from './tino-api.js';

const bot = new Telegraf(config.botToken);
const PENDING_TTL_MS = 5 * 60_000;
const ATTACHMENT_TTL_MS = 5 * 60_000;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
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

type AttachmentOffer = {
  expenseId: string;
  chatId: string;
  telegramUserId: string;
  expiresAt: number;
};

type PendingAttachment = AttachmentOffer;

const pendingExpenses = new Map<string, PendingExpense>();
const attachmentOffers = new Map<string, AttachmentOffer>();
const pendingAttachments = new Map<string, PendingAttachment>();
const pendingCleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [token, pending] of pendingExpenses) {
    if (pending.expiresAt <= now) pendingExpenses.delete(token);
  }

  for (const [token, offer] of attachmentOffers) {
    if (offer.expiresAt <= now) attachmentOffers.delete(token);
  }

  for (const [key, pending] of pendingAttachments) {
    if (pending.expiresAt <= now) pendingAttachments.delete(key);
  }
}, 60_000);
pendingCleanupTimer.unref();

function attachmentKey(chatId: string, telegramUserId: string) {
  return `${chatId}:${telegramUserId}`;
}

function isOwnedAttachmentState(
  state: AttachmentOffer | undefined,
  chatId: string,
  telegramUserId: string
) {
  return (
    state &&
    state.expiresAt > Date.now() &&
    state.chatId === chatId &&
    state.telegramUserId === telegramUserId
  );
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
    const attachmentToken = randomBytes(8).toString('hex');
    attachmentOffers.set(attachmentToken, {
      expenseId: expense.id,
      chatId: pending.chatId,
      telegramUserId: pending.telegramUserId,
      expiresAt: Date.now() + ATTACHMENT_TTL_MS,
    });
    await ctx.editMessageText(
      [
        'Đã lưu khoản chi.',
        `Ví: ${expense.wallet_name}`,
        `Nội dung: ${expense.title}`,
        `Số tiền: ${formatMoney(Number(expense.total_amount), expense.currency)}`,
        'Cách chia: Chia đều',
        '',
        'Bạn có muốn thêm ảnh hóa đơn?',
      ].join('\n'),
      Markup.inlineKeyboard([
        Markup.button.callback(
          'Thêm ảnh',
          `attachment:add:${attachmentToken}`
        ),
        Markup.button.callback(
          'Bỏ qua',
          `attachment:skip:${attachmentToken}`
        ),
      ])
    );
  } catch (error) {
    await ctx.editMessageText(`Không thể lưu khoản chi.\n${friendlyError(error)}`);
  }
});

bot.action(/^attachment:(add|skip):([a-f0-9]+)$/, async (ctx) => {
  const action = ctx.match[1];
  const token = ctx.match[2];
  const offer = attachmentOffers.get(token);
  const chatId = String(ctx.chat?.id);
  const telegramUserId = String(ctx.from.id);

  if (!offer || !isOwnedAttachmentState(offer, chatId, telegramUserId)) {
    attachmentOffers.delete(token);
    await ctx.answerCbQuery(
      'Yêu cầu đã hết hạn hoặc không thuộc về bạn.'
    );
    return;
  }

  attachmentOffers.delete(token);
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);

  if (action === 'skip') {
    await ctx.answerCbQuery('Đã bỏ qua');
    return;
  }

  pendingAttachments.set(attachmentKey(chatId, telegramUserId), {
    ...offer,
    expiresAt: Date.now() + ATTACHMENT_TTL_MS,
  });
  await ctx.answerCbQuery('Đang chờ ảnh');
  await ctx.reply(
    'Hãy gửi ảnh hóa đơn trong 5 phút. Ảnh tiếp theo của bạn trong nhóm này sẽ được gắn vào khoản chi.'
  );
});

bot.on('photo', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const telegramUserId = String(ctx.from.id);
  const key = attachmentKey(chatId, telegramUserId);
  const pending = pendingAttachments.get(key);

  if (!pending) return;

  if (pending.expiresAt <= Date.now()) {
    pendingAttachments.delete(key);
    await ctx.reply(
      'Yêu cầu thêm ảnh đã hết hạn. Khoản chi vẫn được lưu mà không có ảnh.'
    );
    return;
  }

  const photo = ctx.message.photo.at(-1);

  if (!photo) return;

  try {
    const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
    const downloaded = await downloadTelegramPhoto(fileUrl);
    await tinoApi.uploadExpenseAttachment(pending.expenseId, {
      telegram_user_id: telegramUserId,
      telegram_chat_id: chatId,
      bytes: downloaded.bytes,
      file_name: `telegram-${photo.file_unique_id}.jpg`,
      content_type: downloaded.contentType.startsWith('image/')
        ? downloaded.contentType
        : 'image/jpeg',
    });

    pendingAttachments.delete(key);
    await ctx.reply('Đã thêm ảnh hóa đơn vào khoản chi.');
  } catch (error) {
    const message =
      error instanceof TinoApiError
        ? friendlyError(error)
        : error instanceof Error
          ? error.message
          : 'Có lỗi xảy ra khi tải ảnh.';
    await ctx.reply(
      `Không thể thêm ảnh hóa đơn.\n${message}\nBạn có thể gửi lại ảnh trước khi yêu cầu hết hạn.`
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
  { command: 'link', description: 'Liên kết tài khoản Tino' },
  { command: 'connect', description: 'Kết nối nhóm với ví' },
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
  bot.stop(signal);
  server.close();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

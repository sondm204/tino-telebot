# Tino Telegram Bot

Telegram interface for creating Tino expenses from group messages.

## Setup

1. Create a bot with `@BotFather`.
2. Disable group privacy with `/setprivacy` so the bot receives expense messages.
3. Copy `.env.example` to `.env` and configure all values.
4. Use the same random secret for `TELEGRAM_BOT_SERVICE_SECRET` in
   `tino-service` and `TINO_BOT_SERVICE_SECRET` in this project.
5. Apply the latest `tino-service` Supabase migration.

```bash
pnpm install
pnpm dev
```

## Linking flow

Authenticated Tino clients create one-time codes through:

```text
POST /api/telegram/link-code
POST /api/telegram/wallets/:walletId/connect-code
```

The user then sends:

```text
/link ACCOUNT_CODE
/connect WALLET_CODE
```

`/connect` must be sent by a Telegram group administrator who is also the
wallet owner.

## Expense messages

```text
rau, thịt 50k
tiền điện 1.2tr
ăn sáng 35.000
```

The sender is recorded as the payer and the expense is split equally.

import 'dotenv/config';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const config = {
  botToken: required('TELEGRAM_BOT_TOKEN'),
  apiBaseUrl: required('TINO_API_BASE_URL').replace(/\/+$/, ''),
  serviceSecret: required('TINO_BOT_SERVICE_SECRET'),
};

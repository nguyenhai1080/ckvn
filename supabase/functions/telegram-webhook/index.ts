// Supabase Edge Function: webhook cho bot Telegram.
// Deploy:  supabase functions deploy telegram-webhook --no-verify-jwt
// Secrets: supabase secrets set TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... SITE_URL=https://...
import { handleUpdate } from './handler.ts';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('ok');
  // Telegram gửi kèm secret_token đã đặt khi setWebhook → chặn request giả mạo
  if (req.headers.get('x-telegram-bot-api-secret-token') !== Deno.env.get('TELEGRAM_WEBHOOK_SECRET')) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    await handleUpdate(await req.json(), {
      supabaseUrl: Deno.env.get('SUPABASE_URL')!,
      serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      botToken: Deno.env.get('TELEGRAM_BOT_TOKEN')!,
      siteUrl: Deno.env.get('SITE_URL') || '',
    });
  } catch (e) {
    console.error(e);
  }
  // Luôn trả 200 để Telegram không gửi lại liên tục
  return new Response('ok');
});

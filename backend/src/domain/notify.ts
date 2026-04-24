// Fire-and-forget Telegram notifier used for engine-level alerts (fills,
// circuit-breaker trips, wind-downs). Silently no-ops when the bot token or
// chat id is unset so engine logic stays the same in dev and prod.

export function notifyTelegram(text: string): void {
  const tgToken = process.env.TELEGRAM_BOT_TOKEN
  const tgChat = process.env.TELEGRAM_CHAT_ID
  if (!tgToken || !tgChat) return
  void fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: tgChat, text }),
  }).catch(() => {})
}

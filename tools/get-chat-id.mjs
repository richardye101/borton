// Run AFTER sending any message to your bot in Telegram.
// Prints the chat IDs that have messaged the bot, so you can set telegram.allowedChatId in config.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dir, '..');

// load TELEGRAM_BOT_KEY from .env
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
}
const token = process.env.TELEGRAM_BOT_KEY;
if (!token) { console.error('Missing TELEGRAM_BOT_KEY in .env'); process.exit(1); }

const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const d = await r.json();
const seen = new Map();
for (const u of d.result || []) {
  const c = u.message?.chat;
  if (c) seen.set(c.id, `${c.first_name || ''} ${c.last_name || ''} @${c.username || ''}`.trim());
}
if (!seen.size) console.log('No messages yet. Send any message to your bot in Telegram, then re-run.');
for (const [id, who] of seen) console.log(`chat_id: ${id}   (${who})`);

// ============================================================================
// Edge Function: formcheck-cleanup  (викликається щоденним pg_cron)
// Правило зберігання медіа розборів (form-check):
//   • відео + медіа відповіді (скрін, голос) прибираємо, коли:
//       (розібрано И клієнт переглянув И минуло > RETENTION_DAYS від reviewed_at)
//       АБО (минуло > HARD_CAP_DAYS від created_at — жорстка стеля).
//   • ТЕКСТ розбору лишається назавжди (легкий — історія коучингу).
//   • Прибирання: видалення обʼєктів у Storage + обнулення *_path + media_purged_at.
//
// Захист: заголовок Authorization: Bearer <CRON_SECRET> (секрет спільний із cron-job).
// Секрети: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const RETENTION_DAYS = 7;   // тримаємо ще стільки після перегляду клієнтом
const HARD_CAP_DAYS = 30;   // прибираємо в будь-якому разі від створення
const DAY = 86400000;

Deno.serve(async (req) => {
  // Аутентифікація крон-виклику
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const secret = Deno.env.get("CRON_SECRET") || "";
  if (!secret || auth !== secret) return json({ error: "forbidden" }, 403);

  const now = Date.now();
  const afterSeen = new Date(now - RETENTION_DAYS * DAY).toISOString();
  const hardCap = new Date(now - HARD_CAP_DAYS * DAY).toISOString();

  // Кандидати: ще не прибрані, підпадають під одну з умов.
  const { data: rows, error } = await svc.from("form_check_requests")
    .select("id, video_path, response_image_path, response_voice_path, response_images, response_voices")
    .is("media_purged_at", null)
    .or(`and(status.eq.reviewed,client_seen.eq.true,reviewed_at.lt.${afterSeen}),created_at.lt.${hardCap}`)
    .limit(500);
  if (error) return json({ error: String(error.message || error) }, 500);

  // Розбори 2.1: медіа відповіді лежать масивами (+ легасі одиночні поля).
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) as string[] : []);

  let purged = 0, files = 0;
  for (const r of rows || []) {
    const paths = [...new Set([
      r.video_path, r.response_image_path, r.response_voice_path,
      ...arr(r.response_images), ...arr(r.response_voices),
    ].filter(Boolean) as string[])];
    if (paths.length) {
      try { await svc.storage.from("form-checks").remove(paths); files += paths.length; } catch (_) { /* best-effort */ }
    }
    await svc.from("form_check_requests").update({
      video_path: null, response_image_path: null, response_voice_path: null,
      response_images: [], response_voices: [],
      media_purged_at: new Date(now).toISOString(),
    }).eq("id", r.id);
    purged++;
  }

  return json({ ok: true, purged, files });
});

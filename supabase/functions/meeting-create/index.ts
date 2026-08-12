// ============================================================================
// Edge Function: meeting-create — тренер планує зустріч (Блок 3).
// Тренер (Supabase Auth JWT) → рядок у meetings + Telegram клієнту з інлайн-
// кнопками «✅ Підтверджую / ❌ Не можу» (callback scope 'mt' у telegram-webhook).
//
// Лінк: kind=online і лінк не заданий → авто-Jitsi (працює без реєстрації).
// POST { client_id, starts_at, duration_min?, kind?, link?, note? }
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// Дата/час у Києві — щоб клієнт бачив у своєму часі, а не UTC.
function fmtKyiv(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "numeric", month: "long", weekday: "short" });
  const time = d.toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });
  return `${date}, ${time}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: uRes } = await svc.auth.getUser(jwt);
  const authUid = uRes?.user?.id;
  if (!authUid) return json({ error: "unauthorized" }, 401);
  const { data: tr } = await svc.from("trainers")
    .select("id, trainer_name, brand_name").eq("owner", authUid).maybeSingle();
  if (!tr?.id) return json({ error: "not a trainer" }, 403);

  const b = await req.json().catch(() => ({}));
  const clientId = b.client_id as string;
  const startsAt = b.starts_at as string;
  if (!clientId || !startsAt) return json({ error: "client_id + starts_at required" }, 400);

  const { data: client } = await svc.from("clients")
    .select("id, trainer_id, tg_user_id, name").eq("id", clientId).maybeSingle();
  if (!client || client.trainer_id !== tr.id) return json({ error: "forbidden" }, 403);

  const kind = b.kind === "gym" ? "gym" : "online";
  // Тренер задає своє посилання (Google Meet / Zoom). Якщо онлайн без лінка —
  // авто-Jitsi (працює без реєстрації). Google Meet/Zoom авто-генерація через
  // OAuth акаунта тренера — окремий трек.
  const link = b.link || (kind === "online" ? `https://meet.jit.si/traineros-${crypto.randomUUID().slice(0, 12)}` : null);
  // Назва платформи для повідомлення — за доменом лінка
  function platformLabel(): string {
    if (kind === "gym") return "Зустріч у залі";
    const l = (link || "").toLowerCase();
    if (l.includes("meet.google")) return "Google Meet";
    if (l.includes("zoom.us")) return "Zoom";
    if (l.includes("jit.si")) return "Онлайн-дзвінок (Jitsi)";
    return "Онлайн-дзвінок";
  }

  const { data: mt, error } = await svc.from("meetings").insert({
    trainer_id: tr.id, client_id: clientId, starts_at: startsAt,
    duration_min: Number(b.duration_min) || 30, kind, link, note: b.note || null,
  }).select().single();
  if (error) return json({ error: String(error.message || error) }, 500);

  // Telegram клієнту з кнопками підтвердження
  let tg = false;
  try {
    if (client.tg_user_id) {
      const { data: sec } = await svc.from("trainer_secrets").select("client_bot_token").eq("trainer_id", tr.id).maybeSingle();
      const token = sec?.client_bot_token || Deno.env.get("TG_BOT_TOKEN") || "";
      if (token) {
        const who = tr.trainer_name || tr.brand_name || "Тренер";
        const where = platformLabel();
        const text = `📅 ${who} запланував зустріч\n\n${where}\n🕒 ${fmtKyiv(startsAt)} (${mt.duration_min} хв)`
          + (b.note ? `\n📝 ${b.note}` : "");
        const kb: unknown[][] = [[
          { text: "✅ Підтверджую", callback_data: `mt:yes:${mt.id}` },
          { text: "❌ Не можу", callback_data: `mt:no:${mt.id}` },
        ]];
        if (link) kb.push([{ text: "🔗 Посилання", url: link }]);
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: client.tg_user_id, text, reply_markup: { inline_keyboard: kb } }),
        });
        tg = r.ok;
      }
    }
  } catch (_) { /* зустріч створена; TG — best-effort */ }

  return json({ ok: true, meeting: mt, telegram: tg });
});

// ============================================================================
// Edge Function: formcheck-review
// Тренер (Supabase Auth JWT) відповідає на розбір техніки: текст + КІЛЬКА
// розмічених скрінів + голосові. Пише відповідь у form_check_requests + пушить
// у Telegram клієнту (медіа-група фото + текст; голосові — best-effort).
//
// Розбори 2.1: медіа зберігаються масивами (response_images/response_voices).
// Якщо запит УЖЕ reviewed — це «Доповнити розбір»: нові скріни/голос/текст
// ДОДАЮТЬСЯ до наявних (merge), а не заміщують їх. У Telegram летить лише нове.
//
// Медіа тренер вантажить у бакет form-checks НАПРЯМУ (storage RLS insert по
// своєму префіксу) ДО виклику; сюди передає лише готові paths.
//
// POST /formcheck-review
//   { request_id, response_text?, response_images?: string[], response_voices?: string[],
//     response_image_path?, response_voice_path? }   ← легасі-поля теж приймаються
//   Authorization: Bearer <supabase-jwt тренера>
// Секрети: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, (опц.) TG_BOT_TOKEN
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const svc = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function signed(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data } = await svc.storage.from("form-checks").createSignedUrl(path, 3600);
  return data?.signedUrl || null;
}
// Масив шляхів із рядка БД: новий масив, інакше легасі одиночний шлях.
function paths(arr: unknown, legacy: string | null): string[] {
  const a = Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && x) as string[] : [];
  if (a.length) return a;
  return legacy ? [legacy] : [];
}
// Масив шляхів із тіла запиту (масив + легасі одиночне поле).
function inPaths(arr: unknown, legacy: unknown): string[] {
  const a = Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && x) as string[] : [];
  if (typeof legacy === "string" && legacy && !a.includes(legacy)) a.push(legacy);
  return a;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  // 1) Автентифікація тренера
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "no auth" }, 401);
  const { data: uRes, error: uErr } = await svc.auth.getUser(jwt);
  const authUid = uRes?.user?.id;
  if (uErr || !authUid) return json({ error: "unauthorized" }, 401);
  const { data: tr0 } = await svc.from("trainers").select("id, trainer_name, brand_name").eq("owner", authUid).maybeSingle();
  const trainerId = tr0?.id;
  if (!trainerId) return json({ error: "not a trainer" }, 403);

  const body = await req.json().catch(() => ({}));
  const requestId = body.request_id as string;
  if (!requestId) return json({ error: "request_id required" }, 400);
  const text = String(body.response_text || "").trim();
  const newImgs = inPaths(body.response_images, body.response_image_path);
  const newVoices = inPaths(body.response_voices, body.response_voice_path);
  if (!text && !newImgs.length && !newVoices.length) return json({ error: "empty response" }, 400);

  // 2) Запит існує й належить цьому тренеру?
  const { data: rec } = await svc.from("form_check_requests")
    .select("id, trainer_id, client_id, exercise_name, status, response_text, response_images, response_voices, response_image_path, response_voice_path")
    .eq("id", requestId).maybeSingle();
  if (!rec || rec.trainer_id !== trainerId) return json({ error: "forbidden" }, 403);

  // 3) Доповнення чи перший розбір? (merge проти replace)
  const isTopUp = rec.status === "reviewed";
  const oldImgs = isTopUp ? paths(rec.response_images, rec.response_image_path) : [];
  const oldVoices = isTopUp ? paths(rec.response_voices, rec.response_voice_path) : [];
  const oldText = isTopUp ? String(rec.response_text || "").trim() : "";
  const mergedText = [oldText, text].filter(Boolean).join("\n\n");

  const { data: updated, error: ue } = await svc.from("form_check_requests").update({
    response_text: mergedText || null,
    response_images: [...oldImgs, ...newImgs],
    response_voices: [...oldVoices, ...newVoices],
    // Легасі-поля тримаємо синхронними з ПЕРШИМ елементом (старі клієнти читають їх).
    response_image_path: [...oldImgs, ...newImgs][0] || null,
    response_voice_path: [...oldVoices, ...newVoices][0] || null,
    status: "reviewed", reviewed_at: new Date().toISOString(), client_seen: false,
  }).eq("id", requestId).select().single();
  if (ue) return json({ error: String(ue.message || ue) }, 500);

  // 4) Telegram-пуш клієнту — ЛИШЕ нове (при доповненні старе не дублюємо)
  let tg = false;
  try {
    const { data: client } = await svc.from("clients").select("tg_user_id").eq("id", rec.client_id).maybeSingle();
    if (client?.tg_user_id) {
      const { data: sec } = await svc.from("trainer_secrets").select("client_bot_token").eq("trainer_id", trainerId).maybeSingle();
      const token = sec?.client_bot_token || Deno.env.get("TG_BOT_TOKEN") || "";
      if (token) {
        const who = tr0?.trainer_name || tr0?.brand_name || "Тренер";
        const ex = rec.exercise_name ? ` «${rec.exercise_name}»` : "";
        const head = isTopUp ? `🎯 Доповнення до розбору${ex}` : `🎯 Розбір техніки${ex}`;
        const caption = `${head}${text ? "\n\n" + text : ""}\n\n— ${who}`;
        const api = (m: string, b: unknown) => fetch(`https://api.telegram.org/bot${token}/${m}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
        });
        const imgUrls = (await Promise.all(newImgs.map(signed))).filter(Boolean) as string[];
        if (imgUrls.length > 1) {
          // Медіа-група: підпис лише на першому фото (обмеження Telegram — 1024 симв.).
          const media = imgUrls.slice(0, 10).map((url, i) => (
            i === 0 ? { type: "photo", media: url, caption: caption.slice(0, 1024) } : { type: "photo", media: url }
          ));
          const r = await api("sendMediaGroup", { chat_id: client.tg_user_id, media });
          tg = r.ok;
        } else if (imgUrls.length === 1) {
          const r = await api("sendPhoto", { chat_id: client.tg_user_id, photo: imgUrls[0], caption: caption.slice(0, 1024) });
          tg = r.ok;
        } else {
          const r = await api("sendMessage", { chat_id: client.tg_user_id, text: caption });
          tg = r.ok;
        }
        for (const v of newVoices) {
          const voiceUrl = await signed(v);
          if (voiceUrl) { try { await api("sendAudio", { chat_id: client.tg_user_id, audio: voiceUrl, title: "Голосовий розбір" }); } catch (_) {} }
        }
      }
    }
  } catch (_) { /* відповідь збережено; TG — best-effort */ }

  return json({ ok: true, request: updated, telegram: tg, topped_up: isTopUp });
});

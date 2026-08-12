// ============================================================================
// Edge Function: trainer-feedback
// Тренер (Supabase Auth JWT) пише фідбек клієнту на тренування/харчування.
// → зберігає в client_feedback + дублює в Telegram клієнту (клієнтський бот).
//
// POST /trainer-feedback  { client_id, context?, ref_date?, text }
//   Authorization: Bearer <supabase-jwt тренера>
//
// Секрети: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  // 1) Автентифікація тренера по його Supabase JWT
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "no auth" }, 401);
  const { data: userRes, error: uErr } = await svc.auth.getUser(jwt);
  const authUid = userRes?.user?.id;
  if (uErr || !authUid) return json({ error: "unauthorized" }, 401);
  // trainers.id ≠ auth.uid() — мапимо через trainers.owner = auth.uid() (як current_trainer_id()).
  const { data: tr0 } = await svc.from("trainers").select("id").eq("owner", authUid).maybeSingle();
  const trainerId = tr0?.id;
  if (!trainerId) return json({ error: "not a trainer" }, 403);

  const body = await req.json().catch(() => ({}));
  const clientId = body.client_id as string;
  const text = String(body.text || "").trim();
  const voicePath = (body.voice_path as string) || null;   // голосове тренера (бакет chat)
  if (!clientId || (!text && !voicePath)) return json({ error: "client_id + text|voice required" }, 400);

  // 2) Клієнт належить цьому тренеру?
  const { data: client } = await svc.from("clients")
    .select("id, trainer_id, tg_user_id, name").eq("id", clientId).maybeSingle();
  if (!client || client.trainer_id !== trainerId) return json({ error: "forbidden" }, 403);

  // 3) Пишемо ПОВІДОМЛЕННЯ В ЧАТ (єдина стрічка; context — лише мітка «до тренування/харчування»)
  const ctx = body.context && body.context !== "general" ? body.context : null;
  const { data: msg, error: iErr } = await svc.from("messages").insert({
    trainer_id: trainerId, client_id: clientId, sender: "trainer",
    body: text || null, voice_path: voicePath,
    context: ctx, ref_date: body.ref_date || null,
    seen_by_client: false, seen_by_trainer: true,
  }).select().single();
  if (iErr) return json({ error: String(iErr.message || iErr) }, 500);

  // 4) Дублюємо в Telegram клієнту (клієнтський бот тренера → tg_user_id клієнта)
  let tg = false;
  try {
    if (client.tg_user_id) {
      const { data: sec } = await svc.from("trainer_secrets")
        .select("client_bot_token").eq("trainer_id", trainerId).maybeSingle();
      const token = sec?.client_bot_token || Deno.env.get("TG_BOT_TOKEN") || "";
      if (token) {
        const { data: tr } = await svc.from("trainers").select("trainer_name, brand_name").eq("id", trainerId).maybeSingle();
        const who = tr?.trainer_name || tr?.brand_name || "Тренер";
        const ctxLabel = ctx === "workout" ? "тренування" : ctx === "nutrition" ? "харчування" : "";
        const head = `💬 Повідомлення від тренера${ctxLabel ? " · " + ctxLabel : ""}`;
        const api = (m: string, b: unknown) => fetch(`https://api.telegram.org/bot${token}/${m}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
        });
        if (text) {
          const r = await api("sendMessage", { chat_id: client.tg_user_id, text: `${head}\n\n${text}\n\n— ${who}` });
          tg = r.ok;
        }
        if (voicePath) {
          const { data: sg } = await svc.storage.from("chat").createSignedUrl(voicePath, 3600);
          if (sg?.signedUrl) {
            const r = await api("sendAudio", { chat_id: client.tg_user_id, audio: sg.signedUrl, title: "Голосове від тренера" });
            tg = tg || r.ok;
          }
        }
      }
    }
  } catch (_) { /* повідомлення збережено; TG — best-effort */ }

  return json({ ok: true, message: msg, telegram: tg });
});

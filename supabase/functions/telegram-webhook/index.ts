// ============================================================================
// Edge Function: telegram-webhook — ВХІДНІ повідомлення клієнт-ботів (чек-іни).
// Мультитенант: setWebhook ставиться з secret_token = trainer_id; Telegram шле
// його в X-Telegram-Bot-Api-Secret-Token → так знаємо, чий бот.
//
// Голосове/аудіо → getFile → завантажити OGG → Storage `checkins` → рядок checkins.
// Текст → чек-ін одразу з transcript=текст (без аудіо).
// callback_query (натиск інлайн-кнопки) → відповідь на намір тренуватися
//   (data = "ti:yes:<intentId>" / "ti:no:<intentId>"); спільна інфра для зустрічей (Блок 3).
// ⚠️ setWebhook має мати allowed_updates:["message","callback_query"].
// Транскрипція: OpenAI Whisper (OPENAI_API_KEY); Саммарі: Claude (ANTHROPIC_API_KEY).
// Без ключів усе працює — тренер слухає аудіо; поля лишаються null.
// kind: postworkout якщо сьогодні питали після тренування, інакше daily.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const OPENAI = Deno.env.get("OPENAI_API_KEY") || "";
const ANTHROPIC = Deno.env.get("ANTHROPIC_API_KEY") || "";
const ok = () => new Response("ok"); // Telegram очікує 200 завжди

// ── БЮДЖЕТНІ ЗАПОБІЖНИКИ (щоб AI не з'їдав гроші) ───────────────────────────
// Аудіо лишається в Storage завжди — тренер послухає. Ріжемо лише AI-виклики.
const MAX_VOICE_SEC = 240;   // >4 хв — не транскрибуємо (Whisper $0.006/хв)
const MAX_AI_PER_DAY = 4;    // не більше N AI-оброблених чек-інів на клієнта на добу
const MIN_SUMMARY_CHARS = 90; // коротку відповідь («ок», «зробив») не варто саммарити
const MAX_TRANSCRIPT_CHARS = 3000; // стеля контексту для Claude

async function botToken(tid: string): Promise<string> {
  const { data } = await svc.from("trainer_secrets").select("client_bot_token").eq("trainer_id", tid).maybeSingle();
  return data?.client_bot_token || Deno.env.get("TG_BOT_TOKEN") || "";
}
const tgApi = (tok: string, m: string, b: unknown) =>
  fetch(`https://api.telegram.org/bot${tok}/${m}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

async function transcribe(bytes: Uint8Array): Promise<string | null> {
  if (!OPENAI) return null;
  try {
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: "audio/ogg" }), "voice.ogg");
    fd.append("model", "whisper-1");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${OPENAI}` }, body: fd });
    const j = await r.json(); return j?.text || null;
  } catch { return null; }
}
// Скільки AI-оброблених чек-інів у клієнта вже сьогодні (денна стеля витрат).
async function aiUsedToday(cid: string): Promise<number> {
  const from = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
  const { count } = await svc.from("checkins")
    .select("id", { count: "exact", head: true })
    .eq("client_id", cid).gte("created_at", from).not("transcript", "is", null);
  return count || 0;
}
async function summarize(text: string, kind: string): Promise<string | null> {
  if (!ANTHROPIC || !text) return null;
  if (text.length < MIN_SUMMARY_CHARS) return null;   // коротке — тренер прочитає як є
  text = text.slice(0, MAX_TRANSCRIPT_CHARS);
  try {
    const prompt = kind === "postworkout"
      ? `Це голосовий звіт клієнта ПІСЛЯ ТРЕНУВАННЯ. Стисни у 3-4 рядки для тренера за шаблоном:\n💪 Самопочуття: …\n⚠️ Скарги/біль: … (або «немає»)\n📝 Головне: …\nТекст: ${text}`
      : `Це вечірній голосовий чек-ін стану клієнта. Стисни у 3-4 рядки для тренера за шаблоном:\n⚡ Енергія/настрій: …\n😴 Сон/відновлення: …\n⚠️ Скарги: … (або «немає»)\n📝 Головне: …\nТекст: ${text}`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
    });
    const j = await r.json(); return j?.content?.[0]?.text || null;
  } catch { return null; }
}

// ── Натиск інлайн-кнопки ────────────────────────────────────────────────────
// Формат callback_data: "<scope>:<value>:<rowId>". Зараз scope = "ti" (training
// intent). Кнопки зустрічей (Блок 3) підуть тим самим шляхом — новий scope.
async function onCallback(tid: string, cq: any): Promise<Response> {
  const tok = await botToken(tid);
  const ack = (text?: string) =>
    tgApi(tok, "answerCallbackQuery", { callback_query_id: cq.id, text: text || "" }).catch(() => null);

  const parts = String(cq.data || "").split(":");
  const [scope, value, rowId] = parts;
  if ((scope !== "ti" && scope !== "mt") || !rowId) { await ack(); return ok(); }

  // Клієнт визначається за tg_user_id того, ХТО натиснув (не за вмістом кнопки).
  const tgId = String(cq.from?.id || "");
  const { data: client } = await svc.from("clients")
    .select("id,name").eq("trainer_id", tid).eq("tg_user_id", tgId).maybeSingle();
  if (!client) { await ack(); return ok(); }

  let said = "";
  if (scope === "ti") {                                  // намір тренуватися (Блок 2)
    const { data: intent } = await svc.from("training_intents")
      .select("id,client_id").eq("id", rowId).maybeSingle();
    if (!intent || intent.client_id !== client.id) { await ack(); return ok(); }
    const answer = value === "yes" ? "yes" : "no";
    await svc.from("training_intents")
      .update({ answer, answered_at: new Date().toISOString() }).eq("id", intent.id);
    said = answer === "yes" ? "Записав: ідеш ✅ Гарного тренування!" : "Записав: сьогодні не йдеш ❌";
  } else {                                               // підтвердження зустрічі (Блок 3)
    const { data: mt } = await svc.from("meetings")
      .select("id,client_id,trainer_id,starts_at").eq("id", rowId).maybeSingle();
    if (!mt || mt.client_id !== client.id) { await ack(); return ok(); }
    const status = value === "yes" ? "confirmed" : "declined";
    await svc.from("meetings").update({ status }).eq("id", mt.id);
    said = status === "confirmed" ? "Зустріч підтверджено ✅" : "Записав: не зможеш ❌ Тренер запропонує інший час.";
    // Тренеру — пінг у адмін-бот (він планував і чекає відповіді).
    try {
      const { data: tr } = await svc.from("trainers").select("tg_chat_id").eq("id", mt.trainer_id).maybeSingle();
      const { data: sec } = await svc.from("trainer_secrets").select("admin_bot_token").eq("trainer_id", mt.trainer_id).maybeSingle();
      if (tr?.tg_chat_id && sec?.admin_bot_token) {
        const when = new Date(mt.starts_at).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
        await tgApi(sec.admin_bot_token, "sendMessage", {
          chat_id: tr.tg_chat_id,
          text: `${status === "confirmed" ? "✅" : "❌"} ${client.name || "Клієнт"} ${status === "confirmed" ? "підтвердив" : "не може"} зустріч ${when}`,
        });
      }
    } catch (_) { /* best-effort */ }
  }

  await ack(value === "yes" ? "Записав ✅" : "Записав ❌");
  // Прибираємо кнопки, щоб не тиснули двічі.
  if (cq.message?.message_id) {
    await tgApi(tok, "editMessageText", {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: said,
    }).catch(() => null);
  }
  return ok();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return ok();
  const tid = req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!/^[0-9a-f-]{36}$/.test(tid)) return ok();                       // не наш виклик — тихо ігноруємо
  const upd = await req.json().catch(() => null);
  if (upd?.callback_query) return await onCallback(tid, upd.callback_query);
  const msg = upd?.message; if (!msg?.from?.id) return ok();
  const tgId = String(msg.from.id);
  const { data: client } = await svc.from("clients")
    .select("id,name,pw_asked_at,checkin_asked_at").eq("trainer_id", tid).eq("tg_user_id", tgId).maybeSingle();
  if (!client) return ok();
  const tok = await botToken(tid);
  const today = new Date().toISOString().slice(0, 10);
  const kind = client.pw_asked_at === today ? "postworkout" : "daily";

  // Денна стеля AI на клієнта: понад ліміт зберігаємо аудіо/текст без викликів моделей.
  const aiBudgetLeft = (await aiUsedToday(client.id)) < MAX_AI_PER_DAY;

  let audioPath: string | null = null, transcript: string | null = null;
  const voice = msg.voice || msg.audio;
  if (voice?.file_id) {
    const gf = await (await fetch(`https://api.telegram.org/bot${tok}/getFile?file_id=${voice.file_id}`)).json();
    const fp = gf?.result?.file_path; if (!fp) return ok();
    const bytes = new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${tok}/${fp}`)).arrayBuffer());
    audioPath = `${tid}/${client.id}/${Date.now()}.ogg`;
    const up = await svc.storage.from("checkins").upload(audioPath, bytes, { contentType: "audio/ogg" });
    if (up.error) audioPath = null;
    const tooLong = (voice.duration || 0) > MAX_VOICE_SEC;             // довгий монолог не транскрибуємо
    if (aiBudgetLeft && !tooLong) transcript = await transcribe(bytes);
  } else if (msg.text && !msg.text.startsWith("/")) {
    transcript = msg.text.slice(0, 4000);                              // текстова відповідь — теж чек-ін
  } else return ok();

  if (!audioPath && !transcript) return ok();
  const summary = aiBudgetLeft ? await summarize(transcript || "", kind) : null;
  await svc.from("checkins").insert({ trainer_id: tid, client_id: client.id, kind, audio_path: audioPath, transcript, summary, status: "new" });
  try { await tgApi(tok, "sendMessage", { chat_id: tgId, text: "Дякую! Передав тренеру 🙌" }); } catch (_) {}
  return ok();
});

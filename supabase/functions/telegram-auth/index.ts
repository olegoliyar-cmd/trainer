// ============================================================================
// Edge Function: telegram-auth  (МУЛЬТИ-БОТ)
// Вхід клієнта через Telegram Mini App. Кожен тренер має СВІЙ клієнтський бот
// (свій токен). Тому валідуємо initData НЕ одним глобальним токеном, а токеном
// саме того тренера, до якого належить цей клієнт.
//
// Як визначаємо тренера (щоб узяти правильний бот-токен):
//   1) invite            → invites.trainer_id           (перший вхід за інвайтом)
//   2) ?trainer=<slug>   → trainers.slug                (generic-запуск бота тренера)
//   3) існуючий клієнт   → clients.tg_user_id            (повторний вхід)
//      (tgId беремо з initData БЕЗ довіри — лише щоб обрати кандидата-токен;
//       якщо initData підроблено, валідація нижче однаково впаде.)
// Токен: trainer_secrets.client_bot_token тренера; fallback → env TG_BOT_TOKEN
//   (сумісність із поточним єдиним ботом, поки токени не перенесено в БД).
//
// Секрети: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLIENT_JWT_SECRET, TG_BOT_TOKEN(опц.)
//
// POST /telegram-auth  { initData, invite?, trainer? }
//   → { token, client_id, trainer_id }
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET = Deno.env.get("CLIENT_JWT_SECRET")!;
const ENV_BOT_TOKEN = Deno.env.get("TG_BOT_TOKEN") || ""; // fallback (legacy single-bot)
const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const enc = new TextEncoder();

async function hmac(keyBytes: Uint8Array, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

// Перевірка підпису Telegram WebApp initData КОНКРЕТНИМ bot-token.
async function validateInitData(initData: string, botToken: string): Promise<Record<string, string> | null> {
  if (!botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const check = await hmac(secret, dcs);
  const hex = [...check].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== hash) return null;
  return Object.fromEntries(params.entries());
}

// tgId з initData БЕЗ перевірки підпису (лише щоб обрати кандидата-тренера).
function peekTgId(initData: string): string {
  try {
    const u = JSON.parse(new URLSearchParams(initData).get("user") || "{}");
    return String(u.id || "");
  } catch { return ""; }
}

// Токен клієнтського бота тренера (секрет) → з trainer_secrets, інакше env-fallback.
async function botTokenForTrainer(trainerId: string | null): Promise<string> {
  if (trainerId) {
    const { data } = await svc.from("trainer_secrets")
      .select("client_bot_token").eq("trainer_id", trainerId).maybeSingle();
    if (data?.client_bot_token) return data.client_bot_token as string;
  }
  return ENV_BOT_TOKEN;
}

// Фото профілю клієнта з Telegram → публічний бакет avatars → clients.tg_photo_url.
// Best-effort: будь-яка помилка не ламає вхід. Токен бота НЕ світиться (все server-side).
async function syncAvatar(cid: string, tid: string, tgId: string, botToken: string) {
  if (!botToken) return;
  const api = `https://api.telegram.org/bot${botToken}`;
  const ph = await (await fetch(`${api}/getUserProfilePhotos?user_id=${tgId}&limit=1`)).json();
  const sizes = ph?.result?.photos?.[0];
  if (!sizes?.length) return;
  // середній розмір (~320px) — достатньо для аватарки, мінімальний трафік
  const size = sizes[Math.min(1, sizes.length - 1)];
  const gf = await (await fetch(`${api}/getFile?file_id=${size.file_id}`)).json();
  const path = gf?.result?.file_path;
  if (!path) return;
  const bytes = new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${botToken}/${path}`)).arrayBuffer());
  const dest = `${tid}/${cid}.jpg`;
  const up = await svc.storage.from("avatars").upload(dest, bytes, { contentType: "image/jpeg", upsert: true });
  if (up.error) return;
  const { data: pub } = svc.storage.from("avatars").getPublicUrl(dest);
  // кеш-бастер, щоб оновлене фото перебивало старе в кеші браузера/CDN
  const url = pub.publicUrl + "?v=" + Date.now();
  await svc.from("clients").update({ tg_photo_url: url }).eq("id", cid);
}

async function issueToken(cid: string, tid: string, tg: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await create({ alg: "HS256", typ: "JWT" }, { cid, tid, tg, exp: getNumericDate(60 * 60 * 24 * 30) }, key);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const body = await req.json().catch(() => ({}));
  const initData = body.initData || "";
  if (!initData) return json({ error: "bad initData" }, 401);

  // ── 1) Визначаємо кандидата-тренера (щоб узяти правильний бот-токен) ────────
  let trainerId: string | null = null;
  let inv: any = null;
  if (body.invite) {
    const r = await svc.from("invites").select("*").eq("token", body.invite).maybeSingle();
    inv = r.data;
    if (inv) trainerId = inv.trainer_id;
  }
  if (!trainerId && body.trainer) {
    const r = await svc.from("trainers").select("id").eq("slug", body.trainer).maybeSingle();
    if (r.data) trainerId = r.data.id;
  }
  if (!trainerId) {
    const peekId = peekTgId(initData);
    if (peekId) {
      const r = await svc.from("clients").select("trainer_id").eq("tg_user_id", peekId).limit(1).maybeSingle();
      if (r.data) trainerId = r.data.trainer_id;
    }
  }

  // ── 2) Валідуємо initData ТОКЕНОМ цього тренера ────────────────────────────
  const botToken = await botTokenForTrainer(trainerId);
  const parsed = await validateInitData(initData, botToken);
  if (!parsed) return json({ error: "bad initData" }, 401);

  const tgUser = JSON.parse(parsed.user || "{}");
  const tgId = String(tgUser.id || "");
  if (!tgId) return json({ error: "no tg user" }, 401);
  const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") || "Клієнт";

  // ── 3) Уже привʼязаний клієнт? ─────────────────────────────────────────────
  let { data: client } = await svc.from("clients").select("id,trainer_id").eq("tg_user_id", tgId).limit(1).maybeSingle();

  // ── 4) Ні → привʼязуємо через invite (обовʼязковий для першого входу) ──────
  if (!client) {
    const inviteTok = body.invite;
    if (!inviteTok) return json({ error: "no invite" }, 403);
    if (!inv) {
      const r = await svc.from("invites").select("*").eq("token", inviteTok).maybeSingle();
      inv = r.data;
    }
    if (!inv) return json({ error: "invite not found" }, 404);

    if (inv.client_id) {
      const { data: c } = await svc.from("clients").update({ tg_user_id: tgId, status: "active" })
        .eq("id", inv.client_id).select("id,trainer_id").single();
      client = c;
    } else {
      const { data: c } = await svc.from("clients")
        .insert({ trainer_id: inv.trainer_id, tg_user_id: tgId, name, status: "active", stage: "active" })
        .select("id,trainer_id").single();
      client = c;
    }
    await svc.from("invites").update({ used_by_client_id: client!.id }).eq("token", inviteTok);
  }

  // Аватарка з Telegram (best-effort, не блокує вхід при помилці)
  try { await syncAvatar(client!.id, client!.trainer_id, tgId, botToken); } catch (_) {}

  const token = await issueToken(client!.id, client!.trainer_id, tgId);
  return json({ token, client_id: client!.id, trainer_id: client!.trainer_id });
});

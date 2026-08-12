// ============================================================================
// Edge Function: resolve-food — AI-ввід їжі (фото / голос / текст).
// Замінює стару GrekFit-функцію в чужому проєкті: тепер свій ключ, свій JWT.
//
// Автентифікація: client-JWT (виданий telegram-auth) — той самий, що в client-api.
// Моделі: фото/текст → Claude Haiku 4.5 (vision), голос → Whisper → Claude.
// Відповідь: { items:[{name, grams, kcal_100, p_100, c_100, f_100}], transcript }
//   (саме цю форму очікує екран перегляду в клієнті: calcByGrams).
//
// БЮДЖЕТ: денна стеля викликів на клієнта (ai_usage), ліміт розміру фото/аудіо,
//   max_tokens. Аналіз коштує копійки, але масштаб рахує гроші швидко.
// Секрети: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLIENT_JWT_SECRET,
//          ANTHROPIC_API_KEY, OPENAI_API_KEY
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const JWT_SECRET = Deno.env.get("CLIENT_JWT_SECRET")!;
const ANTHROPIC = Deno.env.get("ANTHROPIC_API_KEY") || "";
const OPENAI = Deno.env.get("OPENAI_API_KEY") || "";

// ── Бюджетні стелі ──
const MAX_CALLS_PER_DAY = 25;        // ~стільки прийомів їжі на добу ніхто не логує
const MAX_IMAGE_BYTES = 1_500_000;   // клієнт стискає до 1024px/jpeg — цього досить
const MAX_AUDIO_BYTES = 4_000_000;   // ~2-3 хв мови
const MAX_TOKENS = 700;

async function jwtKey() {
  return await crypto.subtle.importKey("raw", new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify", "sign"]);
}
const today = () => new Date().toISOString().slice(0, 10);

// Лічильник AI-викликів на клієнта за добу (спільний для майбутніх AI-фіч).
async function bumpUsage(cid: string, kind: string): Promise<number> {
  const { data } = await svc.from("ai_usage")
    .select("id,calls").eq("client_id", cid).eq("date", today()).eq("kind", kind).maybeSingle();
  if (!data) {
    await svc.from("ai_usage").insert({ client_id: cid, date: today(), kind, calls: 1 });
    return 1;
  }
  await svc.from("ai_usage").update({ calls: data.calls + 1 }).eq("id", data.id);
  return data.calls + 1;
}

const SYSTEM = `Ти — нутриціоніст-асистент. Визнач страви та їх вагу з опису або фото.
Відповідай ЛИШЕ валідним JSON без пояснень і без markdown:
{"items":[{"name":"Куряча грудка смажена","grams":180,"kcal_100":165,"p_100":31,"c_100":0,"f_100":3.6}]}
Правила: name — українською, коротко; grams — оцінка ваги ПОРЦІЇ на фото/в описі;
kcal_100/p_100/c_100/f_100 — на 100 г продукту (не на порцію!). Якщо їжі не видно — {"items":[]}.`;

// Витягуємо JSON навіть якщо модель обгорнула його в текст/```json.
function parseItems(raw: string): any[] {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : raw);
    const items = Array.isArray(obj.items) ? obj.items : [];
    return items
      .filter((i: any) => i && i.name)
      .slice(0, 10)
      .map((i: any) => ({
        name: String(i.name).slice(0, 60),
        grams: Math.max(1, Math.round(+i.grams || 100)),
        kcal_100: Math.max(0, +i.kcal_100 || 0),
        p_100: Math.max(0, +i.p_100 || 0),
        c_100: Math.max(0, +i.c_100 || 0),
        f_100: Math.max(0, +i.f_100 || 0),
      }));
  } catch { return []; }
}

async function claude(content: unknown[]): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: "user", content }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || "AI error");
  return j?.content?.[0]?.text || "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  // 1) Клієнтський JWT
  let cid: string;
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const p = await verify(token, await jwtKey()) as { cid: string };
    cid = p.cid; if (!cid) throw new Error("no scope");
  } catch { return json({ error: "unauthorized" }, 401); }

  if (!ANTHROPIC) return json({ error: "AI не налаштовано" }, 503);

  const body = await req.json().catch(() => ({}));
  const mode = String(body.mode || "text");

  // 2) Денна стеля
  const used = await bumpUsage(cid, "food");
  if (used > MAX_CALLS_PER_DAY) {
    return json({ error: "Ліміт AI-розпізнавань на сьогодні вичерпано. Додай прийом вручну." }, 429);
  }

  try {
    let transcript: string | null = null;
    let content: unknown[];

    if (mode === "photo") {
      const image = String(body.image || "");
      if (!image) return json({ error: "no image" }, 400);
      if (image.length * 0.75 > MAX_IMAGE_BYTES) return json({ error: "Фото завелике" }, 413);
      content = [
        { type: "image", source: { type: "base64", media_type: String(body.mime || "image/jpeg"), data: image } },
        { type: "text", text: "Що на фото? Оціни склад і вагу порцій." },
      ];
    } else if (mode === "voice") {
      if (!OPENAI) return json({ error: "Голосовий ввід не налаштовано" }, 503);
      const audio = String(body.audio || "");
      if (!audio) return json({ error: "no audio" }, 400);
      if (audio.length * 0.75 > MAX_AUDIO_BYTES) return json({ error: "Запис задовгий" }, 413);
      const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
      const mime = String(body.mime || "audio/webm");
      const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : "webm";
      const fd = new FormData();
      fd.append("file", new Blob([bytes], { type: mime }), `voice.${ext}`);
      fd.append("model", "whisper-1");
      fd.append("language", "uk");
      const wr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: `Bearer ${OPENAI}` }, body: fd,
      });
      const wj = await wr.json();
      transcript = wj?.text || null;
      if (!transcript) return json({ items: [], transcript: null });
      content = [{ type: "text", text: `Клієнт сказав, що з'їв: «${transcript}». Розклади на позиції з вагою.` }];
    } else {
      const text = String(body.text || "").slice(0, 500);
      if (!text) return json({ error: "no text" }, 400);
      transcript = text;
      content = [{ type: "text", text: `Клієнт з'їв: «${text}». Розклади на позиції з вагою.` }];
    }

    const items = parseItems(await claude(content));
    return json({ items, transcript });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});

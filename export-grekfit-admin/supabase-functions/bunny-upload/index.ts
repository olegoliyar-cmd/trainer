// ============================================================================
// Edge Function: bunny-upload
// Захищений посередник для завантаження відео вправ у Bunny Stream.
// Ключ Bunny — СЕКРЕТ, живе лише тут (ніколи в браузері). Схема:
//   1) браузер (тренер) → цю функцію (action=create) з назвою відео
//   2) функція створює video-обʼєкт у Bunny (з ключем) → отримує guid
//      + рахує presigned TUS-підпис (щоб браузер вантажив БАЙТИ напряму в Bunny)
//   3) браузер вантажить файл напряму в Bunny по підпису (великий файл не йде
//      через наш сервер, ключ не світиться)
//   4) браузер зберігає у нашу БД лише bunny_id + embed_url (посилання, не відео)
//
// Мультитенант: бібліотека/ключ беруться per-trainer із trainer_secrets, інакше
// платформні env. Кожному тренеру — окрема Collection у спільній бібліотеці.
//
// Секрети (Supabase → Edge Functions): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   BUNNY_LIBRARY_ID, BUNNY_API_KEY, BUNNY_CDN_HOST, BUNNY_TOKEN_AUTH_KEY(опц.)
//
// POST /bunny-upload  Authorization: Bearer <supabase access_token тренера>
//   { action: "create", title }  → { libraryId, videoId, collectionId,
//                                     tusEndpoint, signature, expire, embedUrl, cdnHost }
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
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ENV_LIB = Deno.env.get("BUNNY_LIBRARY_ID") || "";
const ENV_KEY = Deno.env.get("BUNNY_API_KEY") || "";
const CDN_HOST = Deno.env.get("BUNNY_CDN_HOST") || "";
const TOKEN_AUTH_KEY = Deno.env.get("BUNNY_TOKEN_AUTH_KEY") || "";
const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const BUNNY = "https://video.bunnycdn.com";
async function bunny(path: string, key: string, init: RequestInit = {}) {
  const r = await fetch(BUNNY + path, {
    ...init,
    headers: { AccessKey: key, "content-type": "application/json", accept: "application/json", ...(init.headers || {}) },
  });
  const txt = await r.text();
  let j: any = null; try { j = txt ? JSON.parse(txt) : null; } catch { j = txt; }
  if (!r.ok) throw new Error("bunny " + r.status + ": " + (typeof j === "string" ? j : JSON.stringify(j)));
  return j;
}

// Довготривалий підписаний embed-URL (якщо на бібліотеці ввімкнено Token Auth).
// expires далеко в майбутньому → URL можна зберегти в БД. Підпис захищає від
// підробки URL на ЧУЖІ відео (треба ключ), контент не хотлінкнеш «з нуля».
async function embedUrl(lib: string, guid: string): Promise<string> {
  const base = `https://iframe.mediadelivery.net/embed/${lib}/${guid}`;
  if (!TOKEN_AUTH_KEY) return base;
  const expires = 4102444800; // 2100-01-01
  const token = await sha256Hex(TOKEN_AUTH_KEY + guid + expires);
  return `${base}?token=${token}&expires=${expires}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  // 1) Автентифікація тренера через Supabase access_token
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!auth) return json({ error: "unauthorized" }, 401);
  const { data: uData, error: uErr } = await svc.auth.getUser(auth);
  if (uErr || !uData?.user) return json({ error: "unauthorized" }, 401);

  const { data: trainer } = await svc.from("trainers")
    .select("id, slug, trainer_name, bunny_collection_id").eq("owner", uData.user.id).maybeSingle();
  if (!trainer) return json({ error: "no trainer profile" }, 403);

  // 2) Бібліотека/ключ: per-trainer override → інакше платформні env
  const { data: sec } = await svc.from("trainer_secrets")
    .select("bunny_library_id, bunny_api_key").eq("trainer_id", trainer.id).maybeSingle();
  const lib = (sec?.bunny_library_id || ENV_LIB) as string;
  const key = (sec?.bunny_api_key || ENV_KEY) as string;
  if (!lib || !key) return json({ error: "bunny not configured" }, 500);
  const ownLibrary = !!(sec?.bunny_library_id && sec?.bunny_api_key);

  const body = await req.json().catch(() => ({}));
  const action = body.action || "create";

  try {
    if (action === "create") {
      // 3) Collection тренера (лише у СПІЛЬНІЙ бібліотеці — для розділення).
      let collectionId = trainer.bunny_collection_id as string | null;
      if (!ownLibrary && !collectionId) {
        const col = await bunny(`/library/${lib}/collections`, key, {
          method: "POST",
          body: JSON.stringify({ name: (trainer.slug || trainer.trainer_name || "trainer") }),
        });
        collectionId = col?.guid || null;
        if (collectionId) await svc.from("trainers").update({ bunny_collection_id: collectionId }).eq("id", trainer.id);
      }

      // 4) Створити video-обʼєкт → guid
      const createBody: Record<string, unknown> = { title: (body.title || "Вправа").slice(0, 200) };
      if (collectionId) createBody.collectionId = collectionId;
      const v = await bunny(`/library/${lib}/videos`, key, { method: "POST", body: JSON.stringify(createBody) });
      const guid = v?.guid;
      if (!guid) return json({ error: "no guid from bunny" }, 502);

      // 5) presigned TUS-підпис для прямого аплоуду з браузера
      const expire = Math.floor(Date.now() / 1000) + 2 * 60 * 60; // 2 год
      const signature = await sha256Hex(lib + key + expire + guid);

      return json({
        libraryId: lib,
        videoId: guid,
        collectionId,
        tusEndpoint: BUNNY + "/tusupload",
        signature,
        expire,
        cdnHost: CDN_HOST,
        embedUrl: await embedUrl(lib, guid),
      });
    }

    return json({ error: "unknown action: " + action }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

// ============================================================================
// Edge Function: admin-api  (СУПЕР-АДМІН / база контролю)
// Платформний власник бачить УСІХ тренерів і заводить нових. Це поза RLS
// (RLS скоупить тренера лише на себе), тому працює через service_role, але
// СТРОГО за перевіркою: user_id виклику має бути в public.platform_admins.
//
// Секрети: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// POST /admin-api  Authorization: Bearer <supabase access_token супер-адміна>
//   { action: "trainers.list" }                              → { trainers:[…] }
//   { action: "trainer.create", email,password,slug,brand_name,trainer_name,accent_color }
//                                                             → { ok, trainer_id, email, slug }
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

// Дефолти нового тренера (шаблон = як у GREKFIT) ------------------------------
const DEFAULT_PIPELINE = [
  { key: "new", label: "Заявка" }, { key: "contact", label: "Контакт" },
  { key: "work", label: "Робота" }, { key: "active", label: "Активний" },
  { key: "paused", label: "Пауза" }, { key: "done", label: "Завершив" },
];
const DEFAULT_GROUPS = [
  { key: "chest", label: "Груди" }, { key: "back", label: "Спина" }, { key: "legs", label: "Ноги" },
  { key: "shoulders", label: "Плечі" }, { key: "arms", label: "Руки" }, { key: "core", label: "Прес" },
  { key: "full", label: "Все тіло" }, { key: "functional", label: "Функціонал" }, { key: "cardio", label: "Кардіо" },
];

function accentFromHex(hex: string) {
  const h = (hex || "#E8FF00").replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const dk = (x: number) => Math.round(x * 0.82).toString(16).padStart(2, "0");
  return {
    color: "#" + h, deep: "#" + dk(r) + dk(g) + dk(b),
    faint: `rgba(${r},${g},${b},.04)`, glow: `rgba(${r},${g},${b},.12)`, ring: `rgba(${r},${g},${b},.25)`,
  };
}
const slugRe = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  // ── Gate: лише супер-адмін ──────────────────────────────────────────────────
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!auth) return json({ error: "unauthorized" }, 401);
  const { data: uData, error: uErr } = await svc.auth.getUser(auth);
  if (uErr || !uData?.user) return json({ error: "unauthorized" }, 401);
  const { data: admin } = await svc.from("platform_admins").select("user_id").eq("user_id", uData.user.id).maybeSingle();
  if (!admin) return json({ error: "forbidden" }, 403);

  const body = await req.json().catch(() => ({}));
  const action = body.action as string;

  try {
    if (action === "trainers.list") {
      const [tr, sec, cl] = await Promise.all([
        svc.from("trainers").select("id,slug,brand_name,trainer_name,client_bot_username,trainer_bot_username,platform_status,platform_plan,created_at").order("created_at"),
        svc.from("trainer_secrets").select("trainer_id, client_bot_token"),
        svc.from("clients").select("trainer_id"),
      ]);
      const hasTok: Record<string, boolean> = {};
      (sec.data || []).forEach((s: any) => { if (s.client_bot_token) hasTok[s.trainer_id] = true; });
      const cnt: Record<string, number> = {};
      (cl.data || []).forEach((c: any) => { cnt[c.trainer_id] = (cnt[c.trainer_id] || 0) + 1; });
      const trainers = (tr.data || []).map((t: any) => ({
        ...t, bot_connected: !!hasTok[t.id], clients_count: cnt[t.id] || 0,
      }));
      return json({ trainers });
    }

    if (action === "trainer.create") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const slug = String(body.slug || "").trim().toLowerCase();
      const brand_name = String(body.brand_name || "").trim() || "FITCOACH";
      const trainer_name = String(body.trainer_name || "").trim() || "Тренер";
      if (!email || !password) return json({ error: "email і пароль обовʼязкові" }, 400);
      if (password.length < 8) return json({ error: "пароль мінімум 8 символів" }, 400);
      if (!slugRe.test(slug)) return json({ error: "slug: лат. літери/цифри/дефіс, 3–32" }, 400);

      const { data: exists } = await svc.from("trainers").select("id").eq("slug", slug).maybeSingle();
      if (exists) return json({ error: "slug вже зайнято" }, 409);

      // 1) auth-акаунт тренера
      const { data: created, error: cErr } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
      if (cErr || !created?.user) return json({ error: "auth: " + (cErr?.message || "не вдалось створити") }, 400);

      // 2) рядок trainers (з дефолтами)
      const { data: t, error: tErr } = await svc.from("trainers").insert({
        owner: created.user.id, slug, brand_name, trainer_name,
        accent: accentFromHex(body.accent_color), pipeline: DEFAULT_PIPELINE, exercise_groups: DEFAULT_GROUPS,
        platform_status: "trial",
      }).select("id").single();
      if (tErr || !t) {
        await svc.auth.admin.deleteUser(created.user.id).catch(() => {});  // відкат, щоб не лишати orphan
        return json({ error: "trainers: " + (tErr?.message || "не вдалось") }, 400);
      }
      return json({ ok: true, trainer_id: t.id, email, slug });
    }

    return json({ error: "unknown action: " + action }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

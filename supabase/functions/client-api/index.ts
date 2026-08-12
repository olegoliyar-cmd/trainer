// ============================================================================
// Edge Function: client-api
// Захищений бекенд для КЛІЄНТСЬКОГО апу. Клієнт (Telegram Mini App) не має
// прямого доступу до тенантних таблиць (RLS блокує anon). Натомість він шле
// підписаний client-JWT (виданий telegram-auth), а ця функція від service_role
// робить операції, СКОУПЛЕНІ строго по client_id з токена.
//
// Секрети (Supabase → Edge Functions → Secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLIENT_JWT_SECRET
//
// Виклик: POST /client-api  { action: "...", ...payload }
//   Authorization: Bearer <client-jwt>
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET = Deno.env.get("CLIENT_JWT_SECRET")!;

const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function jwtKey() {
  return await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify", "sign"],
  );
}

function today() { return new Date().toISOString().slice(0, 10); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  // 1) Автентифікація клієнта по client-JWT
  let cid: string, tid: string;
  try {
    const auth = req.headers.get("Authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const payload = await verify(token, await jwtKey()) as { cid: string; tid: string };
    cid = payload.cid; tid = payload.tid;
    if (!cid || !tid) throw new Error("no scope");
  } catch { return json({ error: "unauthorized" }, 401); }

  const body = await req.json().catch(() => ({}));
  const action = body.action as string;

  try {
    switch (action) {
      // ── Бандл клієнта: він сам + бренд тренера + призначена програма ──
      case "bundle": {
        const { data: client } = await svc.from("clients").select("*").eq("id", cid).single();
        const { data: trainer } = await svc.from("trainers")
          .select("id,slug,brand_name,trainer_name,photo_url,telegram_chat_url,accent").eq("id", tid).single();
        const { data: a } = await svc.from("assignments").select("program_id")
          .eq("client_id", cid).order("assigned_at", { ascending: false }).limit(1).maybeSingle();
        let assignedProgram = null;
        if (a?.program_id) {
          const { data: p } = await svc.from("programs").select("*").eq("id", a.program_id).single();
          assignedProgram = p;
        }
        return json({ client, trainer, assignedProgram });
      }

      // ── Тренування ──
      case "logs.list":
        return json(await sel("workout_logs", (q) => q.eq("client_id", cid).order("date", { ascending: false })));
      case "logs.create": {
        const d = body.data || {};
        const createdLog = await ins("workout_logs", {
          trainer_id: tid, client_id: cid, date: d.date || today(), day_key: d.day_key ?? null,
          day_name: d.day_name ?? null, exercise: d.exercise ?? null, sets: d.sets ?? [],
        });
        // Сповіщення тренеру — НЕ тут (на кожну вправу), а одним підсумком на фініші
        // (див. action "workout.summary"), щоб було з тоннажем/підходами/самопочуттям.
        return json(createdLog);
      }
      // Підсумок тренування → одне гарне сповіщення тренеру (fire-and-forget).
      case "workout.summary": {
        try { await notifyWorkoutSummary(tid, cid, body.data || {}); } catch (_) {}
        return json({ ok: true });
      }
      case "logs.delete":
        await svc.from("workout_logs").delete().eq("id", body.id).eq("client_id", cid); return json({ ok: true });

      // ── Харчування ──
      case "nutrition.list":
        return json(await sel("nutrition_logs", (q) => q.eq("client_id", cid)
          .order("date", { ascending: false }).order("time", { ascending: false })));
      case "nutrition.add": {
        const d = body.data || {};
        const items = Array.isArray(d.items) ? d.items : [];
        const sum = items.reduce((a: any, it: any) => ({
          kcal: a.kcal + (+it.kcal || 0), protein: a.protein + (+it.protein || 0),
          carbs: a.carbs + (+it.carbs || 0), fat: a.fat + (+it.fat || 0),
        }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
        const has = items.length > 0;
        return json(await ins("nutrition_logs", {
          trainer_id: tid, client_id: cid, date: d.date || today(), time: d.time || new Date().toISOString().slice(11, 16),
          slot: d.slot === "snack" ? "snack" : "meal", slot_idx: d.slot_idx ?? 0, label: d.label ?? null,
          kind: d.kind || "text", text: d.text || "", photo: d.photo ?? null, items,
          kcal: d.kcal ?? (has ? Math.round(sum.kcal) : null), protein: d.protein ?? (has ? Math.round(sum.protein) : null),
          carbs: d.carbs ?? (has ? Math.round(sum.carbs) : null), fat: d.fat ?? (has ? Math.round(sum.fat) : null), reviewed: false,
        }));
      }
      case "nutrition.delete":
        await svc.from("nutrition_logs").delete().eq("id", body.id).eq("client_id", cid); return json({ ok: true });

      // ── Анкета/профіль клієнта: стать/ціль/досвід/вага/зріст з онборду → рядок клієнта ──
      case "profile.update": {
        const d = body.data || {};
        const row: Record<string, unknown> = {};
        if (d.sex) row.sex = String(d.sex);
        if (d.goal) row.goal = String(d.goal);
        if (d.level) row.level = String(d.level);
        if (d.weight != null && d.weight !== "") row.weight = Number(d.weight);
        if (d.height != null && d.height !== "") row.height = Number(d.height);
        if (!Object.keys(row).length) return json({ ok: true });
        const { data: updated, error } = await svc.from("clients").update(row).eq("id", cid).select().single();
        if (error) throw error;
        return json(updated);
      }

      // ── Виміри ──
      case "measurement.add": {
        const d = body.data || {};
        const row: any = { trainer_id: tid, client_id: cid, date: d.date || today() };
        for (const k of ["weight", "waist", "chest", "hip", "arm", "thigh", "bodyfat", "height"]) {
          if (d[k] != null && d[k] !== "") row[k] = Number(d[k]);
        }
        // ідемпотентно за датою
        await svc.from("client_measurements").delete().eq("client_id", cid).eq("date", row.date);
        return json(await ins("client_measurements", row));
      }

      // ── Фото прогресу ──
      // Оригінал (повна якість) → приватний бакет progress-photos; thumb лишається в рядку.
      case "photo.uploadUrl": {
        const ext = String((body.data?.ext || "jpg")).replace(/[^a-z0-9]/gi, "").slice(0, 5) || "jpg";
        const path = `${tid}/${cid}/${crypto.randomUUID()}.${ext}`;
        const { data, error } = await svc.storage.from("progress-photos").createSignedUploadUrl(path);
        if (error) throw error;
        const uploadUrl = `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/upload/sign/progress-photos/${path}?token=${data.token}`;
        return json({ path, uploadUrl });
      }
      case "photo.add": {
        const d = body.data || {};
        return json(await ins("client_photos", {
          trainer_id: tid, client_id: cid, date: d.date || today(), pose: d.pose || "front",
          note: d.note || "", thumb: d.thumb || "", path: d.path || null,
        }));
      }
      // Signed URL на оригінал (перегляд у повній якості + завантаження).
      case "photo.url": {
        const { data: row } = await svc.from("client_photos")
          .select("path").eq("id", body.id).eq("client_id", cid).maybeSingle();
        if (!row?.path) return json({ url: null });
        const { data } = await svc.storage.from("progress-photos").createSignedUrl(row.path, 3600);
        return json({ url: data?.signedUrl || null });
      }
      case "photo.delete": {
        const { data: row } = await svc.from("client_photos")
          .select("path").eq("id", body.id).eq("client_id", cid).maybeSingle();
        if (row?.path) { try { await svc.storage.from("progress-photos").remove([row.path]); } catch (_) {} }
        await svc.from("client_photos").delete().eq("id", body.id).eq("client_id", cid);
        return json({ ok: true });
      }

      // ── ЗУСТРІЧІ (Блок 3): найближчі + підтвердження з апу ──
      case "meetings.list": {
        const from = new Date(Date.now() - 2 * 3600 * 1000).toISOString();   // ще 2 год після початку показуємо
        return json(await sel("meetings", (q) => q.eq("client_id", cid)
          .gte("starts_at", from).in("status", ["planned", "confirmed"])
          .order("starts_at", { ascending: true }).limit(10)));
      }
      case "meetings.respond": {
        const st = body.data?.status === "confirmed" ? "confirmed" : "declined";
        const { data: mt } = await svc.from("meetings")
          .select("id, client_id").eq("id", body.id).maybeSingle();
        if (!mt || mt.client_id !== cid) return json({ error: "forbidden" }, 403);
        await svc.from("meetings").update({ status: st }).eq("id", mt.id);
        return json({ ok: true, status: st });
      }

      // ── ЩОДЕННИЙ ЗВІТ (квіз) ──────────────────────────────────────────────
      // Чек-лист конфігурований: клієнт → тренер → дефолт. Скоринг рахуємо на сервері,
      // щоб тренерські % не залежали від версії клієнтського апу.
      case "report.config": {
        const { data: c } = await svc.from("clients")
          .select("report_config, report_daily, train_days").eq("id", cid).maybeSingle();
        const { data: tr } = await svc.from("trainers").select("report_template").eq("id", tid).maybeSingle();
        const cfg = expandConfig(c?.report_config || tr?.report_template || DEFAULT_REPORT, c?.train_days || []);
        const day = new Date().toISOString().slice(0, 10);
        const { data: done } = await svc.from("daily_reports")
          .select("answers, score").eq("client_id", cid).eq("date", day).maybeSingle();
        return json({
          config: cfg, enabled: c?.report_daily !== false,
          train_days: c?.train_days || [], today: done || null,
        });
      }
      case "report.submit": {
        const d = body.data || {};
        const date = d.date || today();
        const answers = d.answers || {};
        const { data: c } = await svc.from("clients").select("report_config, train_days").eq("id", cid).maybeSingle();
        const { data: tr } = await svc.from("trainers").select("report_template").eq("id", tid).maybeSingle();
        const cfg = expandConfig(c?.report_config || tr?.report_template || DEFAULT_REPORT, c?.train_days || []);
        const score = scoreReport(cfg, answers, date);
        const { data: row, error } = await svc.from("daily_reports")
          .upsert({ trainer_id: tid, client_id: cid, date, answers, score }, { onConflict: "client_id,date" })
          .select().single();
        if (error) throw error;
        return json(row);
      }
      case "report.history":
        return json(await sel("daily_reports", (q) => q.eq("client_id", cid)
          .order("date", { ascending: false }).limit(60)));

      // ── ЧАТ тренер↔клієнт (внутрішній месенджер: текст + голосові) ──
      case "chat.list": {
        const { data: rows } = await svc.from("messages")
          .select("*").eq("client_id", cid).order("created_at", { ascending: true }).limit(200);
        const out = [];
        for (const m of rows || []) {
          let voice_url: string | null = null;
          if (m.voice_path) {
            const { data } = await svc.storage.from("chat").createSignedUrl(m.voice_path, 6 * 3600);
            voice_url = data?.signedUrl || null;
          }
          out.push({
            id: m.id, sender: m.sender, body: m.body, context: m.context, ref_date: m.ref_date,
            created_at: m.created_at, seen_by_client: m.seen_by_client, voice_url,
          });
        }
        return json(out);
      }
      case "chat.voiceUploadUrl": {
        const ext = String((body.data?.ext || "webm")).replace(/[^a-z0-9]/gi, "").slice(0, 5) || "webm";
        const path = `${tid}/${cid}/${crypto.randomUUID()}.${ext}`;
        const { data, error } = await svc.storage.from("chat").createSignedUploadUrl(path);
        if (error) throw error;
        const uploadUrl = `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/upload/sign/chat/${path}?token=${data.token}`;
        return json({ path, uploadUrl });
      }
      case "chat.send": {
        const d = body.data || {};
        const text = String(d.text || "").trim().slice(0, 4000);
        if (!text && !d.voice_path) return json({ error: "empty" }, 400);
        const msg = await ins("messages", {
          trainer_id: tid, client_id: cid, sender: "client", body: text || null,
          voice_path: d.voice_path || null, seen_by_client: true, seen_by_trainer: false,
        });
        try { await notifyChat(tid, cid, text, !!d.voice_path); } catch (_) {}
        return json(msg);
      }
      case "chat.seen":
        await svc.from("messages").update({ seen_by_client: true })
          .eq("client_id", cid).eq("sender", "trainer").eq("seen_by_client", false);
        return json({ ok: true });

      // ── Фідбек тренера (легасі; історія лишається читабельною) ──
      case "feedback.list":
        return json(await sel("client_feedback", (q) => q.eq("client_id", cid)
          .order("created_at", { ascending: false }).limit(50)));
      case "feedback.seen":
        await svc.from("client_feedback").update({ seen: true }).eq("client_id", cid).eq("seen", false);
        return json({ ok: true });

      // ── Відео тренеру (form-check / розбір техніки) ──
      // 1) клієнт просить signed upload URL → вантажить відео напряму в Storage
      case "formcheck.uploadUrl": {
        const ext = String((body.data?.ext || "mp4")).replace(/[^a-z0-9]/gi, "").slice(0, 5) || "mp4";
        const path = `${tid}/${cid}/${crypto.randomUUID()}.${ext}`;
        const { data, error } = await svc.storage.from("form-checks").createSignedUploadUrl(path);
        if (error) throw error;
        // Абсолютний URL для простого PUT з клієнта (токен у query, auth не потрібен).
        const uploadUrl = `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/upload/sign/form-checks/${path}?token=${data.token}`;
        return json({ path, uploadUrl });
      }
      // 2) після аплоуду — створити запит на розбір + сповістити тренера
      case "formcheck.create": {
        const d = body.data || {};
        const rec = await ins("form_check_requests", {
          trainer_id: tid, client_id: cid,
          exercise_name: d.exercise_name ?? null,
          video_path: d.video_path ?? null,
          note: d.note ?? null, status: "new",
        });
        try { await notifyFormCheck(tid, cid, rec.exercise_name); } catch (_) {}
        return json(rec);
      }
      // 3) гілка «Розбори» в Чаті: свої запити + відповіді тренера (signed URLs).
      case "formcheck.list": {
        const { data: rows } = await svc.from("form_check_requests")
          .select("*").eq("client_id", cid).order("created_at", { ascending: false }).limit(50);
        // Розбори 2.1: скріни/голосові — масиви (легасі одиночні поля читаємо як [path]).
        const mediaPaths = (arr: unknown, legacy: string | null): string[] => {
          const a = Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && x) as string[] : [];
          return a.length ? a : (legacy ? [legacy] : []);
        };
        const out = [];
        for (const r of rows || []) {
          const imgUrls = (await Promise.all(
            mediaPaths(r.response_images, r.response_image_path).map(signedUrl),
          )).filter(Boolean) as string[];
          const voiceUrls = (await Promise.all(
            mediaPaths(r.response_voices, r.response_voice_path).map(signedUrl),
          )).filter(Boolean) as string[];
          out.push({
            id: r.id, exercise_name: r.exercise_name, note: r.note, status: r.status,
            created_at: r.created_at, reviewed_at: r.reviewed_at, client_seen: r.client_seen,
            media_purged_at: r.media_purged_at, response_text: r.response_text,
            video_url: await signedUrl(r.video_path),
            response_image_urls: imgUrls,
            response_voice_urls: voiceUrls,
            // легасі-поля (старі кешовані клієнти)
            response_image_url: imgUrls[0] || null,
            response_voice_url: voiceUrls[0] || null,
          });
        }
        return json(out);
      }
      // 4) позначити розбори прочитаними (скидає бейдж)
      case "formcheck.seen":
        await svc.from("form_check_requests").update({ client_seen: true })
          .eq("client_id", cid).eq("status", "reviewed").eq("client_seen", false);
        return json({ ok: true });

      // ── Apple Health: читання активності + видача персонального вебхук-URL ──
      case "health.get":
        return json(await sel("client_health", (q) => q.eq("client_id", cid)
          .order("date", { ascending: false }).limit(60)));
      case "health.setup": {
        const { data: c } = await svc.from("clients").select("health_token").eq("id", cid).maybeSingle();
        let tok = c?.health_token as string | undefined;
        if (!tok) {
          tok = crypto.randomUUID().replace(/-/g, "");
          await svc.from("clients").update({ health_token: tok }).eq("id", cid);
        }
        const base = SUPABASE_URL.replace(/\/$/, "") + "/functions/v1/health-ingest";
        return json({ token: tok, webhook_url: base + "?t=" + tok });
      }

      default:
        return json({ error: "unknown action: " + action }, 400);
    }
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});

// Signed URL на приватний обʼєкт бакета form-checks (відео клієнта / відповідь тренера).
async function signedUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data } = await svc.storage.from("form-checks").createSignedUrl(path, 6 * 3600);
  return data?.signedUrl || null;
}
async function sel(table: string, build: (q: any) => any) {
  const { data, error } = await build(svc.from(table).select("*"));
  if (error) throw error; return data;
}
// Telegram-сповіщення тренеру про тренування клієнта. Fire-and-forget, повністю
// guarded: мовчить, якщо тренер не задав tg_chat_id + admin_bot_token (+ notify_workouts).
async function notifyWorkout(tid: string, cid: string, date: string, dayName: string | null) {
  // лише на ПЕРШОМУ логу цього дня (щоб не спамити на кожну вправу)
  const { count } = await svc.from("workout_logs").select("id", { count: "exact", head: true })
    .eq("client_id", cid).eq("date", date);
  if (count && count > 1) return;
  const { data: tr } = await svc.from("trainers").select("tg_chat_id, notify_workouts").eq("id", tid).maybeSingle();
  if (!tr || tr.notify_workouts === false || !tr.tg_chat_id) return;
  const { data: sec } = await svc.from("trainer_secrets").select("admin_bot_token").eq("trainer_id", tid).maybeSingle();
  if (!sec?.admin_bot_token) return;
  const { data: cl } = await svc.from("clients").select("name").eq("id", cid).maybeSingle();
  const text = `🏋️ ${cl?.name || "Клієнт"} тренується${dayName ? " · " + dayName : ""}\n${date}`;
  await fetch(`https://api.telegram.org/bot${sec.admin_bot_token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: tr.tg_chat_id, text }),
  });
}
// Гарне підсумкове сповіщення тренеру про завершене тренування (емодзі, тоннаж,
// підходи, тривалість, самопочуття). Guarded як notifyWorkout.
async function notifyWorkoutSummary(tid: string, cid: string, d: any) {
  const { data: tr } = await svc.from("trainers").select("tg_chat_id, notify_workouts").eq("id", tid).maybeSingle();
  if (!tr || tr.notify_workouts === false || !tr.tg_chat_id) return;
  const { data: sec } = await svc.from("trainer_secrets").select("admin_bot_token").eq("trainer_id", tid).maybeSingle();
  if (!sec?.admin_bot_token) return;
  const { data: cl } = await svc.from("clients").select("name").eq("id", cid).maybeSingle();
  const name = cl?.name || "Клієнт";
  const day = d.day_name ? " · " + d.day_name : "";
  const sets = Number(d.sets) || 0;
  const exN = Number(d.exercises) || 0;
  const ton = Math.round(Number(d.tonnage) || 0);
  const tonStr = ton.toLocaleString("uk-UA");
  const lines = [`💪 <b>${name}</b> завершив тренування${day}`];
  const stats: string[] = [];
  if (exN) stats.push(`🏋️ ${exN} ${plUk(exN, "вправа", "вправи", "вправ")}`);
  if (sets) stats.push(`🔁 ${sets} ${plUk(sets, "підхід", "підходи", "підходів")}`);
  if (stats.length) lines.push(stats.join(" · "));
  if (ton > 0) lines.push(`🏋️‍♂️ Тоннаж: <b>${tonStr} кг</b>`);
  const dur = Number(d.duration_min) || (d.duration_sec ? Math.round(Number(d.duration_sec) / 60) : 0);
  if (dur > 0) lines.push(`⏱️ ${dur} хв`);
  if (d.feeling) lines.push(`📊 Самопочуття: ${d.feeling}`);
  const text = lines.join("\n");
  await fetch(`https://api.telegram.org/bot${sec.admin_bot_token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: tr.tg_chat_id, text, parse_mode: "HTML" }),
  });
}
function plUk(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}
// Telegram-сповіщення тренеру про новий запит на розбір відео. Guarded як notifyWorkout.
async function notifyFormCheck(tid: string, cid: string, exercise: string | null) {
  const { data: tr } = await svc.from("trainers").select("tg_chat_id, notify_workouts").eq("id", tid).maybeSingle();
  if (!tr || tr.notify_workouts === false || !tr.tg_chat_id) return;
  const { data: sec } = await svc.from("trainer_secrets").select("admin_bot_token").eq("trainer_id", tid).maybeSingle();
  if (!sec?.admin_bot_token) return;
  const { data: cl } = await svc.from("clients").select("name").eq("id", cid).maybeSingle();
  const text = `📹 ${cl?.name || "Клієнт"} надіслав відео на розбір${exercise ? " · " + exercise : ""}`;
  await fetch(`https://api.telegram.org/bot${sec.admin_bot_token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: tr.tg_chat_id, text }),
  });
}
// ── ЩОДЕННИЙ ЗВІТ: дефолтний чек-лист + скоринг ──────────────────────────────
// Дефолт «Зал». Шаблон «Турніки» (еталон користувача) тренер обирає в адмінці.
// Тренер може перевизначити пункти для конкретного клієнта (clients.report_config).
const DEFAULT_REPORT = {
  items: [
    { key: "training", label: "Тренування за планом", type: "bool", icon: "🏋️", useTrainDays: true },
    { key: "steps", label: "Кроки", type: "choice", icon: "👟", goal: 10000, options: [
      { v: 0, l: "<5к" }, { v: 5000, l: "5к" }, { v: 10000, l: "10к ✅" }, { v: 15000, l: "15к+" },
    ] },
    { key: "nutrition", label: "Тримався плану харчування", type: "bool", icon: "🍽" },
    { key: "walk_after_meal", label: "Активність після їди (5-10 хв)", type: "bool", icon: "🚶" },
    { key: "sleep_time", label: "Ліг спати у свій час", type: "bool", icon: "😴" },
    { key: "meal_schedule", label: "Їв за графіком", type: "bool", icon: "⏰" },
    { key: "mood", label: "Самопочуття", type: "scale", icon: "⚡", min: 1, max: 5 },
  ],
};
const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// Пункт із useTrainDays показуємо лише в дні графіка клієнта (Блок 2, clients.train_days).
function expandConfig(cfg: any, trainDays: string[]): any {
  const items = (cfg?.items || []).map((it: any) =>
    it.useTrainDays && Array.isArray(trainDays) && trainDays.length ? { ...it, days: trainDays } : it);
  return { ...cfg, items };
}
// Пункт зараховано: bool=true; choice ≥ goal (або будь-яке > 0, якщо цілі немає);
// scale — частка від максимуму. Score = % по пунктах, застосовних саме до цього дня.
function scoreReport(cfg: any, answers: Record<string, unknown>, date: string): number {
  const dow = DOW_KEYS[new Date(date + "T12:00:00Z").getUTCDay()];
  const items = (cfg?.items || []).filter((it: any) =>
    !Array.isArray(it.days) || !it.days.length || it.days.includes(dow));
  if (!items.length) return 0;
  let points = 0;
  for (const it of items) {
    const v = answers[it.key];
    if (it.type === "bool") { if (v === true) points += 1; }
    else if (it.type === "choice") {
      const n = Number(v) || 0;
      if (it.goal ? n >= it.goal : n > 0) points += 1;
      else if (it.goal && n > 0) points += Math.min(1, n / it.goal);   // частковий залік
    } else if (it.type === "scale") {
      const max = Number(it.max) || 5, n = Number(v) || 0;
      points += Math.max(0, Math.min(1, n / max));
    }
  }
  return Math.round((points / items.length) * 100);
}

// Клієнт написав у внутрішній чат → пінг тренеру в його адмін-бот (сам чат — в адмінці).
async function notifyChat(tid: string, cid: string, text: string, hasVoice: boolean) {
  const { data: tr } = await svc.from("trainers").select("tg_chat_id, notify_workouts").eq("id", tid).maybeSingle();
  if (!tr || tr.notify_workouts === false || !tr.tg_chat_id) return;
  const { data: sec } = await svc.from("trainer_secrets").select("admin_bot_token").eq("trainer_id", tid).maybeSingle();
  if (!sec?.admin_bot_token) return;
  const { data: cl } = await svc.from("clients").select("name").eq("id", cid).maybeSingle();
  const preview = hasVoice ? "🎤 голосове" : `«${text.slice(0, 120)}»`;
  await fetch(`https://api.telegram.org/bot${sec.admin_bot_token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: tr.tg_chat_id, text: `💬 ${cl?.name || "Клієнт"} написав у чат:\n${preview}` }),
  });
}
async function ins(table: string, row: Record<string, unknown>) {
  const { data, error } = await svc.from(table).insert(row).select().single();
  if (error) throw error; return data;
}

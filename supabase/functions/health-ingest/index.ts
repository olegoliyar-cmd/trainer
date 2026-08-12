// ============================================================================
// Edge Function: health-ingest  (Apple Health → наш бекенд, БЕЗ нативного апу)
// Клієнт налаштовує Apple Shortcut / застосунок «Health Auto Export», який
// POST-ить дані Health (кроки/калорії/тренування) на цей вебхук за розкладом.
// Автентифікація — per-client токен (clients.health_token) у ?t=... або заголовку
// X-Health-Token. Пишемо service_role-ом в client_health (upsert за датою).
//
// Приймає ДВА формати (універсально):
//   1) Health Auto Export:  { data: { metrics: [ {name, units, data:[{date, qty|Avg}]} ] } }
//   2) Простий (Shortcuts):  { date?, steps, activeEnergy, restingEnergy, distance,
//                              heartRate, exerciseMinutes, workouts }
//
// Секрети: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-health-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

function dayOf(v: unknown): string {
  if (!v) return new Date().toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : new Date().toISOString().slice(0, 10);
}
const num = (v: unknown): number | null => {
  const n = Number(v);
  return isFinite(n) ? n : null;
};

// Health Auto Export: name метрики → колонка + агрегація (sum або avg)
const METRIC_MAP: Record<string, { col: string; agg: "sum" | "avg" }> = {
  step_count: { col: "steps", agg: "sum" },
  active_energy: { col: "active_kcal", agg: "sum" },
  basal_energy_burned: { col: "resting_kcal", agg: "sum" },
  apple_exercise_time: { col: "exercise_min", agg: "sum" },
  walking_running_distance: { col: "distance_km", agg: "sum" },
  heart_rate: { col: "heart_rate_avg", agg: "avg" },
};

// Розбираємо будь-який формат → { "YYYY-MM-DD": {col: value} }
function parseBody(body: any): Record<string, Record<string, number>> {
  const byDate: Record<string, Record<string, number>> = {};
  const put = (date: string, col: string, val: number | null, agg: "sum" | "avg" = "sum") => {
    if (val == null) return;
    byDate[date] ??= {};
    if (agg === "avg") {
      const k = "_cnt_" + col;
      const prev = byDate[date][col] ?? 0;
      const cnt = (byDate[date][k] ?? 0) + 1;
      byDate[date][col] = (prev * (cnt - 1) + val) / cnt;
      byDate[date][k] = cnt;
    } else {
      byDate[date][col] = (byDate[date][col] ?? 0) + val;
    }
  };

  // 1) Health Auto Export
  const metrics = body?.data?.metrics;
  if (Array.isArray(metrics)) {
    for (const m of metrics) {
      const map = METRIC_MAP[m?.name];
      if (!map || !Array.isArray(m.data)) continue;
      for (const pt of m.data) {
        const d = dayOf(pt?.date);
        const q = num(pt?.qty ?? pt?.Avg ?? pt?.avg ?? pt?.value);
        put(d, map.col, q, map.agg);
      }
    }
    // тренування (workouts) — окремий масив, якщо є
    const wk = body?.data?.workouts;
    if (Array.isArray(wk)) {
      for (const w of wk) put(dayOf(w?.start ?? w?.date), "workouts", 1, "sum");
    }
    return byDate;
  }

  // 2) Простий формат (Shortcuts) — плоскі поля
  const d = dayOf(body?.date);
  put(d, "steps", num(body?.steps));
  put(d, "active_kcal", num(body?.activeEnergy ?? body?.active_kcal ?? body?.activeCalories));
  put(d, "resting_kcal", num(body?.restingEnergy ?? body?.resting_kcal));
  put(d, "distance_km", num(body?.distance ?? body?.distance_km));
  put(d, "exercise_min", num(body?.exerciseMinutes ?? body?.exercise_min));
  put(d, "workouts", num(body?.workouts));
  put(d, "heart_rate_avg", num(body?.heartRate ?? body?.heart_rate_avg), "avg");
  return byDate;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const url = new URL(req.url);
  const token = url.searchParams.get("t") || req.headers.get("x-health-token") || "";
  if (!token) return json({ error: "no token" }, 401);

  const { data: client } = await svc.from("clients")
    .select("id, trainer_id").eq("health_token", token).maybeSingle();
  if (!client) return json({ error: "bad token" }, 401);

  const body = await req.json().catch(() => ({}));
  const byDate = parseBody(body);
  const dates = Object.keys(byDate);
  if (!dates.length) return json({ ok: true, saved: 0 });

  const rows = dates.map((date) => {
    const v = byDate[date];
    const row: Record<string, unknown> = {
      trainer_id: client.trainer_id, client_id: client.id, date,
      source: body?.data?.metrics ? "health-auto-export" : "shortcut",
      updated_at: new Date().toISOString(),
    };
    for (const col of ["steps", "active_kcal", "resting_kcal", "distance_km", "exercise_min", "workouts", "heart_rate_avg"]) {
      if (v[col] != null) row[col] = col === "distance_km" ? v[col] : Math.round(v[col]);
    }
    return row;
  });

  const { error } = await svc.from("client_health").upsert(rows, { onConflict: "client_id,date" });
  if (error) return json({ error: String(error.message || error) }, 500);
  return json({ ok: true, saved: rows.length, dates });
});

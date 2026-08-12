// ============================================================================
// Edge Function: daily-automations (pg_cron щоденно ~08:05 Києва)
// 1) Клієнт затих ≥4 днів (active) → TG тренеру (адмін-бот); анти-спам 3 дні.
// 2) Оплата: за 3 дні до paid_until і в день → TG клієнту (клієнт-бот); раз/цикл.
// 3) Програма добігає кінця (≤5 днів) → TG тренеру; раз на призначення.
// 4) Понеділок: дайджест клієнту за минулий тиждень (сесії/тоннаж) → TG.
// Захист: Authorization: Bearer CRON_SECRET. Все best-effort per-trainer.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const DAY = 86400000;
const tg = (tok: string, chat: string | number, text: string, extra?: Record<string, unknown>) =>
  fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, ...(extra || {}) }) }).catch(() => null);

// ── Час Києва (крони ходять в UTC; графік тренувань — у локальних днях клієнта) ──
const KYIV = "Europe/Kyiv";
const kyivToday = () => new Date().toLocaleDateString("en-CA", { timeZone: KYIV });          // YYYY-MM-DD
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const kyivDow = () => DOW[new Date(kyivToday() + "T12:00:00Z").getUTCDay()];
const trainsToday = (c: any) => Array.isArray(c.train_days) && c.train_days.includes(kyivDow());

Deno.serve(async (req) => {
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!Deno.env.get("CRON_SECRET") || auth !== Deno.env.get("CRON_SECRET")) return json({ error: "forbidden" }, 403);
  const now = Date.now(), today = new Date().toISOString().slice(0, 10);
  const isMonday = new Date().getUTCDay() === 1;
  const body = await req.json().catch(() => ({}));

  // ── ВЕЧІРНІЙ ПРОХІД (окремий cron ~19:05 Києва, body {run:"evening"}) ──
  // Тренувався сьогодні → «як пройшло тренування?» (kind=postworkout при відповіді);
  // інакше якщо ввімкнено checkin_daily → питання про стан дня.
  if (body.run === "evening") {
    const ev = { pw: 0, daily: 0 };
    const { data: trs } = await svc.from("trainers").select("id");
    for (const tr of trs || []) {
      const { data: sec } = await svc.from("trainer_secrets").select("client_bot_token").eq("trainer_id", tr.id).maybeSingle();
      const tok = sec?.client_bot_token || Deno.env.get("TG_BOT_TOKEN") || ""; if (!tok) continue;
      const { data: cls } = await svc.from("clients")
        .select("id,tg_user_id,stage,status,checkin_daily,checkin_asked_at,pw_asked_at").eq("trainer_id", tr.id);
      for (const c of cls || []) {
        if (!c.tg_user_id || !(c.stage === "active" || c.status === "active")) continue;
        const { data: log } = await svc.from("workout_logs").select("id").eq("client_id", c.id).eq("date", today).limit(1).maybeSingle();
        if (log && c.pw_asked_at !== today) {
          await tg(tok, c.tg_user_id, "🏋️ Якщо маєш чим поділитися — як пройшло тренування? Запиши голосове прямо сюди, тренеру буде цінно.");
          await svc.from("clients").update({ pw_asked_at: today }).eq("id", c.id); ev.pw++;
        } else if (!log && c.checkin_daily && c.checkin_asked_at !== today) {
          await tg(tok, c.tg_user_id, "🌙 Розкажи про сьогоднішній стан: як самопочуття, сон, енергія? Запиши коротке голосове — тренер послухає.");
          await svc.from("clients").update({ checkin_asked_at: today }).eq("id", c.id); ev.daily++;
        }
      }
    }
    return json({ ok: true, evening: ev });
  }

  // ── ЗУСТРІЧІ (Блок 3): нагадування за 24 год і за 1 год (крон щогодини) ──────
  if (body.run === "meeting_remind") {
    const res = { mode: "meeting_remind", rem24: 0, rem1: 0 };
    const nowMs = Date.now();
    const { data: mts } = await svc.from("meetings")
      .select("id,trainer_id,client_id,starts_at,duration_min,kind,link,status,rem24_sent,rem1_sent")
      .in("status", ["planned", "confirmed"])
      .gte("starts_at", new Date(nowMs).toISOString())
      .lte("starts_at", new Date(nowMs + 25 * 3600 * 1000).toISOString());
    for (const m of mts || []) {
      const inMs = new Date(m.starts_at).getTime() - nowMs;
      const need24 = !m.rem24_sent && inMs <= 24 * 3600 * 1000;
      const need1 = !m.rem1_sent && inMs <= 3600 * 1000;
      if (!need24 && !need1) continue;
      const { data: cl } = await svc.from("clients").select("tg_user_id,name").eq("id", m.client_id).maybeSingle();
      if (!cl?.tg_user_id) continue;
      const { data: sec } = await svc.from("trainer_secrets").select("client_bot_token").eq("trainer_id", m.trainer_id).maybeSingle();
      const tok = sec?.client_bot_token || Deno.env.get("TG_BOT_TOKEN") || ""; if (!tok) continue;
      const when = new Date(m.starts_at).toLocaleString("uk-UA", {
        timeZone: "Europe/Kyiv", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
      });
      const kb = m.link ? { inline_keyboard: [[{ text: "🔗 Приєднатися", url: m.link }]] } : undefined;
      if (need1) {                                        // за годину — важливіше, шлемо його
        await tg(tok, cl.tg_user_id, `⏰ Через годину зустріч з тренером\n🕒 ${when}`, kb ? { reply_markup: kb } : undefined);
        await svc.from("meetings").update({ rem1_sent: true, rem24_sent: true }).eq("id", m.id);
        res.rem1++;
      } else if (need24) {
        await tg(tok, cl.tg_user_id, `📅 Завтра зустріч з тренером\n🕒 ${when}`, kb ? { reply_markup: kb } : undefined);
        await svc.from("meetings").update({ rem24_sent: true }).eq("id", m.id);
        res.rem24++;
      }
    }
    return json({ ok: true, ...res });
  }

  // ── ЩОДЕННИЙ ЗВІТ (Блок 4): 19:30 — кнопка «Заповнити звіт», 21:30 — нагадування ──
  // Кнопка web_app веде на ?screen=report — Mini App відкривається ОДРАЗУ на квізі.
  if (body.run === "report_evening" || body.run === "report_remind") {
    const day = kyivToday();
    const isRemind = body.run === "report_remind";
    const res = { mode: body.run, sent: 0 };
    const APP_URL = Deno.env.get("CLIENT_APP_URL") || "https://traineros-app.pages.dev";

    const { data: trs } = await svc.from("trainers").select("id, slug");
    for (const tr of trs || []) {
      const { data: sec } = await svc.from("trainer_secrets").select("client_bot_token").eq("trainer_id", tr.id).maybeSingle();
      const tok = sec?.client_bot_token || Deno.env.get("TG_BOT_TOKEN") || ""; if (!tok) continue;
      const { data: cls } = await svc.from("clients")
        .select("id,name,tg_user_id,stage,status,report_daily,report_asked_at,report_reminded_at").eq("trainer_id", tr.id);
      for (const c of cls || []) {
        if (!c.tg_user_id || !c.report_daily) continue;
        if (!(c.stage === "active" || c.status === "active")) continue;
        // Уже заповнив сьогодні — не турбуємо.
        const { data: done } = await svc.from("daily_reports")
          .select("id").eq("client_id", c.id).eq("date", day).maybeSingle();
        if (done) continue;
        if (isRemind) {
          if (c.report_asked_at !== day) continue;          // ввечері не питали — не нагадуємо
          if (c.report_reminded_at === day) continue;       // одне нагадування на день
        } else if (c.report_asked_at === day) continue;

        const url = `${APP_URL}/?trainer=${tr.slug || ""}&screen=report`;
        const text = isRemind
          ? "⏳ Звіт за сьогодні ще не заповнений. Це 1 хвилина — і тренер бачить реальну картину."
          : "🌙 Звіт за день (1 хв)\nТренування — лише частина результату. Кроки, харчування, сон і режим вирішують не менше.\nЗаповни — тренер побачить, що реально тягне тебе назад.";
        await tg(tok, c.tg_user_id, text, {
          reply_markup: { inline_keyboard: [[{ text: "📝 Заповнити звіт", web_app: { url } }]] },
        });
        await svc.from("clients").update(
          isRemind ? { report_reminded_at: day } : { report_asked_at: day },
        ).eq("id", c.id);
        res.sent++;
      }
    }
    return json({ ok: true, ...res });
  }

  // ── ГРАФІК ТРЕНУВАНЬ (Блок 2) — три проходи тренувального дня ──────────────
  // trainday_am (ранок)  → тренеру: «сьогодні тренування у X»
  // trainday_18 (18:00)  → клієнту інлайн-кнопки «Ідеш?», якщо ще не залогував
  // trainday_21 (21:00)  → тренеру: «X не пішов, відповідь клієнта: …» (лише якщо не тренувався)
  if (body.run === "trainday_am" || body.run === "trainday_18" || body.run === "trainday_21") {
    const day = kyivToday();
    const res = { mode: body.run, am: 0, asked: 0, reported: 0 };

    // Намір на сьогодні: беремо або створюємо (unique client_id+date).
    const ensureIntent = async (tid: string, cid: string) => {
      const { data: found } = await svc.from("training_intents")
        .select("*").eq("client_id", cid).eq("date", day).maybeSingle();
      if (found) return found;
      const { data: made } = await svc.from("training_intents")
        .insert({ trainer_id: tid, client_id: cid, date: day }).select().single();
      return made;
    };
    const trainedToday = async (cid: string) => {
      const { data } = await svc.from("workout_logs").select("id").eq("client_id", cid).eq("date", day).limit(1).maybeSingle();
      return !!data;
    };

    const { data: trs } = await svc.from("trainers").select("id, tg_chat_id, notify_workouts");
    for (const tr of trs || []) {
      const { data: sec } = await svc.from("trainer_secrets").select("admin_bot_token, client_bot_token").eq("trainer_id", tr.id).maybeSingle();
      const adminTok = sec?.admin_bot_token || "";
      const clientTok = sec?.client_bot_token || Deno.env.get("TG_BOT_TOKEN") || "";
      const { data: cls } = await svc.from("clients")
        .select("id,name,tg_user_id,stage,status,train_days").eq("trainer_id", tr.id);
      const due = (cls || []).filter((c: any) =>
        (c.stage === "active" || c.status === "active") && trainsToday(c));
      if (!due.length) continue;

      if (body.run === "trainday_am") {
        if (!adminTok || !tr.tg_chat_id || tr.notify_workouts === false) continue;
        const names: string[] = [];
        for (const c of due) {
          const it = await ensureIntent(tr.id, c.id);
          if (!it || it.am_notified) continue;
          names.push(c.name || "клієнт");
          await svc.from("training_intents").update({ am_notified: true }).eq("id", it.id);
        }
        if (names.length) {                                    // одне повідомлення на тренера, не спам по клієнту
          await tg(adminTok, tr.tg_chat_id, `🏋️ Сьогодні тренування у: ${names.join(", ")}.`);
          res.am += names.length;
        }
      }

      if (body.run === "trainday_18") {
        if (!clientTok) continue;
        for (const c of due) {
          if (!c.tg_user_id) continue;
          if (await trainedToday(c.id)) continue;              // уже потренувався — не турбуємо
          const it = await ensureIntent(tr.id, c.id);
          if (!it || it.asked_at) continue;                    // питаємо один раз на день
          await tg(clientTok, c.tg_user_id, "🏋️ У тебе сьогодні тренування за графіком. Плануєш іти?", {
            reply_markup: { inline_keyboard: [[
              { text: "✅ Так", callback_data: `ti:yes:${it.id}` },
              { text: "❌ Ні", callback_data: `ti:no:${it.id}` },
            ]] },
          });
          await svc.from("training_intents").update({ asked_at: new Date().toISOString() }).eq("id", it.id);
          res.asked++;
        }
      }

      if (body.run === "trainday_21") {
        if (!adminTok || !tr.tg_chat_id || tr.notify_workouts === false) continue;
        for (const c of due) {
          if (await trainedToday(c.id)) continue;              // відбулось — тихо (сповіщення про тренування вже є)
          const it = await ensureIntent(tr.id, c.id);
          if (!it || it.night_notified) continue;
          const said = it.answer === "yes" ? "казав(ла), що йде ✅"
            : it.answer === "no" ? "попередив(ла), що не піде ❌"
            : "не відповів(ла) 🤷";
          await tg(adminTok, tr.tg_chat_id,
            `🌙 ${c.name || "Клієнт"} не пішов(ла) на тренування.\nВідповідь клієнта: ${said}.\nЩо сталося? Напиши — це той момент, коли клієнти зриваються.`);
          await svc.from("training_intents").update({ night_notified: true }).eq("id", it.id);
          res.reported++;
        }
      }
    }
    return json({ ok: true, ...res });
  }

  const st = { quiet: 0, pay: 0, progEnd: 0, digest: 0 };

  const { data: trainers } = await svc.from("trainers").select("id, trainer_name, brand_name, tg_chat_id, notify_workouts");
  for (const tr of trainers || []) {
    const { data: sec } = await svc.from("trainer_secrets").select("admin_bot_token, client_bot_token").eq("trainer_id", tr.id).maybeSingle();
    const adminTok = sec?.admin_bot_token || "", clientTok = sec?.client_bot_token || Deno.env.get("TG_BOT_TOKEN") || "";
    const { data: clients } = await svc.from("clients").select("id,name,stage,status,tg_user_id,paid_until,quiet_notified_at,pay_reminded_at").eq("trainer_id", tr.id);
    for (const c of clients || []) {
      const active = (c.stage === "active" || c.status === "active");
      // 1) затих: останній лог
      if (active && adminTok && tr.tg_chat_id && tr.notify_workouts !== false) {
        const { data: last } = await svc.from("workout_logs").select("date").eq("client_id", c.id).order("date", { ascending: false }).limit(1).maybeSingle();
        if (last?.date) {
          const days = Math.floor((now - new Date(last.date).getTime()) / DAY);
          const cool = !c.quiet_notified_at || (now - new Date(c.quiet_notified_at).getTime()) > 3 * DAY;
          if (days >= 4 && cool) {
            await tg(adminTok, tr.tg_chat_id, `😶 ${c.name} не тренується вже ${days} дн.\nНапиши — коротке «як ти?» повертає клієнтів.`);
            await svc.from("clients").update({ quiet_notified_at: new Date(now).toISOString() }).eq("id", c.id); st.quiet++;
          }
        }
      }
      // 2) оплата: T-3 і T-0
      if (active && clientTok && c.tg_user_id && c.paid_until) {
        const left = Math.ceil((new Date(c.paid_until).getTime() - now) / DAY);
        const already = c.pay_reminded_at === today;
        if ((left === 3 || left === 0) && !already) {
          const who = tr.trainer_name || tr.brand_name || "тренера";
          await tg(clientTok, c.tg_user_id, left === 3 ? `💳 Нагадування: оплата тренувань у ${who} закінчується ${c.paid_until}.` : `💳 Сьогодні (${c.paid_until}) закінчується оплата тренувань. Продовжимо?`);
          await svc.from("clients").update({ pay_reminded_at: today }).eq("id", c.id); st.pay++;
        }
      }
      // 4) понеділок-дайджест за минулі 7 днів
      if (isMonday && active && clientTok && c.tg_user_id) {
        const from = new Date(now - 7 * DAY).toISOString().slice(0, 10);
        const { data: logs } = await svc.from("workout_logs").select("date,sets").eq("client_id", c.id).gte("date", from);
        if (logs?.length) {
          const days = new Set(logs.map((l: any) => l.date)).size;
          let ton = 0; logs.forEach((l: any) => (l.sets || []).forEach((s: any) => { ton += (+s.kg || 0) * (+s.reps || 0); }));
          await tg(clientTok, c.tg_user_id, `📈 Твій тиждень: ${days} трен., тоннаж ${(ton / 1000).toFixed(1)} т 💪\nТак тримати!`); st.digest++;
        }
      }
    }
    // 3) програма добігає кінця (≤5 дн) — по останніх призначеннях
    if (adminTok && tr.tg_chat_id) {
      const { data: asg } = await svc.from("assignments").select("id,client_id,program_id,assigned_at,prog_end_notified").eq("trainer_id", tr.id).eq("prog_end_notified", false);
      for (const a of asg || []) {
        const { data: p } = await svc.from("programs").select("name,structure").eq("id", a.program_id).maybeSingle();
        const s: any = p?.structure || {};
        const months = Array.isArray(s.months) && s.months.length ? s.months.length : 1;
        const wpm = +s.weeksPerMonth || +s.weeks || 4;
        const end = new Date(a.assigned_at).getTime() + months * wpm * 7 * DAY;
        const left = Math.ceil((end - now) / DAY);
        if (left <= 5) {
          const { data: c } = await svc.from("clients").select("name").eq("id", a.client_id).maybeSingle();
          await tg(adminTok, tr.tg_chat_id, `🏁 У ${c?.name || "клієнта"} програма «${p?.name || ""}» закінчується за ${Math.max(left, 0)} дн.\nЗапропонуй наступний план — це найкращий момент утримати.`);
          await svc.from("assignments").update({ prog_end_notified: true }).eq("id", a.id); st.progEnd++;
        }
      }
    }
  }
  return json({ ok: true, ...st });
});

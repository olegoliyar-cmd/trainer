// ════════════════════════════════════════════
//  GrekFit Cloud Sync — Phase 1: Auth + Mirror
// ════════════════════════════════════════════
// Phase 1: автентифікація + дзеркальний запис у Supabase.
// Локально нічого не змінюється — localStorage лишається джерелом правди.
// Supabase отримує копію кожного gf_* запису для майбутньої синхронізації.

(function() {
  'use strict';

  const SUPABASE_URL = 'https://zlwgjdbglpymhyhfjnve.supabase.co';
  const SUPABASE_PUBLIC_KEY = 'sb_publishable_-CvBg-EqTlWcpsgicq4iRg_K8jnDgj_';

  // Stateful client
  const GF = window.GFSync = {
    ready: false,
    userId: null,
    accessToken: null,
    tgUserId: null,
    queue: [],
    queueTimer: null,
    debug: false,
    showBadge: false,  // true → видимий бейдж (для діагностики)
    log(...args) { if (this.debug) console.log('[GFSync]', ...args); },
  };

  // Security: escape any server-supplied string before it goes into innerHTML
  // (stored-XSS guard — display_name/avatar_url are user-controlled).
  const escHtml = (s) => String(s == null ? '' : s)
    .replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
  GF.escHtml = escHtml;

  // Debug badge (за замовч. прихований; ввімкнути через window.GFSync.showBadge = true)
  function setBadge(text, color) {
    if (!GF.showBadge) return;
    let el = document.getElementById('gfsync-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gfsync-badge';
      el.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0);right:8px;z-index:99999;background:' + (color||'#000') + ';color:#fff;font:11px monospace;padding:4px 8px;border-radius:0 0 8px 8px;pointer-events:auto;opacity:.9';
      el.onclick = () => el.remove();
      if (document.body) document.body.appendChild(el);
      else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(el));
    }
    el.textContent = text;
    el.style.background = color || '#000';
  }
  GF.setBadge = setBadge;

  // ── 1. AUTHENTICATE ─────────────────────────
  async function authenticate() {
    setBadge('GFSync: starting...', '#444');
    const TG = window.Telegram && window.Telegram.WebApp;
    if (!TG) {
      setBadge('no Telegram SDK', '#a00');
      return false;
    }
    if (!TG.initData) {
      setBadge('no initData (open from bot)', '#a00');
      return false;
    }
    setBadge('auth: calling edge fn...', '#555');

    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/telegram-auth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_PUBLIC_KEY,
          'Authorization': `Bearer ${SUPABASE_PUBLIC_KEY}`,
        },
        body: JSON.stringify({ initData: TG.initData }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        setBadge('auth ' + resp.status + ': ' + errText.slice(0, 40), '#a00');
        console.warn('[GFSync] auth failed:', resp.status, errText);
        return false;
      }

      const data = await resp.json();
      GF.userId = data.user_id;
      GF.tgUserId = data.tg_user_id;
      GF.accessToken = data.access_token;
      GF.ready = true;
      setBadge('✓ ' + (data.name||'') + ' tg:' + data.tg_user_id, '#0a0');
      GF.log('authenticated as', data.name, '(uid:', data.user_id, ')');

      // Telegram name might differ from saved name — keep saved if exists
      try {
        if (!localStorage.getItem('gf_user_name') && data.name) {
          localStorage.setItem('gf_user_name', data.name);
        }
      } catch {}

      return true;
    } catch (err) {
      setBadge('auth err: ' + String(err).slice(0, 60), '#a00');
      console.warn('[GFSync] auth error:', err);
      return false;
    }
  }

  // ── 2. SUPABASE WRITE HELPERS ───────────────
  async function supabaseUpsert(table, row, conflictCols) {
    if (!GF.ready) return;
    const params = conflictCols ? `?on_conflict=${conflictCols}` : '';
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_PUBLIC_KEY,
          'Authorization': `Bearer ${GF.accessToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(row),
      });
      if (!resp.ok) {
        const t = await resp.text();
        GF.log('upsert failed', table, resp.status, t);
      }
    } catch (err) {
      GF.log('upsert error', table, err);
    }
  }

  // Insert-only (для історичних таблиць як measurements, weight_log, score_events)
  async function supabaseInsert(table, row, ignoreDuplicates) {
    if (!GF.ready) return;
    const prefer = ignoreDuplicates
      ? 'resolution=ignore-duplicates,return=minimal'
      : 'return=minimal';
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_PUBLIC_KEY,
          'Authorization': `Bearer ${GF.accessToken}`,
          'Content-Type': 'application/json',
          'Prefer': prefer,
        },
        body: JSON.stringify(row),
      });
      if (!resp.ok) {
        const t = await resp.text();
        GF.log('insert failed', table, resp.status, t);
      }
    } catch (err) {
      GF.log('insert error', table, err);
    }
  }

  // ── Client-side dedupe cache ──────────────────
  // Для insert-only таблиць без UNIQUE constraint (consent_log, measurements):
  // памʼятаємо останнє синкнуте value, скіпаємо identical setItem-и.
  // Ключ зберігається з префіксом, який НЕ починається з 'gf_' → не тригерить sync.
  const DEDUPE_KEY = '__grekfit_sync_dedupe';
  let dedupeCache = {};
  try { dedupeCache = JSON.parse(localStorage.getItem(DEDUPE_KEY) || '{}'); } catch {}

  function alreadySyncedSame(key, value) {
    return dedupeCache[key] === value;
  }
  function markSynced(key, value) {
    dedupeCache[key] = value;
    try { localStorage.setItem(DEDUPE_KEY, JSON.stringify(dedupeCache)); } catch {}
  }

  // Спеціальна функція для бонусів — ідемпотентна (через event_key UNIQUE)
  async function recordBonus(eventType, delta) {
    if (!GF.ready) return;
    return supabaseInsert('score_events', {
      user_id: GF.userId,
      delta: delta,
      event_type: eventType,
      event_key: eventType,
      metadata: { source: 'sync' },
    }, true); // ignore-duplicates
  }

  // Завантажити custom-аватар (base64 data URL) у Storage + оновити users.avatar_url
  function dataURLtoBlob(dataURL) {
    const [meta, b64] = dataURL.split(',');
    const mime = (meta.match(/:(.*?);/) || ['', 'image/jpeg'])[1];
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

  let avatarUploadInFlight = false;
  async function uploadAvatar(dataURL) {
    if (!GF.ready || !GF.userId) return;
    if (avatarUploadInFlight) return;
    avatarUploadInFlight = true;
    try {
      const blob = dataURLtoBlob(dataURL);
      const ext = blob.type.includes('png') ? 'png' : (blob.type.includes('webp') ? 'webp' : 'jpg');
      const path = `${GF.userId}/avatar.${ext}`;
      const url = `${SUPABASE_URL}/storage/v1/object/avatars/${path}`;

      // PUT з upsert=true (перезаписати якщо є)
      const upResp = await fetch(url, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_PUBLIC_KEY,
          'Authorization': `Bearer ${GF.accessToken}`,
          'Content-Type': blob.type,
          'x-upsert': 'true',
        },
        body: blob,
      });
      if (!upResp.ok) { GF.log('avatar upload failed', upResp.status, await upResp.text()); return; }

      // Публічний URL з cache-buster (щоб всі побачили оновлене фото)
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/avatars/${path}?t=${Date.now()}`;
      // PATCH (не upsert) — UPDATE permission на users є, INSERT не потрібна
      const patchResp = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${GF.userId}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_PUBLIC_KEY,
          'Authorization': `Bearer ${GF.accessToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ avatar_url: publicUrl, avatar_storage_path: path }),
      });
      if (!patchResp.ok) {
        const txt = await patchResp.text();
        GF.log('avatar PATCH failed', patchResp.status, txt);
        console.warn('[GFSync] avatar PATCH failed:', patchResp.status, txt);
      }
      scheduleCommunityRefresh();
      GF.log('avatar uploaded', publicUrl);
    } catch (err) {
      GF.log('avatar upload err', err);
    } finally {
      avatarUploadInFlight = false;
    }
  }

  // Декомпозиція workout → workouts + workout_exercises + workout_sets + score_event
  async function syncWorkout(date, w) {
    if (!w || typeof w !== 'object') return;
    if (!w.startedAt && !w.endedAt && !w.day) return;

    const headers = {
      'apikey': SUPABASE_PUBLIC_KEY,
      'Authorization': `Bearer ${GF.accessToken}`,
      'Content-Type': 'application/json',
    };

    // 1. Upsert workout по (user_id, workout_date)
    const eligible = w.eligible !== false;
    const isCardio = w.type === 'cardio';
    const workoutBody = {
      user_id: GF.userId,
      workout_date: date,
      workout_type: w.type || 'strength',
      day_key: w.day || null,
      started_at: w.startedAt ? new Date(w.startedAt).toISOString() : null,
      ended_at: w.endedAt ? new Date(w.endedAt).toISOString() : null,
      duration_sec: w.durationSec || null,
      rpe_label: ['easy','normal','hard'].includes(w.rpe) ? w.rpe : null,
      total_sets: w.sets || 0,
      total_volume_kg: w.volume || 0,
      eligible: eligible,
      grek_score_delta: (eligible && !isCardio) ? 50 : 0,
      shared: !!w.shared,
      custom_name: w.day === 'CUSTOM' ? (w.name || null) : null,
    };
    let workoutId = null;
    try {
      const wResp = await fetch(
        `${SUPABASE_URL}/rest/v1/workouts?on_conflict=user_id,workout_date`,
        { method: 'POST', headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(workoutBody) }
      );
      if (!wResp.ok) { GF.log('workout upsert failed', wResp.status, await wResp.text()); return; }
      const rows = await wResp.json();
      workoutId = rows[0]?.id;
    } catch (err) { GF.log('workout upsert err', err); return; }
    if (!workoutId) return;

    // 2. Видалити старі workout_exercises (cascade прибирає sets)
    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/workout_exercises?workout_id=eq.${workoutId}`,
        { method: 'DELETE', headers }
      );
    } catch (err) { GF.log('workout_exercises cleanup err', err); }

    // 3. Bulk-insert exercises
    const exercises = Array.isArray(w.exercises) ? w.exercises : [];
    if (exercises.length === 0) {
      // No exercises (e.g., cardio entry) — все одно записати score_event
      await recordWorkoutScore(workoutId, date, w);
      return;
    }

    const exBodies = exercises.map((ex, i) => ({
      workout_id: workoutId,
      exercise_id: ex.id || ex.name || 'unknown',
      exercise_name: ex.name || 'Вправа',
      order_index: i,
      is_skipped: !!ex.skipped,
      is_superset: !!ex.ss,
      superset_key: ex.ss || null,
      is_paired_dumbbell: ex.dbl === 2 || !!ex.pairDumbbell,
    }));
    let exRows = [];
    try {
      const exResp = await fetch(
        `${SUPABASE_URL}/rest/v1/workout_exercises`,
        { method: 'POST', headers: { ...headers, 'Prefer': 'return=representation' }, body: JSON.stringify(exBodies) }
      );
      if (!exResp.ok) { GF.log('exercises insert failed', exResp.status, await exResp.text()); return; }
      exRows = await exResp.json();
    } catch (err) { GF.log('exercises insert err', err); return; }

    // 4. Bulk-insert sets через всі exercises
    const allSets = [];
    exercises.forEach((ex, i) => {
      const exId = exRows[i]?.id;
      if (!exId) return;
      const sets = Array.isArray(ex.sets) ? ex.sets : [];
      sets.forEach((s, idx) => {
        if (s == null || typeof s !== 'object') return;
        // v31 fix (Bug #6): frontend writes `set.duration` (in seconds),
        // not `set.duration_sec`. Without this fallback every timer-based set
        // landed in DB with duration_sec=NULL. Same for `set.distance` —
        // distance_weight (sled, prowler) needs a column to land in.
        allSets.push({
          workout_id: workoutId,
          workout_exercise_id: exId,
          exercise_id: ex.id || ex.name || 'unknown',
          exercise_name: ex.name || 'Вправа',
          set_number: idx + 1,
          weight_kg: typeof s.weight === 'number' ? s.weight : null,
          reps: typeof s.reps === 'number' ? s.reps : null,
          duration_sec: typeof s.duration_sec === 'number' ? s.duration_sec
                      : typeof s.duration === 'number' ? s.duration
                      : typeof s.sec === 'number' ? s.sec
                      : null,
          distance_m: typeof s.distance === 'number' ? s.distance
                    : typeof s.distance_m === 'number' ? s.distance_m
                    : null,
          is_done: true,
          is_dumbbell_pair: ex.dbl === 2 || !!ex.pairDumbbell,
        });
      });
    });

    if (allSets.length > 0) {
      try {
        await fetch(
          `${SUPABASE_URL}/rest/v1/workout_sets`,
          { method: 'POST', headers: { ...headers, 'Prefer': 'return=minimal' }, body: JSON.stringify(allSets) }
        );
      } catch (err) { GF.log('sets insert err', err); }
    }

    // 5. Score event (+50 за виконане eligible тренування)
    await recordWorkoutScore(workoutId, date, w);
  }

  async function recordWorkoutScore(workoutId, date, w) {
    if (w.eligible === false) return;  // антинакрутка — не додаємо бали
    if (w.type === 'cardio') return;   // кардіо без silового балу
    return supabaseInsert('score_events', {
      user_id: GF.userId,
      delta: 50,
      event_type: 'workout',
      event_key: 'workout:' + workoutId,
      workout_id: workoutId,
      metadata: { date: date, day: w.day || null },
    }, true);
  }

  // ── 3. KEY → TABLE MAPPING ──────────────────
  // Розкладає gf_* ключі у відповідні таблиці Supabase
  async function syncOne(key, value) {
    if (!GF.ready || !GF.userId) return;
    let parsed;
    try { parsed = JSON.parse(value); } catch { parsed = value; }

    // upsertProfile — usercase merging (тільки не-null поля, щоб не стирати)
    const upsertProfile = (fields) => {
      const clean = { user_id: GF.userId };
      for (const k in fields) {
        if (fields[k] !== null && fields[k] !== undefined && fields[k] !== '') {
          clean[k] = fields[k];
        }
      }
      return supabaseUpsert('profiles', clean, 'user_id');
    };

    switch (key) {
      case 'gf_user_name':
        return supabaseUpsert('users', { id: GF.userId, name: String(parsed) }, 'id');

      case 'gf_program_key':
        return upsertProfile({ program_key: String(parsed) });

      case 'gf_schedule_days':
        return upsertProfile({ schedule_days: Array.isArray(parsed) ? parsed : null });

      case 'gf_schedule_mode':
        return upsertProfile({ schedule_mode: String(parsed) });

      case 'gf_schedule_set':
        return upsertProfile({ schedule_set: parsed === '1' });

      case 'gf_program_intro_seen':
        return upsertProfile({ program_intro_seen: parsed === '1' });

      case 'gf_profile': {
        if (typeof parsed !== 'object' || !parsed) return;
        // Privacy toggles — використовуємо upsert напряму, бо boolean false тут має значення
        // (upsertProfile вище фільтрує falsy/empty значення, що не підходить для toggle off)
        const fields = {
          sex: parsed.sex,
          goal: parsed.goal,
          level: parsed.level,
          instagram: parsed.instagram,
          origin: parsed.origin,
          country: parsed.country,
          city: parsed.city,
          gym: parsed.gym,
          age: parsed.age,
          activity_level: parsed.activity || parsed.activity_level,
        };
        // Privacy fields — пропускаємо ТІЛЬКИ якщо явно вказано
        if (typeof parsed.show_in_directory === 'boolean') fields.show_in_directory = parsed.show_in_directory;
        if (typeof parsed.show_instagram === 'boolean') fields.show_instagram = parsed.show_instagram;
        if (typeof parsed.show_city === 'boolean') fields.show_city = parsed.show_city;
        // Notification preferences (rank-change pushes) — same pattern.
        if (typeof parsed.notify_overtaken === 'boolean') fields.notify_overtaken = parsed.notify_overtaken;
        if (typeof parsed.notify_top3 === 'boolean')      fields.notify_top3      = parsed.notify_top3;
        // Workout reminder + opt-in habit channels (evening / morning charge).
        // Серверні notify-функції читають саме ці колонки profiles — без пушу
        // тогли б нічого не давали.
        if (typeof parsed.reminder_enabled === 'boolean')              fields.reminder_enabled              = parsed.reminder_enabled;
        if (typeof parsed.reminder_hour === 'number')                  fields.reminder_hour                 = parsed.reminder_hour;
        if (typeof parsed.reminder_tz_offset_min === 'number')         fields.reminder_tz_offset_min        = parsed.reminder_tz_offset_min;
        if (typeof parsed.notif_evening_before_enabled === 'boolean')  fields.notif_evening_before_enabled  = parsed.notif_evening_before_enabled;
        if (typeof parsed.evening_reminder_hour === 'number')          fields.evening_reminder_hour         = parsed.evening_reminder_hour;
        if (typeof parsed.notif_morning_routine_enabled === 'boolean') fields.notif_morning_routine_enabled = parsed.notif_morning_routine_enabled;
        if (typeof parsed.wake_hour === 'number')                      fields.wake_hour                     = parsed.wake_hour;
        if (typeof parsed.notif_snooze_until === 'string')             fields.notif_snooze_until            = parsed.notif_snooze_until;
        return upsertProfile(fields);
      }

      case 'gf_measurements': {
        // Legacy latest-snapshot cache — повністю замінений gf_measurements_history sync.
        // No-op: history тепер authoritative джерело правди для всіх замірів.
        return;
      }

      case 'gf_measurements_history': {
        // Авторитативний sync всієї історії точок A/B/C…
        // Strategy: DELETE усіх measurements для user → bulk INSERT з recorded_at з date кожної точки.
        // Це дозволяє EDIT будь-якої точки (а не тільки latest) — БД 1:1 з локалом.
        if (!Array.isArray(parsed)) return;
        if (alreadySyncedSame(key, value)) return;
        markSynced(key, value);
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/measurements?user_id=eq.${GF.userId}`, {
            method: 'DELETE',
            headers: {
              'apikey': SUPABASE_PUBLIC_KEY,
              'Authorization': `Bearer ${GF.accessToken}`,
            },
          });
        } catch (err) { GF.log('measurements delete error', err); }
        if (parsed.length === 0) return;
        const rows = parsed.map(p => ({
          user_id: GF.userId,
          weight: p.weight != null ? p.weight : null,
          height: p.height != null ? p.height : null,
          waist:  p.waist  != null ? p.waist  : null,
          chest:  p.chest  != null ? p.chest  : null,
          biceps: p.bicep  != null ? p.bicep  : null,   // bicep (local) → biceps (БД)
          bodyfat: p.bodyfat != null ? p.bodyfat : null,
          recorded_at: p.date
            ? new Date(p.date + 'T12:00:00Z').toISOString()
            : new Date().toISOString(),
        }));
        return supabaseInsert('measurements', rows);
      }

      case 'gf_consent': {
        if (typeof parsed !== 'object' || !parsed || !parsed.version) return;
        // Skip якщо вже синкали цей самий consent (insert-only, без UNIQUE на user+version)
        if (alreadySyncedSame(key, value)) return;
        markSynced(key, value);
        return supabaseInsert('consent_log', {
          user_id: GF.userId,
          consent_version: String(parsed.version),
          documents_accepted: Array.isArray(parsed.documents) ? parsed.documents : null,
          accepted_at: parsed.accepted_at || new Date().toISOString(),
        }, true); // ignore-duplicates
      }

      case 'gf_avatar_custom': {
        if (typeof value === 'string' && value.startsWith('data:image/')) {
          await uploadAvatar(value);
        }
        return;
      }

      case 'gf_completed': {
        if (typeof parsed !== 'object' || !parsed) return;
        // Skip якщо повний обʼєкт ідентичний минулому syncу — щоб не робити DELETE+INSERT для тих самих тренувань
        if (alreadySyncedSame(key, value)) return;
        markSynced(key, value);
        const dates = Object.keys(parsed);
        for (const d of dates) {
          await syncWorkout(d, parsed[d]);
        }
        pushCachedScore();
        scheduleCommunityRefresh();
        return;
      }

      case 'gf_profile_bonus': {
        const amount = parseInt(parsed, 10) || 0;
        if (amount > 0) {
          await recordBonus('profile_bonus', amount);
          await upsertProfile({ profile_bonus_granted: true });
          pushCachedScore();
          scheduleCommunityRefresh();
        }
        return;
      }

      case 'gf_goal_bonus': {
        const amount = parseInt(parsed, 10) || 0;
        if (amount > 0) {
          await recordBonus('goal_bonus', amount);
          await upsertProfile({ goal_bonus_granted: true });
          pushCachedScore();
          scheduleCommunityRefresh();
        }
        return;
      }

      case 'gf_nutrition_profile': {
        if (typeof parsed !== 'object' || !parsed) return;
        return supabaseUpsert('nutrition_profiles', {
          user_id: GF.userId,
          target_kcal: parsed.target || null,
          tdee_kcal: parsed.tdee || null,
          protein_g: parsed.macros?.protein || null,
          carbs_g: parsed.macros?.carbs || null,
          fat_g: parsed.macros?.fat || null,
          meals_count: parsed.meals || 3,
          snacks_count: parsed.snacks || 1,
          meal_times: Array.isArray(parsed.mealTimes) ? parsed.mealTimes : null,
          snack_times: Array.isArray(parsed.snackTimes) ? parsed.snackTimes : null,
          goal: parsed.goal || null,
          pace_kg_week: parsed.pace || null,
          goal_weight_kg: parsed.goalWeight || null,
          start_weight_kg: parsed.startWeight || null,
          updated_at: new Date().toISOString(),
        }, 'user_id');
      }

      case 'gf_weight_log': {
        if (!Array.isArray(parsed)) return;
        for (const entry of parsed) {
          if (!entry || !entry.date || entry.weight == null) continue;
          await supabaseUpsert('weight_log', {
            user_id: GF.userId,
            weight_kg: entry.weight,
            recorded_date: entry.date,
            recorded_at: new Date(entry.date + 'T12:00:00Z').toISOString(),
          }, 'user_id,recorded_date');
        }
        return;
      }

      case 'gf_food_log': {
        if (typeof parsed !== 'object' || !parsed) return;
        for (const dateStr of Object.keys(parsed)) {
          await syncFoodForDate(dateStr, parsed[dateStr] || []);
        }
        return;
      }

      case 'gf_food_custom': {
        if (!Array.isArray(parsed)) return;
        const rows = parsed
          .filter(it => it && it.name)
          .map(it => ({
            user_id: GF.userId,
            name: it.name,
            cal_per_100g: it.kcal_100 ?? it.kcal100 ?? null,
            protein_per_100g: it.p_100 ?? it.p100 ?? null,
            carbs_per_100g: it.c_100 ?? it.c100 ?? null,
            fat_per_100g: it.f_100 ?? it.f100 ?? null,
          }));
        if (rows.length === 0) return;
        await supabaseUpsert('food_items_custom', rows, 'user_id,name');
        return;
      }

      case 'gf_food_recent': {
        if (!Array.isArray(parsed)) return;
        const rows = parsed.slice(0, 30).map(it => ({
          user_id: GF.userId,
          food_key: it.key || it.id || it.name || 'unknown',
          food_name: it.name || null,
          used_at: new Date().toISOString(),
        })).filter(r => r.food_key !== 'unknown');
        if (rows.length === 0) return;
        await supabaseUpsert('food_recent', rows, 'user_id,food_key');
        return;
      }

      case 'gf_week_plan': {
        if (typeof parsed !== 'object' || !parsed) return;
        const rows = Object.entries(parsed)
          .filter(([d, day]) => d && day)
          .map(([d, day]) => ({ user_id: GF.userId, date: d, day_key: String(day) }));
        if (rows.length === 0) return;
        await supabaseUpsert('week_plan', rows, 'user_id,date');
        return;
      }

      case 'gf_goal': {
        if (typeof parsed !== 'object' || !parsed) return;
        // Деактивуємо попередні цілі і вставляємо нову
        const headers = {
          'apikey': SUPABASE_PUBLIC_KEY,
          'Authorization': `Bearer ${GF.accessToken}`,
          'Content-Type': 'application/json',
        };
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/user_goals?user_id=eq.${GF.userId}&is_active=eq.true`, {
            method: 'PATCH',
            headers: { ...headers, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ is_active: false, cleared_at: new Date().toISOString() }),
          });
          await supabaseInsert('user_goals', {
            user_id: GF.userId,
            goal_text: parsed.text || null,
            answers: parsed.answers || null,
            habits: Array.isArray(parsed.habits) ? parsed.habits : null,
            is_active: true,
            set_at: parsed.set_at ? new Date(parsed.set_at).toISOString() : new Date().toISOString(),
          });
        } catch (err) { GF.log('goal sync err', err); }
        return;
      }

      case 'gf_active_workout': {
        // v32: null/undefined value (from monkey-patched removeItem call)
        // means clearActiveWorkout() ran — DELETE the row server-side too.
        if (parsed == null) {
          try {
            await fetch(
              `${SUPABASE_URL}/rest/v1/active_workouts?user_id=eq.${GF.userId}`,
              { method: 'DELETE', headers: {
                apikey: SUPABASE_PUBLIC_KEY,
                Authorization: `Bearer ${GF.accessToken}`,
              }}
            );
          } catch (err) { GF.log('active_workouts delete err', err); }
          return;
        }
        return supabaseUpsert('active_workouts', {
          user_id: GF.userId,
          state_data: parsed,
          updated_at: new Date().toISOString(),
        }, 'user_id');
      }

      case 'gf_last_set_values': {
        if (typeof parsed !== 'object' || !parsed) return;
        const rows = Object.entries(parsed)
          .filter(([exId, v]) => exId && v && typeof v === 'object')
          .map(([exId, v]) => ({
            user_id: GF.userId,
            exercise_id: exId,
            weight_kg: v.kg ?? v.weight ?? null,
            reps: v.reps ?? null,
            recorded_at: v.at ? new Date(v.at).toISOString() : new Date().toISOString(),
          }));
        if (rows.length === 0) return;
        await supabaseUpsert('last_set_cache', rows, 'user_id,exercise_id');
        return;
      }

      case 'gf_extra_planned': {
        if (!Array.isArray(parsed)) return;
        const rows = parsed
          .filter(it => it && it.id)
          .map(it => ({
            user_id: GF.userId,
            app_id: String(it.id),
            kind: it.kind || null,
            name: it.name || null,
            planned_date: (it.date && it.date !== 'undated') ? it.date : null,
            data: it,
          }));
        if (rows.length === 0) return;
        await supabaseUpsert('extra_planned', rows, 'user_id,app_id');
        return;
      }

      case 'gf_extra_sessions': {
        if (typeof parsed !== 'object' || !parsed) return;
        for (const dateStr of Object.keys(parsed)) {
          await syncExtraSessions(dateStr, parsed[dateStr] || []);
        }
        return;
      }

      case 'gf_custom_program_v1': {
        // Персональна програма (дні + вправи) → custom_programs (1 рядок на юзера).
        if (typeof parsed !== 'object' || !parsed || !parsed.days) return;
        let sched = null;
        try { sched = JSON.parse(localStorage.getItem('gf_schedule_days') || 'null'); } catch {}
        await supabaseUpsert('custom_programs', {
          user_id: GF.userId,
          mode: parsed.mode === 'month' ? 'month' : 'week',
          days: parsed.days || {},
          schedule_days: Array.isArray(sched) ? sched : null,
          updated_at: new Date().toISOString(),
        }, 'user_id');
        return;
      }

      default:
        return;
    }
  }

  // ── HELPER: sync food entries for a single date ────────────
  // Strategy: DELETE for date, then INSERT all items as separate rows
  async function syncFoodForDate(dateStr, entries) {
    if (!GF.ready || !Array.isArray(entries)) return;
    const headers = {
      'apikey': SUPABASE_PUBLIC_KEY,
      'Authorization': `Bearer ${GF.accessToken}`,
      'Content-Type': 'application/json',
    };
    try {
      // Видалити старі рядки для дня
      await fetch(
        `${SUPABASE_URL}/rest/v1/food_log?user_id=eq.${GF.userId}&log_date=eq.${dateStr}`,
        { method: 'DELETE', headers }
      );
      // Зібрати рядки до вставки
      const rows = [];
      entries.forEach(entry => {
        if (!entry || !Array.isArray(entry.items)) return;
        const isMeal = entry.type === 'meal';
        // meals: 1-3, snacks: 4-5
        const mealSlot = isMeal ? Math.min(3, (entry.idx ?? 0) + 1) : Math.min(5, 4 + (entry.idx ?? 0));
        entry.items.forEach(it => {
          if (!it || !it.name) return;
          rows.push({
            user_id: GF.userId,
            meal_slot: mealSlot,
            food_name: it.name,
            amount_g: it.grams ?? null,
            calories: it.kcal ?? null,
            protein_g: it.p ?? null,
            carbs_g: it.c ?? null,
            fat_g: it.f ?? null,
            entry_method: it.entry_method || 'manual',
            logged_at: it.loggedAt ? new Date(it.loggedAt).toISOString() : new Date(dateStr + 'T12:00:00Z').toISOString(),
            log_date: dateStr,
          });
        });
      });
      if (rows.length === 0) return;
      await fetch(`${SUPABASE_URL}/rest/v1/food_log`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify(rows),
      });
    } catch (err) { GF.log('food_log sync err', err); }
  }

  // ── HELPER: sync extra sessions for a single date ──────────
  async function syncExtraSessions(dateStr, sessions) {
    if (!GF.ready || !Array.isArray(sessions)) return;
    const headers = {
      'apikey': SUPABASE_PUBLIC_KEY,
      'Authorization': `Bearer ${GF.accessToken}`,
      'Content-Type': 'application/json',
    };
    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/extra_sessions?user_id=eq.${GF.userId}&date=eq.${dateStr}`,
        { method: 'DELETE', headers }
      );
      const rows = sessions.map(s => ({
        user_id: GF.userId,
        date: dateStr,
        kind: s.kind || null,
        name: s.name || null,
        data: s,
        duration_sec: s.durationSec ?? s.duration_sec ?? null,
      }));
      if (rows.length === 0) return;
      await fetch(`${SUPABASE_URL}/rest/v1/extra_sessions`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify(rows),
      });
    } catch (err) { GF.log('extra_sessions sync err', err); }
  }

  // Перерендерити рейтинг через 1с після останньої події
  let communityRefreshTimer = null;
  function scheduleCommunityRefresh() {
    clearTimeout(communityRefreshTimer);
    communityRefreshTimer = setTimeout(() => {
      if (typeof window.renderLeaderboard === 'function'
          && document.getElementById('leaderboard-list')) {
        window.renderLeaderboard();
      }
    }, 1000);
  }
  GF.refreshCommunity = scheduleCommunityRefresh;

  // Видалити аватар (тільки фото — інші дані лишаються)
  GF.clearServerAvatar = async function() {
    if (!GF.ready || !GF.userId) return false;
    const headers = {
      'apikey': SUPABASE_PUBLIC_KEY,
      'Authorization': `Bearer ${GF.accessToken}`,
    };
    // 1. Видалити файл зі Storage
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      try {
        await fetch(
          `${SUPABASE_URL}/storage/v1/object/avatars/${GF.userId}/avatar.${ext}`,
          { method: 'DELETE', headers }
        );
      } catch {}
    }
    // 2. Скинути avatar_url до Telegram-фото (якщо є) або null
    const tgPhoto = window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url || null;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${GF.userId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ avatar_url: tgPhoto, avatar_storage_path: null }),
      });
    } catch (err) { GF.log('clear avatar err', err); return false; }
    scheduleCommunityRefresh();
    return true;
  };

  // ── GDPR Art. 17: повне видалення серверних даних ─
  // Видаляє Storage avatar + рядок users (cascade прибирає все дочірнє).
  // Повертає Promise<boolean> — true якщо все стерто успішно.
  GF.wipeServerAccount = async function() {
    if (!GF.ready || !GF.userId) return false;
    const headers = {
      'apikey': SUPABASE_PUBLIC_KEY,
      'Authorization': `Bearer ${GF.accessToken}`,
    };

    // 1. Прибрати аватар зі Storage (всі можливі розширення)
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      try {
        await fetch(
          `${SUPABASE_URL}/storage/v1/object/avatars/${GF.userId}/avatar.${ext}`,
          { method: 'DELETE', headers }
        );
      } catch {}
    }

    // 2. Видалити сам рядок users — каскадом прибере workouts, food_log,
    //    measurements, profiles, score_events, тощо.
    try {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/users?id=eq.${GF.userId}`,
        { method: 'DELETE', headers: { ...headers, 'Prefer': 'return=minimal' } }
      );
      if (!resp.ok) {
        GF.log('user delete failed', resp.status, await resp.text());
        return false;
      }
    } catch (err) {
      GF.log('wipe error', err);
      return false;
    }

    // 3. Скинути локальний стан клієнта так, щоб подальші sync'и нічого не записували
    GF.ready = false;
    GF.userId = null;
    GF.accessToken = null;
    GF.queue.length = 0;
    return true;
  };

  // ── 4. QUEUE PROCESSOR ──────────────────────
  function flushQueue() {
    if (!GF.ready || GF.queue.length === 0) return;
    const batch = GF.queue.splice(0, GF.queue.length);
    // Дедуплікація: останній запис на ключ перемагає
    const seen = new Map();
    batch.forEach(item => seen.set(item.key, item.value));
    seen.forEach((value, key) => syncOne(key, value));
  }

  function enqueue(key, value) {
    if (!key || !key.startsWith('gf_')) return;
    GF.queue.push({ key, value, at: Date.now() });
    clearTimeout(GF.queueTimer);
    GF.queueTimer = setTimeout(flushQueue, 800);  // debounce 800мс
  }

  // ── 5. MONKEY-PATCH localStorage.setItem + removeItem ────
  const origSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function(key, value) {
    origSetItem(key, value);
    try { enqueue(key, value); } catch (err) { GF.log('enqueue err', err); }
  };
  // v32 fix: clearActiveWorkout / removeMe* used localStorage.removeItem
  // directly, so the matching DELETE never reached the server — leaving
  // stale active_workouts rows around (and missed score events when
  // finishWorkout raced apk shutdown). Patch removeItem too; we pass
  // `null` as the value so syncOne can branch into a DELETE for the
  // table-mapped keys.
  const origRemoveItem = localStorage.removeItem.bind(localStorage);
  localStorage.removeItem = function(key) {
    origRemoveItem(key);
    try { enqueue(key, null); } catch (err) { GF.log('enqueue remove err', err); }
  };

  // v32: explicit flush API. finishWorkout calls this immediately on
  // commit so the workout reaches the server BEFORE the user navigates
  // away or closes the app (Telegram WebView likes to kill pending fetches
  // when the Mini App is collapsed). Failed items go to gf_pending_sync
  // for retry on next authenticate.
  async function flushNow(timeoutMs) {
    if (!GF.ready) return { ok: false, reason: 'not_ready' };
    if (GF.queueTimer) { clearTimeout(GF.queueTimer); GF.queueTimer = null; }
    const batch = GF.queue.splice(0, GF.queue.length);
    if (batch.length === 0) return { ok: true, flushed: 0 };
    const seen = new Map();
    batch.forEach(item => seen.set(item.key, item.value));
    const results = { ok: true, flushed: 0, failed: [] };
    const runOne = async (key, value) => {
      try {
        await syncOne(key, value);
        results.flushed++;
      } catch (err) {
        results.ok = false;
        results.failed.push({ key, error: String(err && err.message || err) });
        // Persist for retry — overwrite any previous pending entry for the same key
        try {
          const pending = JSON.parse(localStorage.getItem('__gf_pending_sync') || '{}');
          pending[key] = value;
          origSetItem('__gf_pending_sync', JSON.stringify(pending));
        } catch (_) {}
      }
    };
    const tasks = [];
    seen.forEach((value, key) => tasks.push(runOne(key, value)));
    const allDone = Promise.all(tasks);
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      // Race against a hard timeout so the user isn't stuck on a spinner.
      await Promise.race([
        allDone,
        new Promise(resolve => setTimeout(resolve, timeoutMs)),
      ]);
    } else {
      await allDone;
    }
    return results;
  }
  GF.flushNow = flushNow;

  // v32: reconcile against server-side soft-deletes. If an admin (or future
  // self-delete flow) sets workouts.deleted_at, we drop those dates from
  // the local gf_completed cache on next authenticate so the user's
  // computed GrekScore doesn't bounce them back into the leaderboard.
  async function reconcileDeletedWorkouts() {
    if (!GF.ready || !GF.userId) return;
    try {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/workouts?user_id=eq.${GF.userId}&deleted_at=not.is.null&select=workout_date`,
        { headers: { apikey: SUPABASE_PUBLIC_KEY, Authorization: `Bearer ${GF.accessToken}` } }
      );
      if (!resp.ok) return;
      const rows = await resp.json();
      if (!Array.isArray(rows) || !rows.length) return;
      const deletedDates = new Set(rows.map(r => String(r.workout_date).slice(0, 10)));
      let local = {};
      try { local = JSON.parse(localStorage.getItem('gf_completed') || '{}') || {}; } catch {}
      let removed = 0;
      for (const date of deletedDates) {
        if (local[date]) { delete local[date]; removed++; }
      }
      if (removed === 0) return;
      const json = JSON.stringify(local);
      origSetItem('gf_completed', json);
      markSynced('gf_completed', json);  // suppress push-back
      GF.log('reconciled', removed, 'server-deleted workouts from local cache');
      // Re-render anything that reads gf_completed so the UI matches.
      try { if (typeof window.renderHubFeed   === 'function') window.renderHubFeed(); } catch(_){}
      try { if (typeof window.applyProfile    === 'function') window.applyProfile(); } catch(_){}
      try { if (typeof window.renderProgram   === 'function') window.renderProgram(); } catch(_){}
      try { if (typeof window.updateHubTeaser === 'function') window.updateHubTeaser(); } catch(_){}
      try { if (typeof window.renderWeekStrip === 'function') window.renderWeekStrip(); } catch(_){}
      try { if (typeof window.animateScore    === 'function') window.animateScore(); } catch(_){}
      // Push a fresh cached score derived from the cleaned data.
      try { pushCachedScore(); } catch(_){}
    } catch (err) {
      GF.log('reconcileDeletedWorkouts err', err);
    }
  }
  GF.reconcileDeletedWorkouts = reconcileDeletedWorkouts;

  // v32: retry any sync items that failed last time.
  async function retryPendingSync() {
    if (!GF.ready) return;
    let pending = {};
    try { pending = JSON.parse(localStorage.getItem('__gf_pending_sync') || '{}') || {}; } catch {}
    const keys = Object.keys(pending);
    if (!keys.length) return;
    GF.log('retrying', keys.length, 'pending sync items');
    const stillFailed = {};
    for (const key of keys) {
      try { await syncOne(key, pending[key]); }
      catch (err) { stillFailed[key] = pending[key]; GF.log('retry still failed', key, err); }
    }
    origSetItem('__gf_pending_sync', JSON.stringify(stillFailed));
  }
  GF.retryPendingSync = retryPendingSync;

  // Запушити локально-обчислений GrekScore (включно з PR/volume/RPE/week бонусами)
  let cachedScorePushTimer = null;
  function pushCachedScore() {
    clearTimeout(cachedScorePushTimer);
    cachedScorePushTimer = setTimeout(async () => {
      if (!GF.ready) return;
      try {
        const score = (typeof window.computeGrekScore === 'function')
          ? window.computeGrekScore()
          : null;
        if (!score) return;
        const completed = (typeof window.loadCompleted === 'function')
          ? window.loadCompleted()
          : {};
        const totalWorkouts = Object.values(completed || {})
          .filter(w => w && w.eligible !== false && w.type !== 'cardio').length;
        const newScore = score.total || 0;

        // Capture the previous score BEFORE upsert so the notify-rank-change
        // Edge Function can compute who got displaced. Failure here just skips
        // the notification — never blocks the score push.
        let oldScore = 0;
        try {
          const oldResp = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${GF.userId}&select=cached_grek_score`,
            { headers: { apikey: SUPABASE_PUBLIC_KEY, Authorization: `Bearer ${GF.accessToken}` } }
          );
          if (oldResp.ok) {
            const rows = await oldResp.json();
            oldScore = rows[0]?.cached_grek_score || 0;
          }
        } catch (_) { /* ignore — fall through with oldScore=0 */ }

        await supabaseUpsert('profiles', {
          user_id: GF.userId,
          cached_grek_score: newScore,
          cached_streak: score.streak || 0,
          cached_total_workouts: totalWorkouts,
          cached_at: new Date().toISOString(),
        }, 'user_id');

        // Fire-and-forget — notify-rank-change is server-side responsible for
        // privacy + gender + rate-limit, we only pass the score delta.
        if (newScore > oldScore) {
          try {
            fetch(`${SUPABASE_URL}/functions/v1/notify-rank-change`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_PUBLIC_KEY,
                'Authorization': `Bearer ${GF.accessToken}`,
              },
              body: JSON.stringify({
                user_id:   GF.userId,
                old_score: oldScore,
                new_score: newScore,
              }),
            }).catch(e => GF.log('notify-rank-change failed', e));
          } catch (_) { /* swallow */ }
        }

        scheduleCommunityRefresh();
      } catch (err) {
        GF.log('cached score push err', err);
      }
    }, 1200);
  }
  GF.pushCachedScore = pushCachedScore;

  // v31 Recovery: refetch every workout from the cloud and merge into the
  // local gf_completed map WITHOUT overwriting entries that already exist.
  // Use case: the user tapped «Скасувати виконання» which only stripped the
  // local cache; the backend `workouts` rows are untouched. This call is
  // safe to re-run — it only ADDS missing dates back.
  GF.refetchCompletedFromCloud = async function() {
    if (!GF.ready || !GF.userId) return { ok: false, reason: 'not_ready' };
    const headers = {
      apikey: SUPABASE_PUBLIC_KEY,
      Authorization: `Bearer ${GF.accessToken}`,
    };
    try {
      // 1. Pull all non-deleted workouts (most recent 6 months — adjust as needed).
      const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 200).toISOString().slice(0, 10);
      const wResp = await fetch(
        `${SUPABASE_URL}/rest/v1/workouts?user_id=eq.${GF.userId}` +
        `&workout_date=gte.${since}` +
        `&deleted_at=is.null` +
        `&select=id,workout_date,workout_type,day_key,started_at,ended_at,duration_sec,total_sets,total_volume_kg,eligible,shared,rpe_label,custom_name` +
        `&order=workout_date.desc`,
        { headers }
      );
      if (!wResp.ok) return { ok: false, reason: 'workouts_fetch_failed', status: wResp.status };
      const workouts = await wResp.json();
      if (!workouts.length) return { ok: true, restored: 0, total_in_cloud: 0 };

      // 2. exercises + sets in one round-trip each.
      const wIds = workouts.map(w => w.id).join(',');
      const exResp = await fetch(
        `${SUPABASE_URL}/rest/v1/workout_exercises?workout_id=in.(${wIds})` +
        `&select=id,workout_id,exercise_name,order_index,is_skipped,is_superset,superset_key,is_paired_dumbbell` +
        `&order=order_index`,
        { headers }
      );
      const exRows = exResp.ok ? await exResp.json() : [];
      let setRows = [];
      if (exRows.length) {
        const exIds = exRows.map(e => e.id).join(',');
        const sResp = await fetch(
          `${SUPABASE_URL}/rest/v1/workout_sets?workout_exercise_id=in.(${exIds})` +
          `&select=workout_exercise_id,set_number,weight_kg,reps,duration_sec,distance_m,is_warmup` +
          `&order=set_number`,
          { headers }
        );
        setRows = sResp.ok ? await sResp.json() : [];
      }
      const setsByEx = {};
      setRows.forEach(s => {
        if (s.is_warmup) return;
        (setsByEx[s.workout_exercise_id] ||= []).push({
          weight: s.weight_kg != null ? Number(s.weight_kg) : null,
          reps: s.reps != null ? s.reps : null,
          ...(s.duration_sec != null ? { duration_sec: s.duration_sec } : {}),
          ...(s.distance_m != null ? { distance: Number(s.distance_m) } : {}),
        });
      });

      // 3. Build the cloud's gf_completed-shaped object.
      const dbCompleted = {};
      workouts.forEach(w => {
        const wExs = exRows
          .filter(e => e.workout_id === w.id)
          .sort((a, b) => a.order_index - b.order_index);
        const exercises = wExs.map(e => {
          const ex = {
            name: e.exercise_name,
            skipped: !!e.is_skipped,
            sets: setsByEx[e.id] || [],
          };
          if (e.is_superset && e.superset_key) ex.ss = e.superset_key;
          if (e.is_paired_dumbbell) ex.dbl = 2;
          return ex;
        }).filter(ex => ex.sets.length || ex.skipped);

        const dateStr = String(w.workout_date).slice(0, 10);
        const entry = {
          type: w.workout_type || 'strength',
          day: w.day_key || null,
          sets: w.total_sets || 0,
          volume: w.total_volume_kg ? Number(w.total_volume_kg) : 0,
          startedAt: w.started_at ? new Date(w.started_at).getTime() : null,
          endedAt: w.ended_at ? new Date(w.ended_at).getTime() : null,
          durationSec: w.duration_sec || 0,
          eligible: w.eligible !== false,
          exercises,
        };
        if (w.rpe_label)   entry.rpe = w.rpe_label;
        if (w.shared)      entry.shared = true;
        if (w.custom_name) entry.customName = w.custom_name;
        // If multiple workouts share a date (main + custom), the LAST one
        // (workouts already sorted desc) wins — but we'll merge with local
        // below, and local existing entries always take precedence, so this
        // is a no-op for any date the user already has anything for.
        if (!dbCompleted[dateStr]) dbCompleted[dateStr] = entry;
      });

      // 4. Merge into local without overwriting anything that exists.
      let localCompleted = {};
      try { localCompleted = JSON.parse(localStorage.getItem('gf_completed') || '{}') || {}; } catch {}
      let restored = 0;
      for (const date in dbCompleted) {
        if (!localCompleted[date]) {
          localCompleted[date] = dbCompleted[date];
          restored++;
        }
      }
      const json = JSON.stringify(localCompleted);
      origSetItem('gf_completed', json);
      markSynced('gf_completed', json);  // suppress immediate push-back

      return { ok: true, restored, total_in_cloud: Object.keys(dbCompleted).length };
    } catch (err) {
      GF.log('refetchCompletedFromCloud err', err);
      return { ok: false, reason: 'exception', message: String(err && err.message || err) };
    }
  };

  // v31 Feature #9: upsert this user's leaderboard status message.
  // Empty/null `message` clears (DELETE). Otherwise upsert into
  // leaderboard_statuses (RLS lets users write only their own row).
  //
  // Returns {ok: true, action: 'set'|'cleared'} or
  //         {ok: false, reason: string, status?: number, body?: string}
  // so the caller can surface a real toast instead of silently failing.
  GF.pushMyStatus = async function(message) {
    if (!GF.ready) return { ok: false, reason: 'not_ready' };
    if (!GF.userId || !GF.accessToken) return { ok: false, reason: 'no_session' };
    const clean = (message || '').trim().slice(0, 30);
    const baseHeaders = {
      apikey: SUPABASE_PUBLIC_KEY,
      Authorization: `Bearer ${GF.accessToken}`,
    };
    try {
      if (!clean) {
        const resp = await fetch(
          `${SUPABASE_URL}/rest/v1/leaderboard_statuses?user_id=eq.${GF.userId}`,
          { method: 'DELETE', headers: baseHeaders }
        );
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          GF.log('pushMyStatus DELETE failed', resp.status, body);
          return { ok: false, reason: 'delete_failed', status: resp.status, body };
        }
        scheduleCommunityRefresh();
        return { ok: true, action: 'cleared' };
      }
      // PostgREST upsert: POST with `on_conflict=user_id` + Prefer
      // resolution=merge-duplicates. Use return=representation so we can
      // confirm the row landed (and log it if not).
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/leaderboard_statuses?on_conflict=user_id`,
        {
          method: 'POST',
          headers: {
            ...baseHeaders,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=representation',
          },
          body: JSON.stringify({ user_id: GF.userId, message: clean }),
        }
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        GF.log('pushMyStatus UPSERT failed', resp.status, body);
        return { ok: false, reason: 'upsert_failed', status: resp.status, body };
      }
      let saved = null;
      try { saved = await resp.json(); } catch (_) { /* return=minimal-safe */ }
      scheduleCommunityRefresh();
      return { ok: true, action: 'set', saved };
    } catch (err) {
      GF.log('pushMyStatus exception', err);
      return { ok: false, reason: 'exception', error: String(err && err.message || err) };
    }
  };

  // ── 6. COMMUNITY: підключити рейтинг до Supabase ─
  function attachCommunity() {
    if (typeof Community !== 'object') return;
    const origFetchMembers = Community.fetchMembers.bind(Community);
    const origFetchMember = Community.fetchMember.bind(Community);
    const origFetchLocations = Community.fetchLocations.bind(Community);
    const origFetchActivityFeed = Community.fetchActivityFeed.bind(Community);

    // ── Activity Feed: 24h тренування інших юзерів ─
    function timeAgo(ts) {
      const diff = Date.now() - new Date(ts).getTime();
      const m = Math.floor(diff / 60000);
      if (m < 1) return 'щойно';
      if (m < 60) return `${m} хв тому`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h} год тому`;
      return `${Math.floor(h / 24)} дн тому`;
    }
    const DAY_LABELS = { 'A':'День A', 'B':'День B', 'C':'День C', 'CUSTOM':'Своє', 'cardio':'Кардіо' };
    Community.fetchActivityFeed = async function() {
      if (!GF.ready) return origFetchActivityFeed();
      try {
        const since = new Date(Date.now() - 24*3600*1000).toISOString();
        const resp = await fetch(
          `${SUPABASE_URL}/rest/v1/community_feed?occurred_at=gte.${since}&order=occurred_at.desc&limit=10`,
          { headers: {
            'apikey': SUPABASE_PUBLIC_KEY,
            'Authorization': `Bearer ${GF.accessToken}`,
          }}
        );
        if (!resp.ok) return origFetchActivityFeed();
        const rows = await resp.json();
        return rows.map(r => {
          let workoutText = '';
          if (r.event_type === 'workout_completed') {
            const dayLabel = DAY_LABELS[r.day_key] || (r.day_key || 'Тренування');
            const sets = r.total_sets ? ` · ${r.total_sets} ${r.total_sets === 1 ? 'підхід' : (r.total_sets < 5 ? 'підходи' : 'підходів')}` : '';
            workoutText = `${dayLabel}${sets}`;
          } else if (r.event_type === 'achievement_unlocked') {
            workoutText = `🏆 ${r.event_subtype || 'досягнення'}`;
          }
          return { id: r.user_id, workout: workoutText, ago: timeAgo(r.occurred_at) };
        });
      } catch (err) {
        GF.log('feed err:', err);
        return origFetchActivityFeed();
      }
    };

    // ── Locations: get_city_counts() агрегує всіх юзерів по містах ─
    Community.fetchLocations = async function() {
      if (!GF.ready) return origFetchLocations();
      try {
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_city_counts`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_PUBLIC_KEY,
            'Authorization': `Bearer ${GF.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        if (!resp.ok) return origFetchLocations();
        const rows = await resp.json();
        const COUNTRY_FLAGS = {
          'Україна': '🇺🇦', 'Індонезія': '🇮🇩', 'США': '🇺🇸',
          'Польща': '🇵🇱', 'Німеччина': '🇩🇪', 'Іспанія': '🇪🇸',
          'Італія': '🇮🇹', 'Велика Британія': '🇬🇧', 'Канада': '🇨🇦',
        };
        return rows.map(r => ({
          flag: COUNTRY_FLAGS[r.country] || '🏙',
          name: r.city,
          count: r.count,
        }));
      } catch (err) {
        GF.log('locations err:', err);
        return origFetchLocations();
      }
    };

    // Отримати всю спільноту: me + всі з Supabase get_leaderboard()
    Community.fetchMembers = async function() {
      const me = Community._buildMe();
      if (!GF.ready) return [me];
      try {
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_leaderboard`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_PUBLIC_KEY,
            'Authorization': `Bearer ${GF.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ limit_count: 100, sort_by: 'grek_score' }),
        });
        if (!resp.ok) {
          GF.log('leaderboard fetch failed:', resp.status);
          return [me];
        }
        const rows = await resp.json();
        const others = rows
          .filter(r => r.user_id !== GF.userId)  // не дублюємо себе
          .map(r => ({
            id: r.user_id,
            name: r.display_name || 'друже',
            avatar: r.avatar_url
              ? `<img src="${escHtml(r.avatar_url)}" alt="" draggable="false">`
              : escHtml((r.display_name || '?').slice(0, 2).toUpperCase()),
            city: r.city || '',
            origin: '',
            instagram: '',
            gym: '',
            score: r.grek_score || 0,
            streak: r.streak || 0,
            // v31 (Feature #9): top-3 bragging-rights message from leaderboard_statuses.
            status: r.status_message || '',
            daysInClub: 0,
            isMe: false,
          }));
        // Я завжди перший у списку (для свого view), хоча сорт по score
        return [me, ...others];
      } catch (err) {
        GF.log('community err:', err);
        return [me];
      }
    };

    // Деталі іншого члена — через get_member_profile()
    Community.fetchMember = async function(id) {
      if (id === 'me') return Community._buildMe();
      if (!GF.ready) return origFetchMember(id);
      try {
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_member_profile`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_PUBLIC_KEY,
            'Authorization': `Bearer ${GF.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ target_user_id: id }),
        });
        if (!resp.ok) return null;
        const rows = await resp.json();
        const r = rows[0];
        if (!r) return null;
        const daysInClub = r.joined_at
          ? Math.max(1, Math.floor((Date.now() - new Date(r.joined_at).getTime()) / 86400000) + 1)
          : 1;
        return {
          id: r.user_id,
          name: r.display_name || 'друже',
          avatar: r.avatar_url
            ? `<img src="${escHtml(r.avatar_url)}" alt="" draggable="false">`
            : escHtml((r.display_name || '?').slice(0, 2).toUpperCase()),
          city: r.city || '',
          origin: r.origin || '',
          instagram: r.instagram || '',
          gym: r.gym || '',
          score: r.grek_score || 0,
          streak: r.streak || 0,
          // v31 Feature #9: status_message comes from get_member_profile
          // (LEFT JOIN against leaderboard_statuses).
          status: r.status_message || '',
          daysInClub,
          isMe: false,
        };
      } catch (err) {
        GF.log('member detail err:', err);
        return null;
      }
    };

    // Якщо leaderboard видимий — перерендерити з новими даними
    if (typeof window.renderLeaderboard === 'function'
        && document.getElementById('leaderboard-list')) {
      window.renderLeaderboard();
    }
  }

  // ── 7. RESTORE FROM CLOUD ───────────────────
  // Якщо у юзера cleared cache / новий пристрій / переустановлений Telegram —
  // витягуємо його дані з Supabase і відновлюємо у localStorage.
  // Strategy: fill-missing-only — НІКОЛИ не перезаписуємо існуючий localStorage ключ.
  async function restoreFromCloud() {
    if (!GF.ready || !GF.userId) return 0;
    if (window.__grekfit_restore_done) return 0;
    window.__grekfit_restore_done = true;

    const headers = {
      'apikey': SUPABASE_PUBLIC_KEY,
      'Authorization': `Bearer ${GF.accessToken}`,
    };
    let restored = 0;
    const setIfMissing = (key, value) => {
      if (value == null || value === '') return;
      if (localStorage.getItem(key) != null) return;  // local перемагає
      origSetItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      restored++;
    };
    // Для insert-only таблиць — позначити як вже синкнуте, щоб initial backfill не дублював
    const setIfMissingTracked = (key, value) => {
      const before = restored;
      setIfMissing(key, value);
      if (restored > before) markSynced(key, localStorage.getItem(key));
    };

    setBadge('restoring from cloud...', '#555');

    try {
      // 1. profiles + bonus flags + schedule
      const pResp = await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${GF.userId}&select=*`, { headers });
      if (pResp.ok) {
        const p = (await pResp.json())[0];
        if (p) {
          if (p.program_key) setIfMissing('gf_program_key', p.program_key);
          if (p.schedule_days) setIfMissing('gf_schedule_days', JSON.stringify(p.schedule_days));
          if (p.schedule_mode) setIfMissing('gf_schedule_mode', String(p.schedule_mode));
          if (p.schedule_set) setIfMissing('gf_schedule_set', '1');
          if (p.program_intro_seen) setIfMissing('gf_program_intro_seen', '1');
          if (p.streak_litup_shown) setIfMissing('gf_streak_litup_shown', '1');

          const prof = {};
          ['sex','goal','level','instagram','origin','country','city','gym'].forEach(f => {
            if (p[f]) prof[f] = p[f];
          });
          if (p.age != null) prof.age = p.age;
          if (p.activity_level) prof.activity = p.activity_level;
          // Privacy toggles (boolean false має значення — використовуємо явну перевірку)
          if (p.show_in_directory === false) prof.show_in_directory = false;
          if (p.show_instagram === false) prof.show_instagram = false;
          if (p.show_city === false) prof.show_city = false;
          if (Object.keys(prof).length) setIfMissing('gf_profile', JSON.stringify(prof));
        }
      }

      // 1b. custom program (персонально складена) — відновлюємо на новому пристрої
      try {
        const cpResp = await fetch(`${SUPABASE_URL}/rest/v1/custom_programs?user_id=eq.${GF.userId}&select=mode,days,schedule_days`, { headers });
        if (cpResp.ok) {
          const cp = (await cpResp.json())[0];
          if (cp && cp.days && Object.keys(cp.days).length) {
            setIfMissing('gf_custom_program_v1', JSON.stringify({ mode: cp.mode || 'week', days: cp.days }));
            setIfMissing('gf_custom_program_set', '1');
            if (cp.schedule_days && !localStorage.getItem('gf_schedule_days')) {
              setIfMissing('gf_schedule_days', JSON.stringify(cp.schedule_days));
            }
          }
        }
      } catch (err) { GF.log('custom_programs pull err', err); }

      // 2. measurements — повна історія точок A/B/C…
      const mResp = await fetch(`${SUPABASE_URL}/rest/v1/measurements?user_id=eq.${GF.userId}&order=recorded_at.asc&select=*`, { headers });
      if (mResp.ok) {
        const rows = await mResp.json();
        if (Array.isArray(rows) && rows.length) {
          const history = rows.map(m => ({
            date: m.recorded_at
              ? new Date(m.recorded_at).toISOString().slice(0,10)
              : new Date().toISOString().slice(0,10),
            weight: m.weight  != null ? Number(m.weight)  : null,
            height: m.height  != null ? Number(m.height)  : null,
            waist:  m.waist   != null ? Number(m.waist)   : null,
            chest:  m.chest   != null ? Number(m.chest)   : null,
            bicep:  m.biceps  != null ? Number(m.biceps)  : null,  // biceps (БД) → bicep (local)
            bodyfat: m.bodyfat != null ? Number(m.bodyfat) : null,
          }));
          setIfMissingTracked('gf_measurements_history', JSON.stringify(history));
          // Latest cache для backwards-compat + UI sub-line
          const last = history[history.length - 1];
          const meas = {
            weight: last.weight, height: last.height, waist: last.waist,
            chest: last.chest, bicep: last.bicep, bodyfat: last.bodyfat,
            updated_at: new Date(last.date + 'T12:00:00Z').getTime(),
          };
          setIfMissingTracked('gf_measurements', JSON.stringify(meas));
        }
      }

      // 3. consent (latest)
      const cResp = await fetch(`${SUPABASE_URL}/rest/v1/consent_log?user_id=eq.${GF.userId}&order=accepted_at.desc&limit=1`, { headers });
      if (cResp.ok) {
        const cl = (await cResp.json())[0];
        if (cl) {
          const consentObj = {
            version: cl.consent_version,
            documents: cl.documents_accepted || [],
            accepted_at: new Date(cl.accepted_at).toISOString(),
          };
          setIfMissingTracked('gf_consent', JSON.stringify(consentObj));
          setIfMissing('gf_consent_accepted_at', consentObj.accepted_at);
        }
      }

      // 4. score_events → bonus flags
      const sResp = await fetch(`${SUPABASE_URL}/rest/v1/score_events?user_id=eq.${GF.userId}&select=event_type,delta,occurred_at`, { headers });
      if (sResp.ok) {
        const events = await sResp.json();
        for (const ev of events) {
          if (ev.event_type === 'starter') {
            setIfMissing('gf_starter_granted', '1');
            setIfMissing('gf_starter_bonus', String(ev.delta));
            setIfMissing('gf_starter_at', new Date(ev.occurred_at).toISOString());
          } else if (ev.event_type === 'profile_bonus') {
            setIfMissing('gf_profile_bonus', String(ev.delta));
          } else if (ev.event_type === 'goal_bonus') {
            setIfMissing('gf_goal_bonus', String(ev.delta));
          }
        }
      }

      // 5. user_name
      const uResp = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${GF.userId}&select=name`, { headers });
      if (uResp.ok) {
        const u = (await uResp.json())[0];
        if (u?.name) setIfMissing('gf_user_name', u.name);
      }

      // 6. workouts → gf_completed (recompose 3-table join)
      if (localStorage.getItem('gf_completed') == null) {
        const wResp = await fetch(
          `${SUPABASE_URL}/rest/v1/workouts?user_id=eq.${GF.userId}&select=id,workout_date,workout_type,day_key,started_at,ended_at,duration_sec,total_sets,total_volume_kg,eligible,shared,rpe_label,custom_name&order=workout_date`,
          { headers }
        );
        if (wResp.ok) {
          const workouts = await wResp.json();
          if (workouts.length) {
            const wIds = workouts.map(w => w.id).join(',');
            const exResp = await fetch(
              `${SUPABASE_URL}/rest/v1/workout_exercises?workout_id=in.(${wIds})&select=id,workout_id,exercise_name,order_index,is_skipped,is_superset,superset_key,is_paired_dumbbell&order=order_index`,
              { headers }
            );
            const exRows = exResp.ok ? await exResp.json() : [];
            let setRows = [];
            if (exRows.length) {
              const exIds = exRows.map(e => e.id).join(',');
              const setsResp = await fetch(
                `${SUPABASE_URL}/rest/v1/workout_sets?workout_exercise_id=in.(${exIds})&select=workout_exercise_id,set_number,weight_kg,reps,duration_sec,is_warmup&order=set_number`,
                { headers }
              );
              setRows = setsResp.ok ? await setsResp.json() : [];
            }
            const setsByEx = {};
            setRows.forEach(s => {
              if (s.is_warmup) return;
              (setsByEx[s.workout_exercise_id] ||= []).push({
                weight: s.weight_kg != null ? Number(s.weight_kg) : null,
                reps: s.reps != null ? s.reps : null,
                ...(s.duration_sec != null ? { duration_sec: s.duration_sec } : {}),
              });
            });
            const completed = {};
            workouts.forEach(w => {
              const wExs = exRows.filter(e => e.workout_id === w.id).sort((a, b) => a.order_index - b.order_index);
              const exercises = wExs.map(e => {
                const ex = {
                  name: e.exercise_name,
                  skipped: !!e.is_skipped,
                  sets: setsByEx[e.id] || [],
                };
                if (e.is_superset && e.superset_key) ex.ss = e.superset_key;
                if (e.is_paired_dumbbell) ex.dbl = 2;
                return ex;
              }).filter(ex => ex.sets.length || ex.skipped);

              const dateStr = String(w.workout_date).slice(0, 10);
              completed[dateStr] = {
                type: w.workout_type || 'strength',
                day: w.day_key || null,
                sets: w.total_sets || 0,
                volume: w.total_volume_kg ? Number(w.total_volume_kg) : 0,
                startedAt: w.started_at ? new Date(w.started_at).getTime() : null,
                endedAt: w.ended_at ? new Date(w.ended_at).getTime() : null,
                durationSec: w.duration_sec || 0,
                eligible: w.eligible !== false,
                exercises,
              };
              if (w.rpe_label) completed[dateStr].rpe = w.rpe_label;
              if (w.shared) completed[dateStr].shared = true;
              if (w.custom_name) completed[dateStr].name = w.custom_name;
            });
            const completedStr = JSON.stringify(completed);
            origSetItem('gf_completed', completedStr);
            markSynced('gf_completed', completedStr);  // не пушити назад
            restored++;
          }
        }
      }

      // 7. active_workout (jsonb state_data)
      if (localStorage.getItem('gf_active_workout') == null) {
        const aResp = await fetch(`${SUPABASE_URL}/rest/v1/active_workouts?user_id=eq.${GF.userId}&select=state_data`, { headers });
        if (aResp.ok) {
          const a = (await aResp.json())[0];
          if (a?.state_data) {
            const stateStr = JSON.stringify(a.state_data);
            origSetItem('gf_active_workout', stateStr);
            restored++;
          }
        }
      }

      // 8. weight_log (array)
      if (localStorage.getItem('gf_weight_log') == null) {
        const wlResp = await fetch(`${SUPABASE_URL}/rest/v1/weight_log?user_id=eq.${GF.userId}&select=weight_kg,recorded_date&order=recorded_date`, { headers });
        if (wlResp.ok) {
          const rows = await wlResp.json();
          if (rows.length) {
            const log = rows.map(r => ({ date: r.recorded_date, weight: Number(r.weight_kg) }));
            origSetItem('gf_weight_log', JSON.stringify(log));
            restored++;
          }
        }
      }

      // 9. nutrition_profile
      if (localStorage.getItem('gf_nutrition_profile') == null) {
        const npResp = await fetch(`${SUPABASE_URL}/rest/v1/nutrition_profiles?user_id=eq.${GF.userId}&select=*`, { headers });
        if (npResp.ok) {
          const np = (await npResp.json())[0];
          if (np) {
            const obj = {
              target: np.target_kcal,
              tdee: np.tdee_kcal,
              macros: { protein: np.protein_g, carbs: np.carbs_g, fat: np.fat_g },
              meals: np.meals_count || 3,
              snacks: np.snacks_count || 1,
              mealTimes: np.meal_times || [],
              snackTimes: np.snack_times || [],
              goal: np.goal,
              pace: np.pace_kg_week,
              goalWeight: np.goal_weight_kg,
              startWeight: np.start_weight_kg,
            };
            origSetItem('gf_nutrition_profile', JSON.stringify(obj));
            restored++;
          }
        }
      }

      if (restored > 0) {
        setBadge('✓ restored ' + restored + ' keys', '#0a0');
      }
      GF.log('restoreFromCloud:', restored, 'keys restored');
    } catch (err) {
      GF.log('restoreFromCloud err', err);
      setBadge('restore err', '#a00');
    }
    return restored;
  }
  GF.restoreFromCloud = restoreFromCloud;

  // ── 8. DATA EXPORT (GDPR Art. 15) ───────────
  // Тягне ВСЕ що пов'язане з юзером — і з Supabase, і з localStorage —
  // і тригерить download як .json файл. Юзер має право на копію своїх даних.
  GF.exportMyData = async function() {
    if (!GF.ready || !GF.userId) {
      throw new Error('Not authenticated');
    }
    const headers = {
      'apikey': SUPABASE_PUBLIC_KEY,
      'Authorization': `Bearer ${GF.accessToken}`,
    };
    const fetchTable = async (table, params = '') => {
      try {
        const url = `${SUPABASE_URL}/rest/v1/${table}?user_id=eq.${GF.userId}${params ? '&' + params : ''}`;
        const r = await fetch(url, { headers });
        if (!r.ok) return { _error: r.status + ' ' + await r.text() };
        return await r.json();
      } catch (e) { return { _error: String(e) }; }
    };
    const fetchUsersRow = async () => {
      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${GF.userId}`, { headers });
        if (!r.ok) return null;
        return (await r.json())[0] || null;
      } catch { return null; }
    };

    // localStorage snapshot (only gf_* keys)
    const local = {};
    Object.keys(localStorage).filter(k => k.startsWith('gf_')).forEach(k => {
      try { local[k] = JSON.parse(localStorage.getItem(k)); }
      catch { local[k] = localStorage.getItem(k); }
    });

    // Pull all server-side data in parallel
    const [
      user, profile, measurements, weightLog, nutritionProfile, userGoals,
      foodLog, foodCustom, foodRecent, workouts, weekPlan, extraPlanned,
      extraSessions, lastSetCache, personalRecords, scoreEvents, streakState,
      achievements, activeWorkout, consentLog, subscriptions, referrals
    ] = await Promise.all([
      fetchUsersRow(),
      fetchTable('profiles'),
      fetchTable('measurements', 'order=recorded_at'),
      fetchTable('weight_log', 'order=recorded_date'),
      fetchTable('nutrition_profiles'),
      fetchTable('user_goals', 'order=set_at'),
      fetchTable('food_log', 'order=logged_at'),
      fetchTable('food_items_custom'),
      fetchTable('food_recent'),
      fetchTable('workouts', 'order=workout_date'),
      fetchTable('week_plan', 'order=date'),
      fetchTable('extra_planned'),
      fetchTable('extra_sessions', 'order=date'),
      fetchTable('last_set_cache'),
      fetchTable('personal_records'),
      fetchTable('score_events', 'order=occurred_at'),
      fetchTable('streak_state'),
      fetchTable('achievements'),
      fetchTable('active_workouts'),
      fetchTable('consent_log', 'order=accepted_at'),
      fetchTable('subscriptions'),
      fetchTable('referrals', 'order=created_at'),
    ]);

    // Для workouts ще тягнемо exercises + sets — інакше експорт неповний
    let workoutExercises = [], workoutSets = [];
    if (Array.isArray(workouts) && workouts.length > 0) {
      const wIds = workouts.map(w => w.id).join(',');
      try {
        const eR = await fetch(`${SUPABASE_URL}/rest/v1/workout_exercises?workout_id=in.(${wIds})&order=order_index`, { headers });
        if (eR.ok) workoutExercises = await eR.json();
        if (workoutExercises.length > 0) {
          const eIds = workoutExercises.map(e => e.id).join(',');
          const sR = await fetch(`${SUPABASE_URL}/rest/v1/workout_sets?workout_exercise_id=in.(${eIds})&order=set_number`, { headers });
          if (sR.ok) workoutSets = await sR.json();
        }
      } catch (e) { GF.log('export workouts err', e); }
    }

    const data = {
      _meta: {
        exported_at: new Date().toISOString(),
        format_version: '1.0',
        user_id: GF.userId,
        tg_user_id: GF.tgUserId,
        legal_basis: 'GDPR Art. 15 — Right of access',
        note: 'Це повна копія Ваших персональних даних які зберігаються у GrekFit',
      },
      account: {
        user, profile,
        consent_log: consentLog, subscriptions, referrals,
      },
      body: {
        measurements, weight_log: weightLog,
      },
      goals: {
        nutrition_profile: nutritionProfile, user_goals: userGoals,
      },
      training: {
        workouts, workout_exercises: workoutExercises, workout_sets: workoutSets,
        week_plan: weekPlan, extra_planned: extraPlanned, extra_sessions: extraSessions,
        last_set_cache: lastSetCache, personal_records: personalRecords,
        active_workout: activeWorkout,
      },
      nutrition: {
        food_log: foodLog, food_custom: foodCustom, food_recent: foodRecent,
      },
      progress: {
        score_events: scoreEvents, streak_state: streakState, achievements,
      },
      device_state: {
        note: 'Дані з localStorage Вашого пристрою (Telegram Mini App)',
        keys: local,
      },
    };

    // Download as JSON file
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const filename = `grekfit-my-data-${stamp}.json`;
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { document.body.removeChild(a); } catch {}
      URL.revokeObjectURL(url);
    }, 100);

    return { filename, size_bytes: blob.size, sections: Object.keys(data).length };
  };

  // ── 9. INIT ─────────────────────────────────
  async function init() {
    const ok = await authenticate();
    if (!ok) return;
    // Підключити community → Supabase
    attachCommunity();
    // Backfill з Supabase у localStorage (тільки missing keys) — на випадок cleared cache
    await restoreFromCloud();
    // Після авторизації — синхронізуємо ВСЕ що зараз у localStorage (initial backfill)
    const keys = Object.keys(localStorage).filter(k => k.startsWith('gf_'));
    GF.log('initial backfill', keys.length, 'keys');
    keys.forEach(k => enqueue(k, localStorage.getItem(k)));
    // v32: reconcile server-deleted workouts BEFORE pushing cached score,
    // so the pushed value reflects the cleaned local cache.
    try { await reconcileDeletedWorkouts(); } catch(_){}
    // Початковий push cached score (на випадок якщо нічого не змінювалось)
    setTimeout(pushCachedScore, 2000);
    // v32: retry any sync items that failed on a previous run (e.g. apk
    // closed mid-finishWorkout, network drop). Best-effort.
    setTimeout(() => { retryPendingSync().catch(() => {}); }, 2500);
  }

  // Запуск після того як Telegram WebApp готовий
  if (window.Telegram && window.Telegram.WebApp) {
    window.Telegram.WebApp.ready();
  }
  // Затримка 200мс щоб усі initial localStorage записи з онбордингу встигли осісти
  setTimeout(init, 200);
})();

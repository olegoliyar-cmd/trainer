/* ───────────────────────────────────────────────────────────────────────────
   DataStore — Supabase-реалізація СПІЛЬНОГО шару даних (свап для data-store.js).
   Той самий набір методів, що й mock-версія → фронти НЕ міняються.

   Підключення (до цього скрипта):
     window.SUPABASE_URL      = 'https://<project>.supabase.co';
     window.SUPABASE_ANON_KEY = '<anon-public-key>';
     window.EXERCISES_BASE_URL = '/exercises.json';   // база 240 вправ (статичний ассет)
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>

   ⚠️ НЕ ПРОТЕСТОВАНО проти живого проєкту (немає креденшелів у dev). Перед
   продом: прогнати обидва фронти проти реального Supabase + перевірити RLS
   (2 тренери не бачать даних одне одного). Семантику дзеркалено з backend/store.mjs.
   ─────────────────────────────────────────────────────────────────────────── */
(function () {
  var URL = window.SUPABASE_URL, KEY = window.SUPABASE_ANON_KEY;
  if (!window.supabase || !URL || !KEY) {
    console.error('[DataStore] Supabase не сконфігуровано (URL/ANON_KEY/supabase-js).');
  }
  var sb = window.supabase.createClient(URL, KEY);

  // ── helpers ────────────────────────────────────────────────────────────────
  function ok(res) { if (res.error) throw new Error(res.error.message || 'Supabase error'); return res.data; }
  function first(res) { return ok(res)[0] || null; }
  function nowIso() { return new Date().toISOString(); }
  function today() { return nowIso().slice(0, 10); }

  var _trainerIdCache = {};                 // clientId → trainer_id (для дочірніх insert)
  async function trainerIdOf(clientId) {
    if (_trainerIdCache[clientId]) return _trainerIdCache[clientId];
    var c = first(await sb.from('clients').select('trainer_id').eq('id', clientId));
    var tid = c && c.trainer_id; if (tid) _trainerIdCache[clientId] = tid; return tid;
  }

  // База 240 вправ (статичний ассет) — кешуємо.
  var _exBase = null;
  async function exerciseBase() {
    if (_exBase) return _exBase;
    try { var r = await fetch(window.EXERCISES_BASE_URL || '/exercises.json'); _exBase = await r.json(); }
    catch (e) { _exBase = []; }
    return _exBase;
  }

  window.DataStore = {
    base: 'supabase',
    sb: sb,

    // ── AUTH (тренер) ─────────────────────────────────────────────────────────
    // RLS вимагає авторизованої сесії: current_trainer_id() = trainers.id, де owner=auth.uid().
    auth: {
      signIn: async function (email, password) { var r = await sb.auth.signInWithPassword({ email: email, password: password }); if (r.error) throw new Error(r.error.message); return r.data; },
      signOut: async function () { await sb.auth.signOut(); },
      getSession: async function () { var r = await sb.auth.getSession(); return r.data ? r.data.session : null; },
      onChange: function (cb) { return sb.auth.onAuthStateChange(function (_e, s) { cb(s); }); },
    },
    // Рядок тренера поточного залогіненого користувача (RLS сам віддасть лише свій).
    currentTrainer: async function () { return first(await sb.from('trainers').select('*')); },

    // ── TRAINERS ──────────────────────────────────────────────────────────────
    listTrainers: async function () { return ok(await sb.from('trainers').select('*')); },
    getTrainer: async function (id) { return first(await sb.from('trainers').select('*').eq('id', id)); },
    // Клієнтський апп читає бренд тренера за slug через публічну вью.
    getTrainerBySlug: async function (slug) { return first(await sb.from('trainer_public').select('*').eq('slug', slug)); },
    createTrainer: async function (data) { return first(await sb.from('trainers').insert(data).select()); },
    updateTrainer: async function (id, patch) { return first(await sb.from('trainers').update(patch).eq('id', id).select()); },

    // ── BUNNY (відео вправ) ───────────────────────────────────────────────────
    // Просимо Edge Function створити video-обʼєкт + presigned TUS-підпис. Ключ
    // Bunny лишається на сервері; сюди повертаються лише дані для прямого аплоуду.
    // sb.functions.invoke сам додає Authorization = access_token тренера.
    bunnyCreate: async function (title) {
      var r = await sb.functions.invoke('bunny-upload', { body: { action: 'create', title: title || 'Вправа' } });
      if (r.error) throw new Error((r.error && r.error.message) || 'bunny error');
      return r.data;
    },

    // Фідбек тренера клієнту → зберігає + дублює в Telegram (Edge Function).
    sendFeedback: async function (clientId, data) {
      var r = await sb.functions.invoke('trainer-feedback', { body: Object.assign({ client_id: clientId }, data || {}) });
      if (r.error) throw new Error((r.error && r.error.message) || 'feedback error');
      return r.data;
    },

    // ── ВІДЕО ТРЕНЕРУ (розбори техніки) ───────────────────────────────────────
    // Список запитів клієнта (RLS: лише свої). Тренер читає таблицю напряму.
    listFormChecks: async function (clientId) {
      return ok(await sb.from('form_check_requests').select('*').eq('client_id', clientId).order('created_at', { ascending: false }));
    },
    // Signed URL на відео (приватний бакет; RLS дозволяє читати свій префікс trainer_id).
    formCheckVideoUrl: async function (path) {
      if (!path) return null;
      var r = await sb.storage.from('form-checks').createSignedUrl(path, 3600);
      if (r.error) throw new Error(r.error.message);
      return r.data && r.data.signedUrl;
    },
    // Аплоуд медіа відповіді (розмічений скрін / голосове) у свій префікс бакета.
    // kind: 'reply-img' | 'reply-voice'. Повертає path. RLS insert дозволяє свій trainer_id.
    uploadFormCheckMedia: async function (trainerId, clientId, ext, blob, contentType) {
      var path = trainerId + '/' + clientId + '/' + crypto.randomUUID().replace(/-/g, '') + '.' + (ext || 'bin');
      var r = await sb.storage.from('form-checks').upload(path, blob, { contentType: contentType || blob.type || 'application/octet-stream', upsert: false });
      if (r.error) throw new Error(r.error.message);
      return path;
    },
    // Надіслати відповідь на розбір: текст + (опц.) скрін + (опц.) голосове → Edge Function
    // (запис у form_check_requests + Telegram). Відео клієнта НЕ видаляється.
    submitFormCheckReview: async function (requestId, payload) {
      var r = await sb.functions.invoke('formcheck-review', { body: Object.assign({ request_id: requestId }, payload || {}) });
      if (r.error) throw new Error((r.error && r.error.message) || 'review error');
      return r.data;
    },

    // ── ЗУСТРІЧІ (Блок 3) ─────────────────────────────────────────────────────
    // Створення = Edge Function (insert + Telegram із кнопками підтвердження).
    createMeeting: async function (clientId, data) {
      var r = await sb.functions.invoke('meeting-create', { body: Object.assign({ client_id: clientId }, data || {}) });
      if (r.error) throw new Error((r.error && r.error.message) || 'meeting error');
      return r.data;
    },
    updateMeeting: async function (id, patch) { return first(await sb.from('meetings').update(patch).eq('id', id).select()); },
    deleteMeeting: async function (id) { ok(await sb.from('meetings').delete().eq('id', id)); return { ok: true }; },

    // ── ВНУТРІШНІЙ ЧАТ (тренер ↔ клієнт: текст + голосові) ────────────────────
    // Голосове тренера: вантажимо у свій префікс бакета chat (storage RLS insert own).
    uploadChatVoice: async function (trainerId, clientId, ext, blob, contentType) {
      var path = trainerId + '/' + clientId + '/' + crypto.randomUUID().replace(/-/g, '') + '.' + (ext || 'webm');
      var r = await sb.storage.from('chat').upload(path, blob, { contentType: contentType || blob.type || 'audio/webm', upsert: false });
      if (r.error) throw new Error(r.error.message);
      return path;
    },
    chatVoiceUrl: async function (path) {
      if (!path) return null;
      var r = await sb.storage.from('chat').createSignedUrl(path, 3600);
      if (r.error) throw new Error(r.error.message);
      return r.data && r.data.signedUrl;
    },
    // Надсилання = та сама Edge Function (запис у messages + Telegram клієнту).
    sendChat: async function (clientId, payload) {
      var r = await sb.functions.invoke('trainer-feedback', { body: Object.assign({ client_id: clientId }, payload || {}) });
      if (r.error) throw new Error((r.error && r.error.message) || 'chat error');
      return r.data;
    },
    markChatSeen: async function (clientId) {
      ok(await sb.from('messages').update({ seen_by_trainer: true })
        .eq('client_id', clientId).eq('sender', 'client').eq('seen_by_trainer', false));
      return { ok: true };
    },

    // ── ЧЕК-ІНИ (голосові звіти стану) ────────────────────────────────────────
    checkinAudioUrl: async function (path) {
      if (!path) return null;
      var r = await sb.storage.from('checkins').createSignedUrl(path, 3600);
      if (r.error) throw new Error(r.error.message);
      return r.data && r.data.signedUrl;
    },
    markCheckinsSeen: async function (clientId) {
      ok(await sb.from('checkins').update({ status: 'seen' }).eq('client_id', clientId).eq('status', 'new'));
      return { ok: true };
    },

    // ── БОТ-ТОКЕН (мульти-бот) ────────────────────────────────────────────────
    // Токен клієнтського бота — секрет. Пишемо через SECURITY DEFINER RPC (у свій
    // рядок trainer_secrets); прочитати назад НЕ можна. botConnected → лише булеве.
    setBotToken: async function (token) { var r = await sb.rpc('set_trainer_bot_token', { p_token: token || '' }); if (r.error) throw new Error(r.error.message); return { ok: true }; },
    botConnected: async function () { var r = await sb.rpc('has_trainer_bot_token'); if (r.error) return false; return !!r.data; },

    trainerBundle: async function (id) {
      var trainer = await this.getTrainer(id);
      if (!trainer) return null;
      var q = function (t) { return sb.from(t).select('*').eq('trainer_id', id); };
      var r = await Promise.all([
        q('clients'), q('programs'), q('assignments'), q('payments'),
        q('coupons'), q('tasks'), q('client_photos'), q('client_measurements'), q('workout_logs'),
        q('client_health'), q('client_feedback'), q('form_check_requests'), q('checkins'),
        q('messages'), q('daily_reports'), q('meetings'),
      ]);
      var clients = ok(r[0]), programs = ok(r[1]), assignments = ok(r[2]), payments = ok(r[3]),
          coupons = ok(r[4]), tasks = ok(r[5]), photos = ok(r[6]), meas = ok(r[7]), logs = ok(r[8]),
          health = ok(r[9]), feedback = ok(r[10]), formChecks = ok(r[11]), checkins = ok(r[12]),
          chat = ok(r[13]), reports = ok(r[14]), meetings = ok(r[15]);
      var progById = {}; programs.forEach(function (p) { progById[p.id] = p; });
      var latestAssign = {};
      assignments.forEach(function (a) {
        var cur = latestAssign[a.client_id];
        if (!cur || (a.assigned_at || '') > (cur.assigned_at || '')) latestAssign[a.client_id] = a;
      });
      var byClient = function (arr) { var m = {}; arr.forEach(function (x) { (m[x.client_id] = m[x.client_id] || []).push(x); }); return m; };
      var descDate = function (a, b) { return (b.date || '').localeCompare(a.date || ''); };
      var phByC = byClient(photos), msByC = byClient(meas), lgByC = byClient(logs), pyByC = byClient(payments), hlByC = byClient(health), fbByC = byClient(feedback), fcByC = byClient(formChecks), ciByC = byClient(checkins), chByC = byClient(chat), rpByC = byClient(reports), mtByC = byClient(meetings);
      var byCreated = function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); };
      var clientsOut = clients.map(function (c) {
        var a = latestAssign[c.id], prog = a ? progById[a.program_id] : null;
        var fcs = (fcByC[c.id] || []).slice().sort(byCreated);
        return Object.assign({}, c, {
          assignedProgram: prog ? { id: prog.id, name: prog.name } : null,
          logsCount: (lgByC[c.id] || []).length,
          paymentsCount: (pyByC[c.id] || []).length,
          photos: (phByC[c.id] || []).slice().sort(descDate),
          measurements: (msByC[c.id] || []).slice().sort(descDate),
          health: (hlByC[c.id] || []).slice().sort(descDate),
          feedback: (fbByC[c.id] || []).slice().sort(byCreated),
          formChecks: fcs,
          formCheckNew: fcs.filter(function (x) { return x.status === 'new'; }).length,
          checkins: (ciByC[c.id] || []).slice().sort(byCreated),
          checkinsNew: (ciByC[c.id] || []).filter(function (x) { return x.status === 'new'; }).length,
          // Внутрішній чат: стрічка за зростанням часу + скільки нових ВІД КЛІЄНТА
          chat: (chByC[c.id] || []).slice().sort(function (a, b) { return (a.created_at || '').localeCompare(b.created_at || ''); }),
          chatNew: (chByC[c.id] || []).filter(function (x) { return x.sender === 'client' && !x.seen_by_trainer; }).length,
          // Щоденні звіти (новіші зверху)
          reports: (rpByC[c.id] || []).slice().sort(descDate),
          // Зустрічі клієнта (за часом початку)
          meetings: (mtByC[c.id] || []).slice().sort(function (a, b) { return (a.starts_at || '').localeCompare(b.starts_at || ''); }),
        });
      });
      return { trainer: trainer, clients: clientsOut, programs: programs, payments: payments, coupons: coupons, tasks: tasks, workout_logs: logs, meetings: meetings };
    },

    // ── CLIENTS ───────────────────────────────────────────────────────────────
    listClients: async function (trainerId) { return ok(await sb.from('clients').select('*').eq('trainer_id', trainerId)); },
    createClient: async function (trainerId, data) {
      var row = Object.assign({ trainer_id: trainerId }, data);
      return first(await sb.from('clients').insert(row).select());
    },
    getClient: async function (id) {
      var c = first(await sb.from('clients').select('*').eq('id', id));
      if (!c) return null;
      var r = await Promise.all([
        sb.from('client_photos').select('*').eq('client_id', id),
        sb.from('client_measurements').select('*').eq('client_id', id),
      ]);
      var d = function (a, b) { return (b.date || '').localeCompare(a.date || ''); };
      c.photos = ok(r[0]).sort(d); c.measurements = ok(r[1]).sort(d);
      return c;
    },
    updateClient: async function (id, patch) { return first(await sb.from('clients').update(patch).eq('id', id).select()); },
    deleteClient: async function (id) { ok(await sb.from('clients').delete().eq('id', id)); return { ok: true, id: id }; }, // FK cascade прибирає дітей
    clientBundle: async function (id) {
      var client = await this.getClient(id); if (!client) return null;
      var trainer = await this.getTrainer(client.trainer_id);
      var a = ok(await sb.from('assignments').select('*').eq('client_id', id).order('assigned_at', { ascending: false }).limit(1))[0];
      var program = a ? first(await sb.from('programs').select('*').eq('id', a.program_id)) : null;
      return { client: client, trainer: trainer, assignedProgram: program };
    },
    setClientProfile: async function (id, profile) {
      var c = first(await sb.from('clients').select('profile').eq('id', id));
      var merged = Object.assign({}, (c && c.profile) || {}, profile || {});
      return first(await sb.from('clients').update({ profile: merged }).eq('id', id).select());
    },

    // ── PHOTOS / MEASUREMENTS (окремі таблиці) ─────────────────────────────────
    addClientPhoto: async function (id, data) {
      var tid = await trainerIdOf(id);
      var row = { trainer_id: tid, client_id: id, date: data.date || today(), pose: data.pose || 'front', note: data.note || '', thumb: data.thumb || '' };
      return first(await sb.from('client_photos').insert(row).select());
    },
    deleteClientPhoto: async function (id, photoId) { ok(await sb.from('client_photos').delete().eq('id', photoId)); return { ok: true }; },
    addClientMeasurement: async function (id, data) {
      var tid = await trainerIdOf(id);
      var row = { trainer_id: tid, client_id: id, date: data.date || today() };
      ['weight', 'waist', 'chest', 'hip', 'arm', 'thigh', 'bodyfat', 'height'].forEach(function (k) {
        if (data[k] != null && data[k] !== '') row[k] = Number(data[k]);
      });
      return first(await sb.from('client_measurements').insert(row).select());
    },
    deleteClientMeasurement: async function (id, msId) { ok(await sb.from('client_measurements').delete().eq('id', msId)); return { ok: true }; },

    // ── PROGRAMS ───────────────────────────────────────────────────────────────
    listPrograms: async function (trainerId) { return ok(await sb.from('programs').select('*').eq('trainer_id', trainerId)); },
    listTemplates: async function (trainerId) { return ok(await sb.from('programs').select('*').eq('trainer_id', trainerId).eq('is_template', true)); },
    createProgram: async function (trainerId, data) {
      var row = { trainer_id: trainerId, is_template: !!data.is_template, name: data.name || 'Програма',
        description: data.description || '', builtin_key: data.builtin_key || null, structure: data.structure || { weeks: 1, days: [] } };
      return first(await sb.from('programs').insert(row).select());
    },
    updateProgram: async function (programId, patch) {
      var p = {}; ['name', 'description', 'structure', 'is_template', 'builtin_key'].forEach(function (k) { if (patch[k] != null) p[k] = patch[k]; });
      return first(await sb.from('programs').update(p).eq('id', programId).select());
    },
    cloneProgram: async function (programId, opts) {
      var src = first(await sb.from('programs').select('*').eq('id', programId)); if (!src) return null;
      var row = { trainer_id: (opts && opts.trainer_id) || src.trainer_id, is_template: !!(opts && opts.is_template),
        name: (opts && opts.name) || src.name, description: src.description || '', builtin_key: src.builtin_key || null,
        structure: src.structure || { weeks: 1, days: [] } };
      return first(await sb.from('programs').insert(row).select());
    },
    // Скласти персональну програму клієнту й одразу призначити.
    createClientProgram: async function (clientId, data) {
      var tid = await trainerIdOf(clientId);
      var p = await this.createProgram(tid, Object.assign({}, data, { is_template: false }));
      await this.assignProgram(clientId, p.id);
      return p;
    },

    // ── EXERCISES: база (json) ⊕ custom ⊕ overrides ───────────────────────────
    listExercises: async function (trainerId) {
      var base = await exerciseBase();
      var r = await Promise.all([
        sb.from('custom_exercises').select('*').eq('trainer_id', trainerId),
        sb.from('ex_overrides').select('*').eq('trainer_id', trainerId),
      ]);
      var custom = ok(r[0]), ovs = ok(r[1]);
      var ovMap = {}; ovs.forEach(function (o) { ovMap[o.exercise_id] = o; });
      var lib = base.map(function (e) {
        var o = ovMap[e.id]; if (!o) return e;
        return Object.assign({}, e, {
          name: o.name != null ? o.name : e.name, mg: o.mg != null ? o.mg : e.mg,
          mg_label: o.mg_label != null ? o.mg_label : e.mg_label, type: o.type != null ? o.type : e.type,
          embed_url: o.embed_url != null ? o.embed_url : e.embed_url, edited: true,
        });
      });
      return custom.map(function (e) { return Object.assign({ custom: true }, e); }).concat(lib);
    },
    createExercise: async function (trainerId, data) {
      var row = { trainer_id: trainerId, name: data.name || 'Вправа', mg: data.mg || null, mg_label: data.mg_label || 'Інше',
        type: data.type || 'weight_reps', bunny_id: data.bunny_id || null, embed_url: data.embed_url || '' };
      var e = first(await sb.from('custom_exercises').insert(row).select());
      if (e) e.custom = true; return e;
    },
    updateExercise: async function (exerciseId, patch) {
      // 1) власна вправа
      var own = first(await sb.from('custom_exercises').select('id').eq('id', exerciseId));
      if (own) {
        var p = {}; ['name', 'mg', 'mg_label', 'type', 'embed_url', 'bunny_id'].forEach(function (k) { if (patch[k] != null) p[k] = patch[k]; });
        return first(await sb.from('custom_exercises').update(p).eq('id', exerciseId).select());
      }
      // 2) базова → персональний оверрайд (upsert по (trainer_id, exercise_id))
      var tid = patch.trainer_id; if (!tid) return { ok: false, error: 'no trainer_id' };
      var row = { trainer_id: tid, exercise_id: exerciseId };
      ['name', 'mg', 'mg_label', 'type', 'embed_url', 'bunny_id'].forEach(function (k) { if (patch[k] != null) row[k] = patch[k]; });
      var o = first(await sb.from('ex_overrides').upsert(row, { onConflict: 'trainer_id,exercise_id' }).select());
      return { ok: true, override: o };
    },
    deleteExercise: async function (exerciseId) { ok(await sb.from('custom_exercises').delete().eq('id', exerciseId)); return { ok: true }; },

    // ── ASSIGNMENTS ────────────────────────────────────────────────────────────
    assignProgram: async function (clientId, programId) {
      var tid = await trainerIdOf(clientId);
      // Призначення ЗАМІНЮЄ попереднє (не накопичуємо рядки) — інакше bundle бере
      // «найновіше» серед стосу, а історія засмічується дублями.
      await sb.from('assignments').delete().eq('client_id', clientId);
      var a = first(await sb.from('assignments').insert({ trainer_id: tid, client_id: clientId, program_id: programId }).select());
      await sb.from('clients').update({ status: 'active' }).eq('id', clientId).eq('status', 'invited');
      return a;
    },

    // ── INVITES ────────────────────────────────────────────────────────────────
    createInvite: async function (trainerId, opts) { var row = { trainer_id: trainerId }; if (opts && opts.client_id) row.client_id = opts.client_id; return first(await sb.from('invites').insert(row).select()); },
    getInvite: async function (token) { return first(await sb.from('invites').select('*').eq('token', token)); },
    bindInvite: async function (token, data) {
      var inv = await this.getInvite(token); if (!inv) throw new Error('invite not found');
      var c = await this.createClient(inv.trainer_id, data || {});
      await sb.from('invites').update({ used_by_client_id: c.id }).eq('token', token);
      return c;
    },

    // ── LOGS ───────────────────────────────────────────────────────────────────
    listLogs: async function (clientId) { return ok(await sb.from('workout_logs').select('*').eq('client_id', clientId).order('date', { ascending: false })); },
    createLog: async function (clientId, data) {
      var tid = await trainerIdOf(clientId);
      var row = { trainer_id: tid, client_id: clientId, date: data.date || today(), day_key: data.day_key || null,
        day_name: data.day_name || null, exercise: data.exercise || null, sets: data.sets || [] };
      return first(await sb.from('workout_logs').insert(row).select());
    },
    deleteLog: async function (logId) { ok(await sb.from('workout_logs').delete().eq('id', logId)); return { ok: true }; },

    // ── NUTRITION ──────────────────────────────────────────────────────────────
    listNutrition: async function (clientId) { return ok(await sb.from('nutrition_logs').select('*').eq('client_id', clientId).order('date', { ascending: false }).order('time', { ascending: false })); },
    addNutrition: async function (clientId, data) {
      var tid = await trainerIdOf(clientId);
      var items = Array.isArray(data.items) ? data.items.map(function (it) {
        return { name: it.name || 'Продукт', grams: it.grams != null ? it.grams : null,
          kcal: it.kcal != null ? it.kcal : null, protein: it.protein != null ? it.protein : null,
          carbs: it.carbs != null ? it.carbs : null, fat: it.fat != null ? it.fat : null };
      }) : [];
      var sum = items.reduce(function (a, it) { return { kcal: a.kcal + (Number(it.kcal) || 0), protein: a.protein + (Number(it.protein) || 0), carbs: a.carbs + (Number(it.carbs) || 0), fat: a.fat + (Number(it.fat) || 0) }; }, { kcal: 0, protein: 0, carbs: 0, fat: 0 });
      var has = items.length > 0;
      var row = { trainer_id: tid, client_id: clientId, date: data.date || today(), time: data.time || nowIso().slice(11, 16),
        slot: data.slot === 'snack' ? 'snack' : 'meal', slot_idx: data.slot_idx != null ? Number(data.slot_idx) : 0,
        label: data.label || null, kind: data.kind || 'text', text: data.text || '', photo: data.photo || null, items: items,
        kcal: data.kcal != null ? data.kcal : (has ? Math.round(sum.kcal) : null),
        protein: data.protein != null ? data.protein : (has ? Math.round(sum.protein) : null),
        carbs: data.carbs != null ? data.carbs : (has ? Math.round(sum.carbs) : null),
        fat: data.fat != null ? data.fat : (has ? Math.round(sum.fat) : null), reviewed: false };
      return first(await sb.from('nutrition_logs').insert(row).select());
    },
    reviewNutrition: async function (clientId) {
      var rows = ok(await sb.from('nutrition_logs').select('id,photo').eq('client_id', clientId).eq('reviewed', false));
      var purged = rows.filter(function (n) { return n.photo; }).length;
      ok(await sb.from('nutrition_logs').update({ reviewed: true, photo: null }).eq('client_id', clientId).eq('reviewed', false));
      return { ok: true, purged: purged };
    },
    deleteNutrition: async function (nutId) { ok(await sb.from('nutrition_logs').delete().eq('id', nutId)); return { ok: true }; },

    // ── PAYMENTS ───────────────────────────────────────────────────────────────
    listPayments: async function (trainerId) { return ok(await sb.from('payments').select('*').eq('trainer_id', trainerId).order('date', { ascending: false })); },
    listClientPayments: async function (clientId) { return ok(await sb.from('payments').select('*').eq('client_id', clientId).order('date', { ascending: false })); },
    addPayment: async function (clientId, data) {
      var tid = await trainerIdOf(clientId);
      var row = { trainer_id: tid, client_id: clientId, amount: data.amount != null ? Number(data.amount) : null,
        currency: data.currency || 'USD', date: data.date || today(), period_until: data.period_until || null,
        method: data.method || null, coupon_code: data.coupon_code || null, note: data.note || '' };
      var pay = first(await sb.from('payments').insert(row).select());
      // Оновити paid_until клієнта (як у mock: продовжити доступ).
      if (row.period_until) await sb.from('clients').update({ paid_until: row.period_until }).eq('id', clientId);
      return pay;
    },
    deletePayment: async function (paymentId) { ok(await sb.from('payments').delete().eq('id', paymentId)); return { ok: true }; },

    // ── COUPONS ────────────────────────────────────────────────────────────────
    listCoupons: async function (trainerId) { return ok(await sb.from('coupons').select('*').eq('trainer_id', trainerId)); },
    createCoupon: async function (trainerId, data) {
      var row = { trainer_id: trainerId, code: data.code, kind: data.kind || 'percent', value: data.value != null ? Number(data.value) : 0, note: data.note || '', active: true };
      return first(await sb.from('coupons').insert(row).select());
    },
    updateCoupon: async function (couponId, patch) { return first(await sb.from('coupons').update(patch).eq('id', couponId).select()); },
    deleteCoupon: async function (couponId) { ok(await sb.from('coupons').delete().eq('id', couponId)); return { ok: true }; },

    // ── TASKS ──────────────────────────────────────────────────────────────────
    listTasks: async function (trainerId) { return ok(await sb.from('tasks').select('*').eq('trainer_id', trainerId)); },
    createTask: async function (trainerId, data) {
      var row = Object.assign({ trainer_id: trainerId, done: false }, data);
      return first(await sb.from('tasks').insert(row).select());
    },
    updateTask: async function (taskId, patch) { return first(await sb.from('tasks').update(patch).eq('id', taskId).select()); },
    deleteTask: async function (taskId) { ok(await sb.from('tasks').delete().eq('id', taskId)); return { ok: true }; },

    // ── DEV ────────────────────────────────────────────────────────────────────
    reset: async function () { throw new Error('reset недоступний у Supabase-режимі'); },
  };
})();

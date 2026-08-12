/* ───────────────────────────────────────────────────────────────────────────
   DataStore (КЛІЄНТСЬКИЙ) — для клієнтського апу в Supabase/Telegram-режимі.
   Не має прямого доступу до БД (RLS). Ходить у Edge Functions:
     • telegram-auth — валідує Telegram initData + інвайт → видає client-JWT
     • client-api    — усі операції клієнта, скоуплені по client_id з токена
   Той самий набір методів, який очікує клієнтський апп + TrainerSync.
   Конфіг: window.SUPABASE_URL, window.SUPABASE_ANON_KEY (publishable).
   ─────────────────────────────────────────────────────────────────────────── */
(function () {
  var SUPABASE_URL = window.SUPABASE_URL || 'https://owkxlpuuvmybdsfwebzo.supabase.co';
  var PUB = window.SUPABASE_ANON_KEY || 'sb_publishable__F8TFeb5p8b8_KkMmkturQ_p1y15Dkk';
  var FN = SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/';

  function tok() { try { return localStorage.getItem('gf_client_token') || null; } catch (e) { return null; } }
  function setSession(token, clientId, trainerId) {
    try { if (token) localStorage.setItem('gf_client_token', token);
      if (clientId) localStorage.setItem('gf_client_id', clientId);
      if (trainerId) localStorage.setItem('gf_trainer_id', trainerId); } catch (e) {}
  }
  function tgWebApp() { try { return (window.Telegram && window.Telegram.WebApp) || null; } catch (e) { return null; } }
  function tgInitData() { var t = tgWebApp(); return (t && t.initData) || ''; }
  function invParam() {
    try {
      var t = tgWebApp();
      var sp = (t && t.initDataUnsafe && t.initDataUnsafe.start_param) || null;
      var q = new URLSearchParams(location.search);
      return sp || q.get('startapp') || q.get('invite') || null;
    } catch (e) { return null; }
  }
  // ?trainer=<slug> у Main Mini App URL бота тренера → визначає, чиїм ботом валідувати
  // initData (мульти-бот) і чий бренд показати ДО привʼязки.
  function trainerSlug() {
    try { return new URLSearchParams(location.search).get('trainer') || null; } catch (e) { return null; }
  }

  async function post(url, body, bearer) {
    var headers = { 'Content-Type': 'application/json', apikey: PUB, Authorization: 'Bearer ' + (bearer || PUB) };
    var r = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body || {}) });
    var txt = await r.text(); var j; try { j = JSON.parse(txt); } catch (e) { j = txt; }
    if (!r.ok) { var msg = (j && j.error) || ('HTTP ' + r.status); throw new Error(msg); }
    return j;
  }

  var _authing = null;
  async function ensureAuth() {
    if (tok()) return tok();
    if (_authing) return _authing;
    _authing = (async function () {
      var initData = tgInitData();
      if (!initData) throw new Error('Відкрий у Telegram (немає initData)');
      var res = await post(FN + 'telegram-auth', { initData: initData, invite: invParam(), trainer: trainerSlug() });
      setSession(res.token, res.client_id, res.trainer_id);
      return res.token;
    })();
    try { return await _authing; } finally { _authing = null; }
  }
  async function api(action, payload) {
    var t = await ensureAuth();
    try {
      return await post(FN + 'client-api', Object.assign({ action: action }, payload || {}), t);
    } catch (e) {
      // Токен протух/недійсний (напр. лишився з попередньої сесії на телефоні) →
      // скидаємо його й авторизуємось наново ОДИН раз. Self-healing, без «завису».
      var msg = String((e && e.message) || '');
      if (msg.indexOf('unauthorized') >= 0 || msg.indexOf('401') >= 0) {
        try { localStorage.removeItem('gf_client_token'); } catch (_) {}
        var t2 = await ensureAuth();
        return await post(FN + 'client-api', Object.assign({ action: action }, payload || {}), t2);
      }
      throw e;
    }
  }

  // Публічний бренд тренера за slug (trainer_public, anon-читання через PostgREST) —
  // щоб застосувати лого/accent ДО Telegram-логіну (немає initData / ще не привʼязаний).
  async function publicBrand(slug) {
    if (!slug) return null;
    try {
      var url = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/trainer_public'
        + '?slug=eq.' + encodeURIComponent(slug)
        + '&select=id,slug,brand_name,trainer_name,photo_url,telegram_chat_url,accent&limit=1';
      var r = await fetch(url, { headers: { apikey: PUB, Authorization: 'Bearer ' + PUB } });
      if (!r.ok) return null;
      var arr = await r.json();
      return (Array.isArray(arr) && arr[0]) || null;
    } catch (e) { return null; }
  }

  window.ClientAPI = { ensureAuth: ensureAuth, api: api, token: tok, publicBrand: publicBrand, trainerSlug: trainerSlug,
    clientId: function () { try { return localStorage.getItem('gf_client_id'); } catch (e) { return null; } } };

  // ── DataStore-сумісний шар (клієнтський апп + TrainerSync кличуть саме це) ──
  window.DataStore = {
    base: 'client-supabase',
    clientBundle: async function (_cid) { await ensureAuth(); return api('bundle'); },
    getClient: async function () { return { measurements: [] }; },     // TrainerSync dedup → no-op (сервер дедупить)

    listLogs: function (_cid) { return api('logs.list'); },
    createLog: function (_cid, data) { return api('logs.create', { data: data }); },
    deleteLog: function (id) { return api('logs.delete', { id: id }); },
    workoutSummary: function (_cid, data) { return api('workout.summary', { data: data }); },

    listNutrition: function (_cid) { return api('nutrition.list'); },
    addNutrition: function (_cid, data) { return api('nutrition.add', { data: data }); },
    deleteNutrition: function (id) { return api('nutrition.delete', { id: id }); },

    addClientMeasurement: function (_cid, data) { return api('measurement.add', { data: data }); },
    deleteClientMeasurement: function () { return Promise.resolve({ ok: true }); }, // client-api дедупить за датою

    addClientPhoto: function (_cid, data) { return api('photo.add', { data: data }); },
    deleteClientPhoto: function (_cid, id) { return api('photo.delete', { id: id }); },
    // Оригінал фото у повній якості: signed PUT (аплоуд) + signed GET (перегляд/завантаження).
    photoUploadUrl: function (ext) { return api('photo.uploadUrl', { data: { ext: ext || 'jpg' } }); },
    photoUrl: function (id) { return api('photo.url', { id: id }); },

    // ── Зустрічі: найближчі + підтвердження з апу ──
    meetingsList: function () { return api('meetings.list'); },
    meetingRespond: function (id, status) { return api('meetings.respond', { id: id, data: { status: status } }); },

    // ── Щоденний звіт (квіз): конфіг чек-листа, надсилання, історія ──
    reportConfig: function () { return api('report.config'); },
    reportSubmit: function (data) { return api('report.submit', { data: data }); },
    reportHistory: function () { return api('report.history'); },

    // ── Внутрішній чат із тренером (текст + голосові) ──
    chatList: function () { return api('chat.list'); },
    chatVoiceUploadUrl: function (ext) { return api('chat.voiceUploadUrl', { data: { ext: ext || 'webm' } }); },
    chatSend: function (data) { return api('chat.send', { data: data }); },
    chatSeen: function () { return api('chat.seen'); },

    // Анкета: стать/ціль/досвід/вага/зріст з клієнтського онборду → рядок клієнта (для тренера).
    updateProfile: function (_cid, data) { return api('profile.update', { data: data }); },

    // Apple Health: активність (кроки/калорії) + персональний вебхук-URL для налаштування.
    getHealth: function () { return api('health.get'); },
    healthSetup: function () { return api('health.setup'); },

    // Фідбек тренера: список + позначити прочитаним.
    getFeedback: function () { return api('feedback.list'); },
    markFeedbackSeen: function () { return api('feedback.seen'); },

    // Відео тренеру (розбір техніки): 1) взяти signed upload URL, 2) створити запит.
    formcheckUploadUrl: function (ext) { return api('formcheck.uploadUrl', { data: { ext: ext || 'mp4' } }); },
    formcheckCreate: function (data) { return api('formcheck.create', { data: data }); },
    // Гілка «Розбори» в Чаті: список запитів+відповідей (signed URLs) + позначити прочитаним.
    formcheckList: function () { return api('formcheck.list'); },
    formcheckSeen: function () { return api('formcheck.seen'); },
  };
})();

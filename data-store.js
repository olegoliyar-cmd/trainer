/* ───────────────────────────────────────────────────────────────────────────
   DataStore — СПІЛЬНИЙ шар доступу до даних для ОБОХ апів (клієнт + тренер).
   Зараз ходить у mock-бекенд (/api). Коли заведемо реальний Supabase —
   переписуємо ТІЛЬКИ цей файл (методи ті самі), фронти не міняються.
   Використання:  <script src="/data-store.js"></script>  → window.DataStore
   ─────────────────────────────────────────────────────────────────────────── */
(function () {
  var BASE = (window.DATA_STORE_BASE || '/api').replace(/\/$/, '');

  async function req(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    var r = await fetch(BASE + path, opts);
    var txt = await r.text();
    var data = txt ? JSON.parse(txt) : null;
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    return data;
  }

  window.DataStore = {
    base: BASE,

    // TRAINERS
    listTrainers: function () { return req('GET', '/trainers'); },
    getTrainer: function (id) { return req('GET', '/trainers/' + id); },
    createTrainer: function (data) { return req('POST', '/trainers', data); },
    updateTrainer: function (id, patch) { return req('PATCH', '/trainers/' + id, patch); },
    trainerBundle: function (id) { return req('GET', '/trainers/' + id + '/bundle'); },

    // CLIENTS
    listClients: function (trainerId) { return req('GET', '/trainers/' + trainerId + '/clients'); },
    createClient: function (trainerId, data) { return req('POST', '/trainers/' + trainerId + '/clients', data); },
    getClient: function (id) { return req('GET', '/clients/' + id); },
    updateClient: function (id, patch) { return req('PATCH', '/clients/' + id, patch); },
    deleteClient: function (id) { return req('DELETE', '/clients/' + id); },
    clientBundle: function (id) { return req('GET', '/clients/' + id + '/bundle'); },
    setClientProfile: function (id, profile) { return req('PATCH', '/clients/' + id + '/profile', profile); },
    addClientPhoto: function (id, data) { return req('POST', '/clients/' + id + '/photos', data); },
    deleteClientPhoto: function (id, photoId) { return req('DELETE', '/clients/' + id + '/photos/' + photoId); },
    addClientMeasurement: function (id, data) { return req('POST', '/clients/' + id + '/measurements', data); },
    deleteClientMeasurement: function (id, msId) { return req('DELETE', '/clients/' + id + '/measurements/' + msId); },

    // PROGRAMS
    listPrograms: function (trainerId) { return req('GET', '/trainers/' + trainerId + '/programs'); },
    listTemplates: function (trainerId) { return req('GET', '/trainers/' + trainerId + '/templates'); },
    createProgram: function (trainerId, data) { return req('POST', '/trainers/' + trainerId + '/programs', data); },
    updateProgram: function (programId, patch) { return req('PATCH', '/programs/' + programId, patch); },
    cloneProgram: function (programId, opts) { return req('POST', '/programs/' + programId + '/clone', opts || {}); },
    // Скласти персональну програму клієнту й одразу призначити.
    createClientProgram: function (clientId, data) { return req('POST', '/clients/' + clientId + '/program', data); },

    // EXERCISES — бібліотека (спільна) + завантажені тренером
    listExercises: function (trainerId) { return req('GET', '/trainers/' + trainerId + '/exercises'); },
    createExercise: function (trainerId, data) { return req('POST', '/trainers/' + trainerId + '/exercises', data); },
    updateExercise: function (exerciseId, patch) { return req('PATCH', '/exercises/' + exerciseId, patch); },
    deleteExercise: function (exerciseId) { return req('DELETE', '/exercises/' + exerciseId); },

    // ASSIGNMENTS — тренер призначає програму клієнту
    assignProgram: function (clientId, programId) { return req('POST', '/clients/' + clientId + '/assign', { program_id: programId }); },

    // INVITES — прив'язка клієнта до тренера
    createInvite: function (trainerId) { return req('POST', '/trainers/' + trainerId + '/invites'); },
    getInvite: function (token) { return req('GET', '/invites/' + token); },
    bindInvite: function (token, data) { return req('POST', '/invites/' + token + '/bind', data || {}); },

    // LOGS — клієнт логує → тренер бачить
    listLogs: function (clientId) { return req('GET', '/clients/' + clientId + '/logs'); },
    createLog: function (clientId, data) { return req('POST', '/clients/' + clientId + '/logs', data); },
    deleteLog: function (logId) { return req('DELETE', '/logs/' + logId); },

    // NUTRITION — харчування клієнта (тренер бачить; фото — до перевірки)
    listNutrition: function (clientId) { return req('GET', '/clients/' + clientId + '/nutrition'); },
    addNutrition: function (clientId, data) { return req('POST', '/clients/' + clientId + '/nutrition', data); },
    reviewNutrition: function (clientId) { return req('POST', '/clients/' + clientId + '/nutrition/review'); },
    deleteNutrition: function (nutId) { return req('DELETE', '/nutrition/' + nutId); },

    // PAYMENTS — оплати клієнтів
    listPayments: function (trainerId) { return req('GET', '/trainers/' + trainerId + '/payments'); },
    listClientPayments: function (clientId) { return req('GET', '/clients/' + clientId + '/payments'); },
    addPayment: function (clientId, data) { return req('POST', '/clients/' + clientId + '/payments', data); },
    deletePayment: function (paymentId) { return req('DELETE', '/payments/' + paymentId); },

    // COUPONS — купони знижок
    listCoupons: function (trainerId) { return req('GET', '/trainers/' + trainerId + '/coupons'); },
    createCoupon: function (trainerId, data) { return req('POST', '/trainers/' + trainerId + '/coupons', data); },
    updateCoupon: function (couponId, patch) { return req('PATCH', '/coupons/' + couponId, patch); },
    deleteCoupon: function (couponId) { return req('DELETE', '/coupons/' + couponId); },

    // TASKS — CRM-нагадування тренеру
    listTasks: function (trainerId) { return req('GET', '/trainers/' + trainerId + '/tasks'); },
    createTask: function (trainerId, data) { return req('POST', '/trainers/' + trainerId + '/tasks', data); },
    updateTask: function (taskId, patch) { return req('PATCH', '/tasks/' + taskId, patch); },
    deleteTask: function (taskId) { return req('DELETE', '/tasks/' + taskId); },
    updateMeeting: function (id, patch) { return req('PATCH', '/meetings/' + id, patch); },
    deleteMeeting: function (id) { return req('DELETE', '/meetings/' + id); },

    // DEV
    reset: function () { return req('POST', '/dev/reset'); },
  };
})();

/**
 * Робота з Supabase (база даних, Storage bucket "photos" та Realtime-підписки).
 *
 * Таблиці:
 *  - profiles(id, name unique, avatar_url)
 *  - categories(id uuid, name, emoji, color, created_by, created_at)
 *  - category_options(id uuid, category_id, label, emoji, created_by, created_at)
 *  - day_marks(profile_id, date, done, mood, note, photo_url, unique(profile_id, date))
 *  - logs(id, profile_id, category, date, time, type, note, photo_url, options text[])
 * Bucket:
 *  - photos (публічний)
 */
(function () {
  let client = null;
  let realtimeChannel = null;

  function getConfig() {
    const cfg = window.SUPABASE_CONFIG || {};
    return {
      url: (cfg.url || '').trim(),
      anonKey: (cfg.anonKey || '').trim(),
      bucket: (cfg.bucket || 'photos').trim(),
    };
  }

  function isConfigured() {
    const { url, anonKey } = getConfig();
    if (!url || !anonKey) return false;
    if (url.includes('YOUR_PROJECT_ID') || anonKey.includes('YOUR_SUPABASE_ANON_KEY')) {
      return false;
    }
    return /^https?:\/\//i.test(url);
  }

  function formatError(err) {
    if (!err) return 'Невідома помилка';
    const msg = err.message || String(err);
    if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(msg)) {
      return 'Немає зʼєднання з мережею або сервером Supabase. Перевірте інтернет та налаштування в js/config.js.';
    }
    if (/Invalid API key|JWT/i.test(msg)) {
      return 'Невірний ключ Supabase (anonKey у js/config.js).';
    }
    return msg;
  }

  function ensureClient() {
    if (client) return client;

    if (!window.supabase?.createClient) {
      throw new Error('Бібліотека Supabase не завантажилась з CDN. Перевірте підключення до інтернету.');
    }

    if (!isConfigured()) {
      throw new Error('Вкажіть ваші SUPABASE_URL та SUPABASE_ANON_KEY у файлі js/config.js');
    }

    const { url, anonKey } = getConfig();
    client = window.supabase.createClient(url, anonKey, {
      auth: { persistSession: false },
    });
    return client;
  }

  async function open() {
    return ensureClient();
  }

  /* ---------- Storage: завантаження фото в bucket "photos" ---------- */

  async function uploadPhoto(blob, folder = 'items') {
    const sb = ensureClient();
    const { bucket } = getConfig();
    const ext = blob.type === 'image/png' ? 'png' : 'jpg';
    const rand = Math.random().toString(36).slice(2, 9);
    const path = `${folder}/${Date.now()}_${rand}.${ext}`;

    const { error } = await sb.storage.from(bucket).upload(path, blob, {
      contentType: blob.type || 'image/jpeg',
      cacheControl: '3600',
      upsert: false,
    });
    if (error) throw new Error(formatError(error));

    const { data } = sb.storage.from(bucket).getPublicUrl(path);
    if (!data?.publicUrl) {
      throw new Error('Не вдалося отримати публічний URL для завантаженого фото');
    }
    return data.publicUrl;
  }

  /* ---------- Таблиця profiles ---------- */

  async function listProfiles() {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('profiles')
      .select('id, name, avatar_url')
      .order('id', { ascending: false });
    if (error) throw new Error(formatError(error));
    return data || [];
  }

  async function getProfileById(id) {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('profiles')
      .select('id, name, avatar_url')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(formatError(error));
    return data || null;
  }

  async function getProfileByName(name) {
    const sb = ensureClient();
    // Точний пошук без урахування регістру
    const { data, error } = await sb
      .from('profiles')
      .select('id, name, avatar_url')
      .ilike('name', name.replace(/[%_]/g, '\\$&'))
      .maybeSingle();
    if (error) throw new Error(formatError(error));
    return data || null;
  }

  async function createProfile({ name, avatar_url = null }) {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('profiles')
      .insert({ name, avatar_url })
      .select('id, name, avatar_url')
      .single();
    if (error) throw new Error(formatError(error));
    return data;
  }

  async function updateProfile(id, patch) {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('profiles')
      .update(patch)
      .eq('id', id)
      .select('id, name, avatar_url')
      .single();
    if (error) throw new Error(formatError(error));
    return data;
  }

  /* ---------- Таблиця categories ---------- */

  async function listCategories() {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('categories')
      .select('id, name, emoji, color, created_by, created_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw new Error(formatError(error));
    return data || [];
  }

  async function createCategory({ name, emoji, color, created_by }) {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('categories')
      .insert({ name, emoji, color, created_by })
      .select('id, name, emoji, color, created_by, created_at')
      .single();
    if (error) throw new Error(formatError(error));
    return data;
  }

  async function updateCategory(id, patch) {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('categories')
      .update(patch)
      .eq('id', id)
      .select('id, name, emoji, color, created_by, created_at')
      .single();
    if (error) throw new Error(formatError(error));
    return data;
  }

  async function deleteCategory(id, profileId) {
    const sb = ensureClient();
    const { error } = await sb
      .from('categories')
      .delete()
      .eq('id', id)
      .eq('created_by', profileId);
    if (error) throw new Error(formatError(error));
  }

  /* ---------- Таблиця category_options ---------- */

  async function listCategoryOptions() {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('category_options')
      .select('id, category_id, label, emoji, created_by, created_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw new Error(formatError(error));
    return data || [];
  }

  async function createCategoryOption({ category_id, label, emoji, created_by }) {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('category_options')
      .insert({ category_id, label, emoji, created_by })
      .select('id, category_id, label, emoji, created_by, created_at')
      .single();
    if (error) throw new Error(formatError(error));
    return data;
  }

  async function deleteCategoryOption(id, profileId) {
    const sb = ensureClient();
    const { error } = await sb
      .from('category_options')
      .delete()
      .eq('id', id)
      .eq('created_by', profileId);
    if (error) throw new Error(formatError(error));
  }

  /* ---------- Таблиця day_marks ---------- */

  async function getAllDayMarks() {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('day_marks')
      .select('*');
    if (error) throw new Error(formatError(error));
    return data || [];
  }

  async function getDayMarks(profileId) {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('day_marks')
      .select('*')
      .eq('profile_id', profileId);
    if (error) throw new Error(formatError(error));
    return data || [];
  }

  async function upsertDayMark({ profile_id, date, done, mood, note, photo_url }) {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('day_marks')
      .upsert(
        { profile_id, date, done, mood, note, photo_url },
        { onConflict: 'profile_id,date' }
      )
      .select('*')
      .single();
    if (error) throw new Error(formatError(error));
    return data;
  }

  async function deleteDayMark(profileId, date) {
    const sb = ensureClient();
    const { error } = await sb
      .from('day_marks')
      .delete()
      .eq('profile_id', profileId)
      .eq('date', date);
    if (error) throw new Error(formatError(error));
  }

  /* ---------- Таблиця logs ---------- */

  async function getAllLogs() {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('logs')
      .select('*')
      .order('date', { ascending: false })
      .order('time', { ascending: true });
    if (error) throw new Error(formatError(error));
    return data || [];
  }

  async function getLogsByDate(date) {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('logs')
      .select('*')
      .eq('date', date)
      .order('time', { ascending: true });
    if (error) throw new Error(formatError(error));
    return data || [];
  }

  async function getProfileLogs(profileId) {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('logs')
      .select('*')
      .eq('profile_id', profileId)
      .order('date', { ascending: false })
      .order('time', { ascending: true });
    if (error) throw new Error(formatError(error));
    return data || [];
  }

  async function createLog({
    profile_id,
    category,
    date,
    time,
    type,
    note,
    photo_url,
    options = [],
  }) {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('logs')
      .insert({
        profile_id,
        category,
        date,
        time,
        type,
        note,
        photo_url,
        options: Array.isArray(options) ? options : [],
      })
      .select('*')
      .single();
    if (error) throw new Error(formatError(error));
    return data;
  }

  async function updateLog(id, profileId, patch) {
    const sb = ensureClient();
    const { data, error } = await sb
      .from('logs')
      .update(patch)
      .eq('id', id)
      .eq('profile_id', profileId)
      .select('*')
      .single();
    if (error) throw new Error(formatError(error));
    return data;
  }

  async function deleteLog(id, profileId) {
    const sb = ensureClient();
    const { error } = await sb
      .from('logs')
      .delete()
      .eq('id', id)
      .eq('profile_id', profileId);
    if (error) throw new Error(formatError(error));
  }

  async function deleteLogsByCategory(categoryValues) {
    const sb = ensureClient();
    const list = Array.isArray(categoryValues)
      ? categoryValues.filter(Boolean).map(String)
      : [String(categoryValues)].filter(Boolean);
    if (!list.length) return;
    const { error } = await sb
      .from('logs')
      .delete()
      .in('category', list);
    if (error) throw new Error(formatError(error));
  }

  /* ---------- Realtime підписка ---------- */

  function subscribeRealtime({
    onLogsChange,
    onDayMarksChange,
    onProfilesChange,
    onCategoriesChange,
    onCategoryOptionsChange,
    onStatus,
  } = {}) {
    if (!isConfigured() || !window.supabase?.createClient) return null;
    const sb = ensureClient();

    if (realtimeChannel) {
      sb.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }

    realtimeChannel = sb
      .channel('daily-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'logs' },
        (payload) => onLogsChange && onLogsChange(payload)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'day_marks' },
        (payload) => onDayMarksChange && onDayMarksChange(payload)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles' },
        (payload) => onProfilesChange && onProfilesChange(payload)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'categories' },
        (payload) => onCategoriesChange && onCategoriesChange(payload)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'category_options' },
        (payload) => onCategoryOptionsChange && onCategoryOptionsChange(payload)
      )
      .subscribe((status) => {
        if (onStatus) onStatus(status);
      });

    return realtimeChannel;
  }

  window.Daily = window.Daily || {};
  window.Daily.db = {
    open,
    isConfigured,
    formatError,
    uploadPhoto,
    listProfiles,
    getProfileById,
    getProfileByName,
    createProfile,
    updateProfile,
    listCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    listCategoryOptions,
    createCategoryOption,
    deleteCategoryOption,
    getAllDayMarks,
    getDayMarks,
    upsertDayMark,
    deleteDayMark,
    getAllLogs,
    getLogsByDate,
    getProfileLogs,
    createLog,
    updateLog,
    deleteLog,
    deleteLogsByCategory,
    subscribeRealtime,
  };
})();

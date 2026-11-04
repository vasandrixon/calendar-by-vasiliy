/**
 * Календар (Supabase): місячна сітка, панель дня (відмітка, настрій, нотатка, фото), статистика.
 *
 * Таблиця Supabase "day_marks":
 *   { profile_id, date: 'YYYY-MM-DD', done, mood, note, photo_url }
 * День вважається відміченим, якщо done === true або вибрано настрій.
 */
(function () {
  const { db, image } = window.Daily;

  const PHOTO_MAX_SIDE = 1280;
  const PHOTO_QUALITY = 0.8;

  const MONTHS = [
    'Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень',
    'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень',
  ];
  const MONTHS_LOCATIVE = [
    'січні', 'лютому', 'березні', 'квітні', 'травні', 'червні',
    'липні', 'серпні', 'вересні', 'жовтні', 'листопаді', 'грудні',
  ];

  const MOODS = [
    { id: 'great', emoji: '😄', label: 'Чудово' },
    { id: 'good', emoji: '🙂', label: 'Добре' },
    { id: 'ok', emoji: '😐', label: 'Так собі' },
    { id: 'bad', emoji: '😔', label: 'Погано' },
    { id: 'awful', emoji: '😫', label: 'Жахливо' },
  ];
  const MOOD_BY_ID = Object.fromEntries(MOODS.map((m) => [m.id, m]));

  const el = {};

  let profile = null;
  let entries = new Map(); // date -> day_mark row
  let rawLogs = []; // записи активного профілю
  let logCats = new Map(); // date -> Set<categoryId>
  let viewYear = 0;
  let viewMonth = 0;
  let loadToken = 0;

  // Стан панелі дня
  let draft = null;
  let previewUrl = null;
  let stream = null;

  /* ---------- Дати ---------- */

  const pad = (n) => String(n).padStart(2, '0');

  function dateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function parseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function today() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function formatLong(key) {
    const text = parseKey(key).toLocaleDateString('uk-UA', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  /* ---------- Дані ---------- */

  function isMarked(entry) {
    return !!entry && (entry.done || !!entry.mood);
  }

  async function loadEntries() {
    if (!profile) return false;
    const token = ++loadToken;
    el.grid.classList.add('is-loading');

    try {
      const [marksList, logsList] = await Promise.all([
        db.getDayMarks(profile.id),
        db.getProfileLogs(profile.id),
      ]);
      if (token !== loadToken) return false;
      entries = new Map(marksList.map((e) => [e.date, e]));
      rawLogs = logsList;
      buildLogCats(rawLogs);
      return true;
    } finally {
      if (token === loadToken) el.grid.classList.remove('is-loading');
    }
  }

  function buildLogCats(logsList) {
    logCats = new Map();
    const resolveCatId = window.Daily.logs?.resolveLogCategoryId;
    for (const item of logsList) {
      if (!item.date || !item.category) continue;
      const catId = resolveCatId ? resolveCatId(item.category) : item.category;
      if (!catId) continue;
      if (!logCats.has(item.date)) logCats.set(item.date, new Set());
      logCats.get(item.date).add(catId);
    }
  }

  async function refreshLogs(providedProfileLogs) {
    if (!profile) return;
    const targetId = profile.id;
    try {
      const logsList = Array.isArray(providedProfileLogs)
        ? providedProfileLogs
        : await db.getProfileLogs(targetId);
      if (!profile || String(profile.id) !== String(targetId)) return;
      rawLogs = logsList;
      buildLogCats(rawLogs);
      renderGrid();
      renderLegend();
    } catch (err) {
      window.Daily.notifyError?.(db.formatError(err));
    }
  }

  async function reload() {
    if (!profile) return;
    try {
      if (await loadEntries()) render();
    } catch (err) {
      window.Daily.notifyError?.(db.formatError(err));
    }
  }

  /** Серія днів підряд, що закінчується сьогодні (або вчора, якщо сьогодні ще не відмічено). */
  function currentStreak() {
    const d = today();
    if (!isMarked(entries.get(dateKey(d)))) d.setDate(d.getDate() - 1);

    let count = 0;
    while (isMarked(entries.get(dateKey(d)))) {
      count++;
      d.setDate(d.getDate() - 1);
    }
    return count;
  }

  /* ---------- Рендер ---------- */

  function render(direction = 0) {
    el.title.replaceChildren();
    const month = document.createElement('span');
    month.className = 'cal-month';
    month.textContent = MONTHS[viewMonth];
    const year = document.createElement('span');
    year.className = 'cal-year';
    year.textContent = viewYear;
    el.title.append(month, ' ', year);

    renderGrid();
    renderLegend();
    renderStats();

    if (direction) {
      const cls = direction > 0 ? 'anim-next' : 'anim-prev';
      for (const node of [el.grid, el.title]) {
        node.classList.remove('anim-next', 'anim-prev');
        void node.offsetWidth;
        node.classList.add(cls);
      }
    }
  }

  function renderGrid() {
    const offset = (new Date(viewYear, viewMonth, 1).getDay() + 6) % 7; // тиждень з понеділка
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const todayKey = dateKey(today());
    const frag = document.createDocumentFragment();

    for (let i = 0; i < offset; i++) {
      const blank = document.createElement('span');
      blank.className = 'day day--blank';
      frag.append(blank);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const key = dateKey(new Date(viewYear, viewMonth, day));
      const entry = entries.get(key);
      const labels = [formatLong(key)];

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'day';
      btn.dataset.date = key;

      if (key === todayKey) {
        btn.classList.add('is-today');
        labels.push('сьогодні');
      }
      if (key > todayKey) {
        btn.classList.add('is-future');
        btn.disabled = true;
      }

      if (entry?.photo_url) {
        const img = document.createElement('img');
        img.className = 'day-thumb';
        img.src = entry.photo_url;
        img.loading = 'lazy';
        img.alt = '';
        btn.append(img);
        btn.classList.add('has-photo');
        labels.push('є фото');
      }

      if (isMarked(entry)) btn.classList.add('is-marked');

      const num = document.createElement('span');
      num.className = 'day-num';
      num.textContent = day;
      btn.append(num);

      if (entry?.done) {
        const check = document.createElement('span');
        check.className = 'day-check';
        check.textContent = '✓';
        btn.append(check);
        labels.push('виконано');
      }

      const mood = entry?.mood && MOOD_BY_ID[entry.mood];
      if (mood) {
        const moodEl = document.createElement('span');
        moodEl.className = 'day-mood';
        moodEl.textContent = mood.emoji;
        btn.append(moodEl);
        labels.push(`настрій: ${mood.label}`);
      }

      const cats = logCats.get(key);
      if (cats?.size) {
        const allCategories = window.Daily.logs?.getCategories?.() || [
          { id: 'food', title: 'Їжа', color: '#e5a95c' },
          { id: 'toilet', title: 'Туалет', color: '#6bc4a6' },
        ];
        const dots = document.createElement('span');
        dots.className = 'day-dots';
        for (const cat of allCategories) {
          if (!cats.has(cat.id)) continue;
          const dot = document.createElement('span');
          dot.className = `day-dot day-dot--${cat.id}`;
          dot.style.background = cat.color;
          dot.title = cat.title;
          dots.append(dot);
          labels.push(`є записи: ${cat.title}`);
        }
        if (dots.childElementCount) btn.append(dots);
      }

      btn.setAttribute('aria-label', labels.join(', '));
      frag.append(btn);
    }

    el.grid.replaceChildren(frag);
  }

  function renderLegend() {
    if (!el.legend) return;
    const allCategories = window.Daily.logs?.getCategories?.() || [
      { id: 'food', title: 'Їжа', color: '#e5a95c' },
      { id: 'toilet', title: 'Туалет', color: '#6bc4a6' },
    ];
    el.legend.replaceChildren();
    for (const cat of allCategories) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const dot = document.createElement('span');
      dot.className = `day-dot day-dot--${cat.id}`;
      dot.style.background = cat.color;
      item.append(dot, ` ${cat.title}`);
      el.legend.append(item);
    }
  }

  function renderStats() {
    const prefix = `${viewYear}-${pad(viewMonth + 1)}-`;
    let marked = 0;
    for (const [key, entry] of entries) {
      if (key.startsWith(prefix) && isMarked(entry)) marked++;
    }

    el.statMonth.textContent = marked;
    el.statMonthLabel.textContent =
      `${plural(marked, 'день відмічено', 'дні відмічено', 'днів відмічено')} у ${MONTHS_LOCATIVE[viewMonth]}`;

    const streak = currentStreak();
    el.statStreak.textContent = streak;
    el.statStreakLabel.textContent = `${plural(streak, 'день', 'дні', 'днів')} підряд`;
  }

  /* ---------- Навігація ---------- */

  function setMonth(year, month) {
    const d = new Date(year, month, 1);
    const direction = Math.sign(
      (d.getFullYear() - viewYear) * 12 + (d.getMonth() - viewMonth)
    );
    viewYear = d.getFullYear();
    viewMonth = d.getMonth();
    render(direction);
  }

  function goToday() {
    const t = today();
    setMonth(t.getFullYear(), t.getMonth());
  }

  /* ---------- Панель дня ---------- */

  function openDay(key) {
    const entry = entries.get(key);
    draft = {
      date: key,
      done: !!entry?.done,
      mood: entry?.mood || null,
      note: entry?.note || '',
      photoUrl: entry?.photo_url || null,
      newPhotoBlob: null,
    };

    el.entryTitle.textContent = formatLong(key);
    el.done.checked = draft.done;
    el.note.value = draft.note;
    el.deleteBtn.hidden = !entry;
    showEntryError('');
    setBusy(false);
    renderMoods();
    renderPhoto();

    el.dialog.classList.remove('is-closing');
    el.dialog.showModal();
  }

  function closeDialog() {
    if (!el.dialog.open || el.dialog.classList.contains('is-closing')) return;
    stopCamera();
    el.dialog.classList.add('is-closing');

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      el.dialog.classList.remove('is-closing');
      if (el.dialog.open) el.dialog.close();
    };

    el.dialog.addEventListener('animationend', function onEnd(e) {
      if (e.target !== el.dialog) return;
      el.dialog.removeEventListener('animationend', onEnd);
      finish();
    });
    setTimeout(finish, 260);
  }

  function onDialogClosed() {
    el.dialog.classList.remove('is-closing');
    stopCamera();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    el.preview.removeAttribute('src');
    draft = null;
  }

  function renderMoods() {
    for (const btn of el.moods.children) {
      const active = btn.dataset.mood === draft.mood;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
  }

  function renderPhoto() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }

    if (draft?.newPhotoBlob) {
      previewUrl = URL.createObjectURL(draft.newPhotoBlob);
      el.preview.src = previewUrl;
    } else if (draft?.photoUrl) {
      el.preview.src = draft.photoUrl;
    } else {
      el.preview.removeAttribute('src');
    }
    updatePhotoUI();
  }

  function updatePhotoUI() {
    const hasPhoto = !!(draft?.newPhotoBlob || draft?.photoUrl);
    const camera = !!stream;

    el.preview.hidden = !hasPhoto || camera;
    el.photoEmpty.hidden = hasPhoto || camera;
    el.video.hidden = !camera;
    el.photoActions.hidden = camera;
    el.cameraActions.hidden = !camera;
    el.photoRemove.hidden = !hasPhoto;
    el.photoFile.textContent = hasPhoto ? 'Замінити з файлу' : 'З файлу';
    el.cameraStart.textContent = hasPhoto ? 'Перезняти камерою' : 'Камера';
  }

  function showEntryError(message) {
    el.entryError.textContent = message;
    el.entryError.hidden = !message;
  }

  function setBusy(busy) {
    el.photoBusy.hidden = !busy;
    for (const btn of [el.save, el.photoFile, el.cameraStart, el.cameraCapture, el.photoRemove]) {
      btn.disabled = busy;
    }
  }

  /** Стискає фото через canvas (макс. 1280px, якість 0.8) і кладе в чернетку для завантаження в Storage. */
  async function applyPhoto(source) {
    const target = draft;
    const blob = await image.compress(source, PHOTO_MAX_SIDE, PHOTO_QUALITY);
    if (target !== draft) return;
    draft.newPhotoBlob = blob;
    renderPhoto();
  }

  async function withBusy(task) {
    showEntryError('');
    setBusy(true);
    try {
      await task();
    } catch (err) {
      showEntryError(db.formatError(err));
    } finally {
      setBusy(false);
    }
  }

  function onPhotoFile() {
    const file = el.photoInput.files[0];
    el.photoInput.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showEntryError('Оберіть файл зображення');
      return;
    }

    withBusy(async () => {
      const img = await image.loadImage(file);
      await applyPhoto(img);
    });
  }

  function removePhoto() {
    if (!draft) return;
    draft.newPhotoBlob = null;
    draft.photoUrl = null;
    renderPhoto();
  }

  /* ---------- Камера ---------- */

  async function startCamera() {
    if (stream || el.cameraStart.disabled) return;
    showEntryError('');

    if (!navigator.mediaDevices?.getUserMedia) {
      showEntryError('Камера недоступна в цьому браузері — додайте фото з файлу.');
      el.photoFile.focus();
      return;
    }

    el.cameraStart.disabled = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch (err) {
      const messages = {
        NotAllowedError: 'Доступ до камери заборонено. Дозвольте його в браузері або додайте фото з файлу.',
        PermissionDeniedError: 'Доступ до камери заборонено. Дозвольте його в браузері або додайте фото з файлу.',
        NotFoundError: 'Камеру не знайдено — додайте фото з файлу.',
        DevicesNotFoundError: 'Камеру не знайдено — додайте фото з файлу.',
        NotReadableError: 'Камера зайнята іншою програмою — додайте фото з файлу.',
      };
      showEntryError(messages[err.name] || 'Не вдалося увімкнути камеру — додайте фото з файлу.');
      el.photoFile.focus();
      return;
    } finally {
      el.cameraStart.disabled = false;
    }

    if (!el.dialog.open) {
      stopCamera();
      return;
    }

    el.video.srcObject = stream;
    updatePhotoUI();
    try {
      await el.video.play();
    } catch {
      // ігноруємо автоплей-переривання при швидкому закритті
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    el.video.srcObject = null;
    if (draft) updatePhotoUI();
  }

  function capturePhoto() {
    withBusy(async () => {
      const frame = image.frameFromVideo(el.video);
      stopCamera();
      await applyPhoto(frame);
    });
  }

  /* ---------- Збереження в Supabase ---------- */

  async function saveEntry(event) {
    event.preventDefault();
    if (!draft || el.save.disabled || !profile) return;

    draft.done = el.done.checked;
    draft.note = el.note.value.trim();

    const { date } = draft;
    const existing = entries.get(date);
    const hasPhoto = !!(draft.newPhotoBlob || draft.photoUrl);
    const isEmpty = !draft.done && !draft.mood && !draft.note && !hasPhoto;

    const origSaveText = el.save.textContent;
    el.save.disabled = true;
    el.save.textContent = 'Збереження…';
    setBusy(true);
    showEntryError('');

    try {
      if (isEmpty) {
        if (existing) {
          await db.deleteDayMark(profile.id, date);
          entries.delete(date);
        }
      } else {
        let finalPhotoUrl = draft.photoUrl;
        if (draft.newPhotoBlob) {
          finalPhotoUrl = await db.uploadPhoto(draft.newPhotoBlob, 'day_marks');
        }

        const saved = await db.upsertDayMark({
          profile_id: profile.id,
          date,
          done: draft.done,
          mood: draft.mood,
          note: draft.note,
          photo_url: finalPhotoUrl || null,
        });
        entries.set(date, saved);
      }

      el.dialog.close();
      render();
    } catch (err) {
      showEntryError('Не вдалося зберегти: ' + db.formatError(err));
    } finally {
      setBusy(false);
      el.save.disabled = false;
      el.save.textContent = origSaveText;
    }
  }

  async function deleteEntry() {
    const existing = draft && entries.get(draft.date);
    if (!existing || !profile) return;
    if (!confirm('Видалити запис за цей день разом із фото?')) return;

    setBusy(true);
    try {
      await db.deleteDayMark(profile.id, existing.date);
      entries.delete(existing.date);
      el.dialog.close();
      render();
    } catch (err) {
      showEntryError('Не вдалося видалити: ' + db.formatError(err));
    } finally {
      setBusy(false);
    }
  }

  /* ---------- Публічне API ---------- */

  function init() {
    const $ = (id) => document.getElementById(id);

    el.title = $('cal-title');
    el.grid = $('cal-grid');
    el.legend = $('cal-legend');
    el.statMonth = $('stat-month');
    el.statMonthLabel = $('stat-month-label');
    el.statStreak = $('stat-streak');
    el.statStreakLabel = $('stat-streak-label');

    el.dialog = $('entry-dialog');
    el.form = $('entry-form');
    el.entryTitle = $('entry-title');
    el.done = $('entry-done');
    el.moods = $('entry-moods');
    el.note = $('entry-note');
    el.preview = $('photo-preview');
    el.video = $('camera-video');
    el.photoEmpty = $('photo-empty');
    el.photoBusy = $('photo-busy');
    el.photoActions = $('photo-actions');
    el.photoInput = $('photo-input');
    el.photoFile = $('photo-file');
    el.cameraStart = $('camera-start');
    el.photoRemove = $('photo-remove');
    el.cameraActions = $('camera-actions');
    el.cameraCapture = $('camera-capture');
    el.cameraCancel = $('camera-cancel');
    el.entryError = $('entry-error');
    el.deleteBtn = $('entry-delete');
    el.save = $('entry-save');

    for (const mood of MOODS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mood';
      btn.dataset.mood = mood.id;
      btn.title = mood.label;
      btn.setAttribute('aria-label', mood.label);
      btn.textContent = mood.emoji;
      el.moods.append(btn);
    }

    $('cal-prev').addEventListener('click', () => setMonth(viewYear, viewMonth - 1));
    $('cal-next').addEventListener('click', () => setMonth(viewYear, viewMonth + 1));
    $('cal-today').addEventListener('click', goToday);

    el.grid.addEventListener('click', (e) => {
      const day = e.target.closest('.day[data-date]');
      if (day && !day.disabled) openDay(day.dataset.date);
    });

    el.moods.addEventListener('click', (e) => {
      const btn = e.target.closest('.mood');
      if (!btn || !draft) return;
      draft.mood = draft.mood === btn.dataset.mood ? null : btn.dataset.mood;
      renderMoods();
    });

    el.photoFile.addEventListener('click', () => el.photoInput.click());
    el.photoInput.addEventListener('change', onPhotoFile);
    el.photoRemove.addEventListener('click', removePhoto);
    el.cameraStart.addEventListener('click', startCamera);
    el.cameraCapture.addEventListener('click', capturePhoto);
    el.cameraCancel.addEventListener('click', stopCamera);

    el.form.addEventListener('submit', saveEntry);
    el.deleteBtn.addEventListener('click', deleteEntry);
    el.dialog.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', closeDialog);
    });
    el.dialog.addEventListener('click', (e) => {
      if (e.target === el.dialog) closeDialog();
    });
    el.dialog.addEventListener('close', onDialogClosed);
  }

  async function show(activeProfile) {
    if (el.dialog.open) el.dialog.close();
    profile = activeProfile;
    entries = new Map();
    rawLogs = [];
    logCats = new Map();
    const t = today();
    viewYear = t.getFullYear();
    viewMonth = t.getMonth();
    render();

    try {
      if (await loadEntries()) render();
    } catch (err) {
      window.Daily.notifyError?.(db.formatError(err));
    }
  }

  function hide() {
    if (el.dialog.open) el.dialog.close();
    loadToken++;
    profile = null;
    entries = new Map();
    rawLogs = [];
    logCats = new Map();
    el.grid.replaceChildren();
  }

  window.Daily = window.Daily || {};
  window.Daily.calendar = { init, show, hide, refreshLogs, reload };
})();

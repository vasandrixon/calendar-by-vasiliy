/**
 * Відділи (трекери) щоденних записів та загальна Стрічка (Supabase):
 *  - Таблиця Supabase: logs(id, profile_id, category, date, time, type, note, photo_url)
 *  - Bucket Storage: "photos" (публічний)
 *  - Стрічка: записи ВСІХ профілів з бази за обраний день, відсортовані за часом
 */
(function () {
  const { db, image, auth } = window.Daily;

  const PHOTO_MAX_SIDE = 1280;
  const PHOTO_QUALITY = 0.8;
  const CATEGORIES_STORAGE_KEY = 'daily.customCategories';

  const DEFAULT_CATEGORIES = [
    {
      id: 'food',
      title: 'Їжа',
      icon: '🍽',
      color: '#e5a95c',
      builtin: true,
      types: [
        { id: 'breakfast', icon: '🌅', label: 'Сніданок' },
        { id: 'lunch', icon: '🍲', label: 'Обід' },
        { id: 'dinner', icon: '🌙', label: 'Вечеря' },
        { id: 'snack', icon: '🍎', label: 'Перекус' },
      ],
    },
    {
      id: 'toilet',
      title: 'Туалет',
      icon: '💩',
      color: '#6bc4a6',
      builtin: true,
      types: [
        { id: 'pee', icon: '💧', label: 'Мала' },
        { id: 'poop', icon: '💩', label: 'Велика' },
        { id: 'both', icon: '💧💩', label: 'Разом' },
        { id: 'quick', icon: '⚡', label: 'Швидко' },
      ],
    },
  ];

  const EMOJI_PRESETS = ['✨', '💧', '🏃', '😴', '💊', '📚', '☕', '🧘', '🎮', '🌿'];
  const COLOR_PRESETS = [
    '#e5a95c',
    '#6bc4a6',
    '#7aa2f7',
    '#e08a84',
    '#bb9af7',
    '#7dcfff',
    '#9ece6a',
    '#f7768e',
  ];

  const el = {};

  let profile = null;
  let categoriesMap = new Map(); // catId -> category object
  let allLogs = []; // усі записи всіх профілів із таблиці logs
  let profilesById = new Map(); // profile_id -> profile
  let activeCategory = 'food';
  let selectedDate = ''; // 'YYYY-MM-DD' у трекері
  let feedDate = ''; // 'YYYY-MM-DD' у стрічці
  let feedCatFilter = 'all';
  let feedProfileFilter = 'all';
  let loadToken = 0;
  let isLoading = false;
  let onCategoriesChanged = null;

  // Стан модалки запису
  let draft = null;
  let previewUrl = null;
  let stream = null;

  // Стан модалки відділу
  let editingCatId = null;

  /* ---------- Дати й час ---------- */

  const pad = (n) => String(n).padStart(2, '0');

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function currentTimeStr() {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function shiftDate(key, deltaDays) {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + deltaDays);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }

  function formatDateLabel(key) {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const text = dt.toLocaleDateString('uk-UA', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const capitalized = text.charAt(0).toUpperCase() + text.slice(1);
    return key === todayKey() ? `Сьогодні, ${capitalized}` : capitalized;
  }

  /* ---------- Кодування поля "що їв" + "нотатка" в колонку note ---------- */

  function packFoodNote(what, note) {
    const w = (what || '').trim();
    const n = (note || '').trim();
    if (w && n) return `${w}\n${n}`;
    return w || n || '';
  }

  function unpackLogNote(item) {
    const raw = item.note || '';
    if (item.category !== 'food') {
      return { what: '', note: raw };
    }
    const idx = raw.indexOf('\n');
    if (idx === -1) {
      return { what: raw, note: '' };
    }
    return {
      what: raw.slice(0, idx).trim(),
      note: raw.slice(idx + 1).trim(),
    };
  }

  /* ---------- Відділи (localStorage + автовиявлення з бази) ---------- */

  function readStoredCategories() {
    try {
      const raw = localStorage.getItem(CATEGORIES_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function writeStoredCategories(list) {
    localStorage.setItem(CATEGORIES_STORAGE_KEY, JSON.stringify(list));
  }

  function buildCategoriesMap() {
    const stored = readStoredCategories();
    const storedById = new Map(stored.map((c) => [c.id, c]));
    const map = new Map();

    for (const def of DEFAULT_CATEGORIES) {
      const saved = storedById.get(def.id);
      if (saved?.deleted) continue;
      map.set(def.id, {
        ...def,
        ...(saved ? { title: saved.title, icon: saved.icon, color: saved.color } : {}),
      });
    }

    const customList = stored
      .filter((c) => !c.deleted && !DEFAULT_CATEGORIES.some((d) => d.id === c.id))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    for (const custom of customList) {
      map.set(custom.id, {
        id: custom.id,
        title: custom.title,
        icon: custom.icon || '✨',
        color: custom.color || '#7aa2f7',
        builtin: false,
        types: custom.types || [],
        createdAt: custom.createdAt || 0,
      });
    }

    // Якщо в логах з інших пристроїв є відділи, яких ще немає локально — додаємо їх
    for (const log of allLogs) {
      if (log.category && !map.has(log.category)) {
        const saved = storedById.get(log.category);
        if (saved?.deleted) continue;
        map.set(log.category, {
          id: log.category,
          title: log.category,
          icon: '✨',
          color: '#7aa2f7',
          builtin: false,
          types: [],
        });
      }
    }

    categoriesMap = map;
  }

  function getCategories() {
    if (!categoriesMap.size) buildCategoriesMap();
    return [...categoriesMap.values()];
  }

  function getCategory(id) {
    if (!categoriesMap.size) buildCategoriesMap();
    return categoriesMap.get(id) || null;
  }

  function findTypeInfo(category, typeId) {
    if (!typeId) return null;
    const cat = getCategory(category);
    return cat?.types?.find((t) => t.id === typeId) || null;
  }

  /* ---------- Завантаження з Supabase та скелетони ---------- */

  function renderSkeletons(container, count = 3) {
    container.replaceChildren();
    for (let i = 0; i < count; i++) {
      const sk = document.createElement('div');
      sk.className = 'skeleton skeleton-log';
      container.append(sk);
    }
  }

  async function loadAllData({ showSkeleton = false } = {}) {
    if (!profile) return false;
    const token = ++loadToken;
    isLoading = true;

    if (showSkeleton) {
      el.logEmpty.hidden = true;
      el.feedEmpty.hidden = true;
      renderSkeletons(el.logList, 2);
      renderSkeletons(el.feedList, 3);
    }

    try {
      const [logsList, profilesList] = await Promise.all([
        db.getAllLogs(),
        db.listProfiles(),
      ]);
      if (token !== loadToken) return false;
      allLogs = logsList;
      profilesById = new Map(profilesList.map((p) => [String(p.id), p]));
      buildCategoriesMap();
      return true;
    } finally {
      if (token === loadToken) isLoading = false;
    }
  }

  async function reloadFromRealtime() {
    if (!profile) return;
    try {
      if (await loadAllData({ showSkeleton: false })) {
        if (onCategoriesChanged) onCategoriesChanged();
        renderTracker();
        renderFeed();
        const myLogs = allLogs.filter((l) => String(l.profile_id) === String(profile.id));
        await window.Daily.calendar.refreshLogs(myLogs);
      }
    } catch (err) {
      window.Daily.notifyError?.(db.formatError(err));
    }
  }

  /* ---------- Створення / Редагування / Видалення відділу ---------- */

  function openNewCategoryModal() {
    editingCatId = null;
    el.catDialogTitle.textContent = 'Новий відділ';
    el.catTitleInput.value = '';
    el.catIconInput.value = '✨';
    el.catColorInput.value = '#7aa2f7';
    showCatError('');
    syncCatPresets();

    el.catDialog.classList.remove('is-closing');
    el.catDialog.showModal();
    el.catTitleInput.focus();
  }

  function openEditCategoryModal(catId = activeCategory) {
    const cat = getCategory(catId);
    if (!cat) return;
    editingCatId = cat.id;
    el.catDialogTitle.textContent = 'Редагувати відділ';
    el.catTitleInput.value = cat.title;
    el.catIconInput.value = cat.icon;
    el.catColorInput.value = cat.color;
    showCatError('');
    syncCatPresets();

    el.catDialog.classList.remove('is-closing');
    el.catDialog.showModal();
    el.catTitleInput.focus();
  }

  function closeCatModal() {
    if (!el.catDialog.open || el.catDialog.classList.contains('is-closing')) return;
    el.catDialog.classList.add('is-closing');

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      el.catDialog.classList.remove('is-closing');
      if (el.catDialog.open) el.catDialog.close();
    };

    el.catDialog.addEventListener('animationend', function onEnd(e) {
      if (e.target !== el.catDialog) return;
      el.catDialog.removeEventListener('animationend', onEnd);
      finish();
    });
    setTimeout(finish, 260);
  }

  function showCatError(msg) {
    el.catError.textContent = msg;
    el.catError.hidden = !msg;
  }

  function syncCatPresets() {
    const emojiVal = el.catIconInput.value.trim();
    for (const btn of el.catEmojiPresets.children) {
      btn.classList.toggle('is-active', btn.dataset.emoji === emojiVal);
    }
    const colorVal = el.catColorInput.value.toLowerCase();
    for (const btn of el.catColorPresets.children) {
      btn.classList.toggle('is-active', btn.dataset.color.toLowerCase() === colorVal);
    }
  }

  async function saveCategory(event) {
    event.preventDefault();
    const title = el.catTitleInput.value.trim().replace(/\s+/g, ' ');
    const icon = el.catIconInput.value.trim() || '✨';
    const color = el.catColorInput.value || '#7aa2f7';

    if (!title) {
      showCatError('Введіть назву відділу');
      el.catTitleInput.focus();
      return;
    }

    const duplicate = getCategories().find(
      (c) => c.id !== editingCatId && c.title.toLocaleLowerCase('uk') === title.toLocaleLowerCase('uk')
    );
    if (duplicate) {
      showCatError('Відділ із такою назвою вже існує');
      el.catTitleInput.focus();
      return;
    }

    el.catSaveBtn.disabled = true;
    try {
      const id = editingCatId || `cat_${Date.now()}`;
      const stored = readStoredCategories().filter((c) => c.id !== id);
      stored.push({
        id,
        title,
        icon,
        color,
        createdAt: categoriesMap.get(id)?.createdAt || Date.now(),
      });
      writeStoredCategories(stored);
      buildCategoriesMap();

      activeCategory = id;
      el.catDialog.close();

      if (onCategoriesChanged) onCategoriesChanged(id);
      renderTracker();
      renderFeed();
      const myLogs = allLogs.filter((l) => String(l.profile_id) === String(profile.id));
      await window.Daily.calendar.refreshLogs(myLogs);
    } catch (err) {
      showCatError('Не вдалося зберегти відділ: ' + db.formatError(err));
    } finally {
      el.catSaveBtn.disabled = false;
    }
  }

  async function deleteActiveCategory() {
    const cat = getCategory(activeCategory);
    if (!cat) return;

    if (!confirm(`Видалити відділ «${cat.title}»?`)) return;

    const catLogs = allLogs.filter((item) => item.category === cat.id);
    const removeRecords = confirm(
      catLogs.length > 0
        ? `У відділі «${cat.title}» є записи (${catLogs.length}). Видалити також усі записи цього відділу?`
        : `Видалити також усі записи відділу «${cat.title}»?`
    );

    try {
      const stored = readStoredCategories().filter((c) => c.id !== cat.id);
      stored.push({ id: cat.id, deleted: true });
      writeStoredCategories(stored);

      if (removeRecords) {
        await db.deleteLogsByCategory(cat.id);
        allLogs = allLogs.filter((item) => item.category !== cat.id);
      }

      buildCategoriesMap();
      if (feedCatFilter === cat.id) feedCatFilter = 'all';

      const remaining = getCategories();
      activeCategory = remaining[0]?.id || 'food';

      if (onCategoriesChanged) onCategoriesChanged('calendar');
      renderFeed();
      const myLogs = allLogs.filter((l) => String(l.profile_id) === String(profile.id));
      await window.Daily.calendar.refreshLogs(myLogs);
    } catch (err) {
      window.Daily.notifyError?.(db.formatError(err));
    }
  }

  /* ---------- Рендер відділу ---------- */

  function renderTracker() {
    const cat = getCategory(activeCategory);
    if (!cat || !profile) return;

    el.trackerIcon.textContent = cat.icon;
    el.trackerIcon.style.borderColor = `${cat.color}44`;
    el.trackerTitle.textContent = cat.title;
    el.trackerDate.value = selectedDate;
    el.trackerDateLabel.textContent = formatDateLabel(selectedDate);

    if (isLoading) return;

    const dayLogs = allLogs
      .filter(
        (item) =>
          String(item.profile_id) === String(profile.id) &&
          item.category === activeCategory &&
          item.date === selectedDate
      )
      .sort((a, b) => (a.time || '').localeCompare(b.time || '') || String(a.id).localeCompare(String(b.id)));

    el.logList.replaceChildren();
    el.logEmpty.hidden = dayLogs.length > 0;
    el.logEmptyText.textContent = `За цей день у відділі «${cat.title}» записів ще немає`;

    const frag = document.createDocumentFragment();
    for (const item of dayLogs) {
      frag.append(
        createLogCard(item, {
          showCategory: false,
          showAuthor: false,
          canEdit: true,
        })
      );
    }
    el.logList.append(frag);
  }

  /* ---------- Рендер Стрічки (усі профілі) ---------- */

  function renderCatFilters() {
    el.feedCatFilters.replaceChildren();

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'btn btn-secondary btn-sm';
    allBtn.dataset.filter = 'all';
    allBtn.textContent = 'Усі';
    allBtn.classList.toggle('is-active', feedCatFilter === 'all');
    el.feedCatFilters.append(allBtn);

    for (const cat of getCategories()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary btn-sm';
      btn.dataset.filter = cat.id;
      btn.textContent = `${cat.icon} ${cat.title}`;
      btn.classList.toggle('is-active', feedCatFilter === cat.id);
      el.feedCatFilters.append(btn);
    }
  }

  function renderProfileFilters() {
    el.feedProfileFilters.replaceChildren();

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'btn btn-secondary btn-sm';
    allBtn.dataset.profile = 'all';
    allBtn.textContent = 'Усі';
    allBtn.classList.toggle('is-active', feedProfileFilter === 'all');
    el.feedProfileFilters.append(allBtn);

    for (const p of profilesById.values()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary btn-sm feed-profile-chip';
      btn.dataset.profile = String(p.id);
      btn.classList.toggle('is-active', feedProfileFilter === String(p.id));

      const av = document.createElement('span');
      av.className = 'avatar avatar--xs';
      auth.fillAvatar(av, p);

      const name = document.createElement('span');
      name.textContent = p.name;

      btn.append(av, name);
      el.feedProfileFilters.append(btn);
    }
  }

  function renderFeed() {
    if (!profile) return;

    el.feedDate.value = feedDate;
    el.feedDateLabel.textContent = formatDateLabel(feedDate);

    renderCatFilters();
    renderProfileFilters();

    if (isLoading) return;

    const filtered = allLogs
      .filter((item) => {
        if (item.date !== feedDate) return false;
        if (feedCatFilter !== 'all' && item.category !== feedCatFilter) return false;
        if (feedProfileFilter !== 'all' && String(item.profile_id) !== feedProfileFilter) return false;
        return true;
      })
      .sort((a, b) => (a.time || '').localeCompare(b.time || '') || String(a.id).localeCompare(String(b.id)));

    el.feedList.replaceChildren();
    el.feedEmpty.hidden = filtered.length > 0;

    if (!filtered.length) return;

    const frag = document.createDocumentFragment();
    for (const item of filtered) {
      frag.append(
        createLogCard(item, {
          showCategory: true,
          showAuthor: true,
          canEdit: String(item.profile_id) === String(profile.id),
        })
      );
    }
    el.feedList.append(frag);
  }

  function resolveCategoryMeta(item) {
    const cat = getCategory(item.category);
    if (cat) return cat;
    return {
      id: item.category,
      title: item.category || 'Відділ',
      icon: '✨',
      color: '#7aa2f7',
      types: [],
    };
  }

  function createLogCard(item, { showCategory, showAuthor, canEdit }) {
    const cat = resolveCategoryMeta(item);
    const typeInfo = findTypeInfo(item.category, item.type);
    const author = profilesById.get(String(item.profile_id));
    const { what, note } = unpackLogNote(item);

    const card = document.createElement('article');
    card.className = `log-item log-item--${item.category}`;
    card.dataset.id = String(item.id);

    const timeEl = document.createElement('div');
    timeEl.className = 'log-time';
    timeEl.textContent = (item.time || '—').slice(0, 5);

    const main = document.createElement('div');
    main.className = 'log-main';

    const topRow = document.createElement('div');
    topRow.className = 'log-top';

    if (showAuthor) {
      const authorEl = document.createElement('span');
      authorEl.className = 'log-author';

      const av = document.createElement('span');
      av.className = 'avatar avatar--xs';
      if (author) {
        auth.fillAvatar(av, author);
      } else {
        av.textContent = '?';
      }

      const nameEl = document.createElement('span');
      nameEl.className = 'log-author-name';
      nameEl.textContent = author ? author.name : 'Користувач';

      authorEl.append(av, nameEl);
      topRow.append(authorEl);
    }

    if (showCategory) {
      const catBadge = document.createElement('span');
      catBadge.className = `log-badge log-badge--${item.category}`;
      catBadge.style.background = `${cat.color}22`;
      catBadge.style.color = cat.color;
      catBadge.textContent = `${cat.icon} ${cat.title}`;
      topRow.append(catBadge);
    }

    if (typeInfo) {
      const typeBadge = document.createElement('span');
      typeBadge.className = 'log-type-badge';
      typeBadge.textContent = `${typeInfo.icon} ${typeInfo.label}`;
      topRow.append(typeBadge);
    }

    if (topRow.childElementCount) {
      main.append(topRow);
    }

    if (what) {
      const whatEl = document.createElement('div');
      whatEl.className = 'log-what';
      whatEl.textContent = what;
      main.append(whatEl);
    }

    if (note) {
      const noteEl = document.createElement('div');
      noteEl.className = 'log-note';
      noteEl.textContent = note;
      main.append(noteEl);
    }

    if (item.photo_url) {
      const img = document.createElement('img');
      img.className = 'log-thumb';
      img.src = item.photo_url;
      img.loading = 'lazy';
      img.alt = 'Фото запису';
      main.append(img);
    }

    card.append(timeEl, main);

    if (canEdit) {
      const actions = document.createElement('div');
      actions.className = 'log-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'icon-btn';
      editBtn.dataset.action = 'edit';
      editBtn.title = 'Редагувати';
      editBtn.setAttribute('aria-label', 'Редагувати запис');
      editBtn.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'icon-btn icon-btn--danger';
      delBtn.dataset.action = 'delete';
      delBtn.title = 'Видалити';
      delBtn.setAttribute('aria-label', 'Видалити запис');
      delBtn.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';

      actions.append(editBtn, delBtn);
      card.append(actions);
    }

    return card;
  }

  /* ---------- Модальне вікно додавання / редагування запису ---------- */

  function openNewLog(category = activeCategory) {
    const cat = getCategory(category) || getCategories()[0];
    if (!cat) return;
    draft = {
      id: null,
      category: cat.id,
      date: selectedDate || todayKey(),
      time: currentTimeStr(),
      type: cat.types?.[0]?.id || '',
      what: '',
      note: '',
      photoUrl: null,
      newPhotoBlob: null,
    };
    openModalWithDraft(`${cat.icon} Додати запис: ${cat.title}`);
  }

  function openEditLog(rawId) {
    const existing = allLogs.find((item) => String(item.id) === String(rawId));
    if (!existing || !profile || String(existing.profile_id) !== String(profile.id)) return;
    const cat = resolveCategoryMeta(existing);
    const { what, note } = unpackLogNote(existing);

    draft = {
      id: existing.id,
      category: existing.category,
      date: existing.date,
      time: (existing.time || currentTimeStr()).slice(0, 5),
      type: existing.type || cat.types?.[0]?.id || '',
      what,
      note,
      photoUrl: existing.photo_url || null,
      newPhotoBlob: null,
    };
    openModalWithDraft(`${cat.icon} Редагувати: ${cat.title}`);
  }

  function openModalWithDraft(titleText) {
    const cat = getCategory(draft.category);
    const hasTypes = !!cat?.types?.length;

    el.dialogTitle.textContent = titleText;
    el.dateInput.value = draft.date;
    el.timeInput.value = draft.time;
    el.whatInput.value = draft.what;
    el.noteInput.value = draft.note;
    el.typeField.hidden = !hasTypes;
    el.foodField.hidden = draft.category !== 'food';
    el.deleteBtn.hidden = !draft.id;

    showError('');
    setBusy(false);
    if (hasTypes) renderTypeChips();
    renderDraftPhoto();

    el.dialog.classList.remove('is-closing');
    el.dialog.showModal();
  }

  function closeModal() {
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

  function renderTypeChips() {
    const cat = getCategory(draft.category);
    el.types.replaceChildren();
    if (!cat?.types?.length) return;
    for (const t of cat.types) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'type-chip';
      btn.dataset.type = t.id;
      const active = draft.type === t.id;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));

      const icon = document.createElement('span');
      icon.className = 'type-chip-icon';
      icon.textContent = t.icon;

      const label = document.createElement('span');
      label.className = 'type-chip-label';
      label.textContent = t.label;

      btn.append(icon, label);
      el.types.append(btn);
    }
  }

  function renderDraftPhoto() {
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

  function showError(msg) {
    el.error.textContent = msg;
    el.error.hidden = !msg;
  }

  function setBusy(busy) {
    el.photoBusy.hidden = !busy;
    for (const btn of [el.saveBtn, el.photoFile, el.cameraStart, el.cameraCapture, el.photoRemove]) {
      btn.disabled = busy;
    }
  }

  /** Стискає фото через canvas (макс. 1280px, якість 0.8) для завантаження в Storage. */
  async function applyPhoto(source) {
    const target = draft;
    const blob = await image.compress(source, PHOTO_MAX_SIDE, PHOTO_QUALITY);
    if (target !== draft) return;
    draft.newPhotoBlob = blob;
    renderDraftPhoto();
  }

  async function withBusy(task) {
    showError('');
    setBusy(true);
    try {
      await task();
    } catch (err) {
      showError(db.formatError(err));
    } finally {
      setBusy(false);
    }
  }

  function onPhotoFile() {
    const file = el.photoInput.files[0];
    el.photoInput.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showError('Оберіть файл зображення');
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
    renderDraftPhoto();
  }

  /* ---------- Камера ---------- */

  async function startCamera() {
    if (stream || el.cameraStart.disabled) return;
    showError('');

    if (!navigator.mediaDevices?.getUserMedia) {
      showError('Камера недоступна в цьому браузері — додайте фото з файлу.');
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
      showError(messages[err.name] || 'Не вдалося увімкнути камеру — додайте фото з файлу.');
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
      // ігноруємо автоплей-переривання при закритті
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

  /* ---------- Збереження / Видалення запису в Supabase ---------- */

  async function saveLog(event) {
    event.preventDefault();
    if (!draft || el.saveBtn.disabled || !profile) return;

    const date = el.dateInput.value || todayKey();
    const time = el.timeInput.value || currentTimeStr();
    const what = draft.category === 'food' ? el.whatInput.value.trim() : '';
    const noteText = el.noteInput.value.trim();
    const hasPhoto = !!(draft.newPhotoBlob || draft.photoUrl);

    if (draft.category === 'food' && !what && !noteText && !hasPhoto) {
      showError('Вкажіть, що їли, або додайте нотатку чи фото');
      el.whatInput.focus();
      return;
    }

    const combinedNote = draft.category === 'food' ? packFoodNote(what, noteText) : noteText;

    const origSaveText = el.saveBtn.textContent;
    el.saveBtn.disabled = true;
    el.saveBtn.textContent = 'Збереження…';
    setBusy(true);
    showError('');

    try {
      let finalPhotoUrl = draft.photoUrl;
      if (draft.newPhotoBlob) {
        finalPhotoUrl = await db.uploadPhoto(draft.newPhotoBlob, 'logs');
      }

      const payload = {
        profile_id: profile.id,
        category: draft.category,
        date,
        time,
        type: draft.type || null,
        note: combinedNote || null,
        photo_url: finalPhotoUrl || null,
      };

      if (draft.id) {
        const updated = await db.updateLog(draft.id, profile.id, payload);
        const idx = allLogs.findIndex((x) => String(x.id) === String(draft.id));
        if (idx !== -1) allLogs[idx] = updated;
        else allLogs.push(updated);
      } else {
        const created = await db.createLog(payload);
        allLogs.push(created);
      }

      selectedDate = date;
      feedDate = date;
      el.dialog.close();
      renderTracker();
      renderFeed();
      const myLogs = allLogs.filter((l) => String(l.profile_id) === String(profile.id));
      await window.Daily.calendar.refreshLogs(myLogs);
    } catch (err) {
      showError('Не вдалося зберегти: ' + db.formatError(err));
    } finally {
      setBusy(false);
      el.saveBtn.disabled = false;
      el.saveBtn.textContent = origSaveText;
    }
  }

  async function deleteLogById(rawId) {
    const existing = allLogs.find((item) => String(item.id) === String(rawId));
    if (!existing || !profile || String(existing.profile_id) !== String(profile.id)) return;
    if (!confirm('Видалити цей запис?')) return;

    setBusy(true);
    try {
      await db.deleteLog(existing.id, profile.id);
      allLogs = allLogs.filter((item) => String(item.id) !== String(existing.id));
      if (el.dialog.open) el.dialog.close();
      renderTracker();
      renderFeed();
      const myLogs = allLogs.filter((l) => String(l.profile_id) === String(profile.id));
      await window.Daily.calendar.refreshLogs(myLogs);
    } catch (err) {
      if (el.dialog.open) showError('Не вдалося видалити: ' + db.formatError(err));
      else window.Daily.notifyError?.(db.formatError(err));
    } finally {
      setBusy(false);
    }
  }

  function onListClick(event) {
    const actionBtn = event.target.closest('[data-action]');
    const card = event.target.closest('.log-item');
    if (!card || !actionBtn) return;
    const rawId = card.dataset.id;

    if (actionBtn.dataset.action === 'delete') {
      deleteLogById(rawId);
    } else if (actionBtn.dataset.action === 'edit') {
      openEditLog(rawId);
    }
  }

  /* ---------- Публічне API ---------- */

  function init({ onCategoriesChange } = {}) {
    onCategoriesChanged = onCategoriesChange || null;
    const $ = (id) => document.getElementById(id);

    el.trackerIcon = $('tracker-icon');
    el.trackerTitle = $('tracker-title');
    el.trackerDateLabel = $('tracker-date-label');
    el.trackerDate = $('tracker-date');
    el.catEditBtn = $('cat-edit-btn');
    el.catDeleteBtn = $('cat-delete-btn');
    el.logAddBtn = $('log-add-btn');
    el.logList = $('log-list');
    el.logEmpty = $('log-empty');
    el.logEmptyText = $('log-empty-text');

    el.feedDateLabel = $('feed-date-label');
    el.feedDate = $('feed-date');
    el.feedCatFilters = $('feed-cat-filters');
    el.feedProfileFilters = $('feed-profile-filters');
    el.feedList = $('feed-list');
    el.feedEmpty = $('feed-empty');

    el.dialog = $('log-dialog');
    el.form = $('log-form');
    el.dialogTitle = $('log-dialog-title');
    el.dateInput = $('log-date');
    el.timeInput = $('log-time');
    el.typeField = $('log-type-field');
    el.types = $('log-types');
    el.foodField = $('log-food-field');
    el.whatInput = $('log-what');
    el.noteInput = $('log-note');
    el.preview = $('log-photo-preview');
    el.video = $('log-camera-video');
    el.photoEmpty = $('log-photo-empty');
    el.photoBusy = $('log-photo-busy');
    el.photoActions = $('log-photo-actions');
    el.photoInput = $('log-photo-input');
    el.photoFile = $('log-photo-file');
    el.cameraStart = $('log-camera-start');
    el.photoRemove = $('log-photo-remove');
    el.cameraActions = $('log-camera-actions');
    el.cameraCapture = $('log-camera-capture');
    el.cameraCancel = $('log-camera-cancel');
    el.error = $('log-error');
    el.deleteBtn = $('log-delete');
    el.saveBtn = $('log-save');

    el.catDialog = $('category-dialog');
    el.catForm = $('category-form');
    el.catDialogTitle = $('cat-dialog-title');
    el.catTitleInput = $('cat-title-input');
    el.catIconInput = $('cat-icon-input');
    el.catEmojiPresets = $('cat-emoji-presets');
    el.catColorInput = $('cat-color-input');
    el.catColorPresets = $('cat-color-presets');
    el.catError = $('cat-error');
    el.catSaveBtn = $('cat-save-btn');

    for (const emoji of EMOJI_PRESETS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cat-preset-emoji';
      btn.dataset.emoji = emoji;
      btn.textContent = emoji;
      el.catEmojiPresets.append(btn);
    }

    for (const color of COLOR_PRESETS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cat-preset-color';
      btn.dataset.color = color;
      btn.style.background = color;
      btn.setAttribute('aria-label', `Колір ${color}`);
      el.catColorPresets.append(btn);
    }

    el.catEmojiPresets.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-emoji]');
      if (!btn) return;
      el.catIconInput.value = btn.dataset.emoji;
      syncCatPresets();
    });
    el.catIconInput.addEventListener('input', syncCatPresets);

    el.catColorPresets.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-color]');
      if (!btn) return;
      el.catColorInput.value = btn.dataset.color;
      syncCatPresets();
    });
    el.catColorInput.addEventListener('input', syncCatPresets);

    el.catForm.addEventListener('submit', saveCategory);
    el.catDialog.querySelectorAll('[data-cat-close]').forEach((btn) => {
      btn.addEventListener('click', closeCatModal);
    });
    el.catDialog.addEventListener('click', (e) => {
      if (e.target === el.catDialog) closeCatModal();
    });

    el.catEditBtn.addEventListener('click', () => openEditCategoryModal(activeCategory));
    el.catDeleteBtn.addEventListener('click', deleteActiveCategory);

    selectedDate = todayKey();
    feedDate = todayKey();

    $('tracker-prev').addEventListener('click', () => {
      selectedDate = shiftDate(selectedDate, -1);
      renderTracker();
    });
    $('tracker-next').addEventListener('click', () => {
      selectedDate = shiftDate(selectedDate, 1);
      renderTracker();
    });
    $('tracker-today').addEventListener('click', () => {
      selectedDate = todayKey();
      renderTracker();
    });
    el.trackerDate.addEventListener('change', () => {
      if (el.trackerDate.value) {
        selectedDate = el.trackerDate.value;
        renderTracker();
      }
    });

    $('feed-prev').addEventListener('click', () => {
      feedDate = shiftDate(feedDate, -1);
      renderFeed();
    });
    $('feed-next').addEventListener('click', () => {
      feedDate = shiftDate(feedDate, 1);
      renderFeed();
    });
    $('feed-today').addEventListener('click', () => {
      feedDate = todayKey();
      renderFeed();
    });
    el.feedDate.addEventListener('change', () => {
      if (el.feedDate.value) {
        feedDate = el.feedDate.value;
        renderFeed();
      }
    });

    el.logAddBtn.addEventListener('click', () => openNewLog(activeCategory));
    el.logList.addEventListener('click', onListClick);
    el.feedList.addEventListener('click', onListClick);

    el.feedCatFilters.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      feedCatFilter = btn.dataset.filter;
      renderFeed();
    });

    el.feedProfileFilters.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-profile]');
      if (!btn) return;
      feedProfileFilter = btn.dataset.profile;
      renderFeed();
    });

    el.types.addEventListener('click', (e) => {
      const chip = e.target.closest('.type-chip');
      if (!chip || !draft) return;
      draft.type = chip.dataset.type;
      renderTypeChips();
    });

    el.photoFile.addEventListener('click', () => el.photoInput.click());
    el.photoInput.addEventListener('change', onPhotoFile);
    el.photoRemove.addEventListener('click', removePhoto);
    el.cameraStart.addEventListener('click', startCamera);
    el.cameraCapture.addEventListener('click', capturePhoto);
    el.cameraCancel.addEventListener('click', stopCamera);

    el.form.addEventListener('submit', saveLog);
    el.deleteBtn.addEventListener('click', () => draft?.id && deleteLogById(draft.id));
    el.dialog.querySelectorAll('[data-log-close]').forEach((btn) => {
      btn.addEventListener('click', closeModal);
    });
    el.dialog.addEventListener('click', (e) => {
      if (e.target === el.dialog) closeModal();
    });
    el.dialog.addEventListener('close', onDialogClosed);
  }

  async function setProfile(activeProfile) {
    if (el.dialog.open) el.dialog.close();
    if (el.catDialog.open) el.catDialog.close();
    profile = activeProfile;
    allLogs = [];
    profilesById = new Map();
    selectedDate = todayKey();
    feedDate = todayKey();
    feedCatFilter = 'all';
    feedProfileFilter = 'all';
    buildCategoriesMap();

    try {
      if (await loadAllData({ showSkeleton: true })) {
        if (onCategoriesChanged) onCategoriesChanged();
        renderTracker();
        renderFeed();
        const myLogs = allLogs.filter((l) => String(l.profile_id) === String(profile.id));
        await window.Daily.calendar.refreshLogs(myLogs);
      }
    } catch (err) {
      window.Daily.notifyError?.(db.formatError(err));
    }
  }

  function showCategory(category) {
    activeCategory = category;
    renderTracker();
  }

  async function showFeed() {
    renderFeed();
    try {
      if (await loadAllData({ showSkeleton: allLogs.length === 0 })) {
        renderFeed();
      }
    } catch (err) {
      window.Daily.notifyError?.(db.formatError(err));
    }
  }

  function hide() {
    if (el.dialog.open) el.dialog.close();
    if (el.catDialog.open) el.catDialog.close();
    loadToken++;
    profile = null;
    allLogs = [];
    profilesById = new Map();
    el.logList.replaceChildren();
    el.feedList.replaceChildren();
  }

  window.Daily = window.Daily || {};
  window.Daily.logs = {
    init,
    setProfile,
    showCategory,
    showFeed,
    hide,
    getCategories,
    openNewCategoryModal,
    reloadFromRealtime,
  };
})();

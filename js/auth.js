/**
 * Профілі користувачів через Supabase:
 * - екран входу: імʼя + завантаження аватарки в Storage bucket "photos"
 * - при вході шукає профіль за імʼям у таблиці profiles; якщо є — заходить, якщо нема — створює
 * - id активного профілю зберігається в localStorage для авто-входу
 * - меню користувача в шапці
 */
(function () {
  const { db, image } = window.Daily;

  const STORAGE_KEY = 'daily.activeProfileId';
  const PHOTO_MAX_SIDE = 1280;
  const PHOTO_QUALITY = 0.8;

  const el = {};
  let handlers = {};
  let pendingAvatar = null; // Blob стисненої аватарки для завантаження у Storage
  let previewUrl = null;

  /* ---------- Сесія (localStorage) ---------- */

  function getActiveId() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const num = Number(raw);
    return Number.isInteger(num) && String(num) === raw ? num : raw;
  }

  function setActiveId(id) {
    localStorage.setItem(STORAGE_KEY, String(id));
  }

  function clearActiveId() {
    localStorage.removeItem(STORAGE_KEY);
  }

  /* ---------- Профілі ---------- */

  function normalizeName(name) {
    return name.trim().replace(/\s+/g, ' ');
  }

  async function getActiveProfile() {
    const id = getActiveId();
    if (id === null) return null;

    const profile = await db.getProfileById(id);
    if (!profile) clearActiveId();
    return profile || null;
  }

  /** Заходить у профіль з таким імʼям або створює новий у Supabase. */
  async function loginByName(name, avatarBlob) {
    const cleanName = normalizeName(name);
    let profile = await db.getProfileByName(cleanName);

    let uploadedUrl = null;
    if (avatarBlob) {
      uploadedUrl = await db.uploadPhoto(avatarBlob, 'avatars');
    }

    if (!profile) {
      profile = await db.createProfile({
        name: cleanName,
        avatar_url: uploadedUrl,
      });
    } else if (uploadedUrl) {
      profile = await db.updateProfile(profile.id, {
        avatar_url: uploadedUrl,
      });
    }

    setActiveId(profile.id);
    return profile;
  }

  async function loginById(id) {
    const profile = await db.getProfileById(id);
    if (!profile) throw new Error('Профіль не знайдено в базі');
    setActiveId(profile.id);
    return profile;
  }

  /* ---------- Аватарки ---------- */

  function initial(name) {
    return ((name || '').trim()[0] || '?').toLocaleUpperCase('uk');
  }

  /** Заповнює елемент .avatar картинкою за avatar_url або першою літерою імені. */
  function fillAvatar(target, profile) {
    target.textContent = '';
    const url = profile?.avatar_url;

    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => {
        target.textContent = initial(profile.name);
        target.classList.add('avatar--empty');
      };
      target.appendChild(img);
      target.classList.remove('avatar--empty');
    } else {
      target.textContent = initial(profile?.name);
      target.classList.add('avatar--empty');
    }
  }

  /* ---------- Екран входу ---------- */

  async function showLogin({ cancellable = false } = {}) {
    resetForm();
    el.cancel.hidden = !cancellable;
    el.nameInput.focus();
    await renderProfileList();
  }

  function renderProfileSkeletons() {
    el.profiles.hidden = false;
    el.list.replaceChildren();
    for (let i = 0; i < 2; i++) {
      const li = document.createElement('li');
      li.className = 'skeleton skeleton-profile';
      el.list.append(li);
    }
  }

  async function renderProfileList() {
    if (!db.isConfigured()) {
      el.profiles.hidden = true;
      el.list.replaceChildren();
      return;
    }

    renderProfileSkeletons();
    try {
      const profiles = await db.listProfiles();
      const activeId = getActiveId();

      el.list.replaceChildren();
      el.profiles.hidden = profiles.length === 0;

      for (const profile of profiles) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'profile-item';
        btn.dataset.id = String(profile.id);

        const avatar = document.createElement('span');
        avatar.className = 'avatar avatar--md';
        fillAvatar(avatar, profile);

        const name = document.createElement('span');
        name.className = 'profile-item-name';
        name.textContent = profile.name;

        btn.append(avatar, name);

        if (String(profile.id) === String(activeId)) {
          btn.classList.add('is-current');
          const badge = document.createElement('span');
          badge.className = 'profile-item-badge';
          badge.textContent = 'поточний';
          btn.append(badge);
        }

        const li = document.createElement('li');
        li.append(btn);
        el.list.append(li);
      }
    } catch (err) {
      el.list.replaceChildren();
      el.profiles.hidden = true;
      showError(db.formatError(err));
    }
  }

  function resetForm() {
    el.form.reset();
    setPendingAvatar(null);
    showError('');
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = !message;
  }

  function setPendingAvatar(blob) {
    pendingAvatar = blob;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    el.preview.textContent = '';

    if (blob) {
      previewUrl = URL.createObjectURL(blob);
      const img = document.createElement('img');
      img.src = previewUrl;
      img.alt = 'Превʼю аватарки';
      el.preview.appendChild(img);
      el.preview.classList.remove('avatar--empty');
      el.avatarHint.textContent = 'Змінити аватарку';
    } else {
      el.preview.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
      el.preview.classList.add('avatar--empty');
      el.avatarHint.textContent = 'Завантажити аватарку';
    }
  }

  async function onAvatarChange() {
    const file = el.avatarInput.files[0];
    if (!file) return;

    try {
      const img = await image.loadImage(file);
      // Стискаємо через canvas (до ~1280px, якість 0.8)
      setPendingAvatar(await image.compress(img, PHOTO_MAX_SIDE, PHOTO_QUALITY));
      showError('');
    } catch (err) {
      showError(err.message);
    } finally {
      el.avatarInput.value = '';
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    const name = normalizeName(el.nameInput.value);

    if (!name) {
      showError('Введіть імʼя');
      el.nameInput.focus();
      return;
    }

    const origText = el.submit.textContent;
    el.submit.disabled = true;
    el.submit.textContent = 'Вхід…';
    showError('');

    try {
      const profile = await loginByName(name, pendingAvatar);
      handlers.onLogin(profile);
    } catch (err) {
      showError('Не вдалося увійти: ' + db.formatError(err));
    } finally {
      el.submit.disabled = false;
      el.submit.textContent = origText;
    }
  }

  async function onProfileClick(event) {
    const btn = event.target.closest('.profile-item');
    if (!btn || btn.disabled) return;

    const rawId = btn.dataset.id;
    const id = Number.isInteger(Number(rawId)) && String(Number(rawId)) === rawId ? Number(rawId) : rawId;

    btn.disabled = true;
    showError('');
    try {
      const profile = await loginById(id);
      handlers.onLogin(profile);
    } catch (err) {
      showError(db.formatError(err));
      renderProfileList();
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- Меню користувача в шапці ---------- */

  function setUser(profile) {
    closeMenu();
    if (!profile) {
      el.userMenu.hidden = true;
      return;
    }
    fillAvatar(el.userAvatar, profile);
    el.userName.textContent = profile.name;
    el.userMenu.hidden = false;
  }

  function openMenu() {
    el.dropdown.hidden = false;
    el.menuToggle.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    el.dropdown.hidden = true;
    el.menuToggle.setAttribute('aria-expanded', 'false');
  }

  function onMenuAction(event) {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    closeMenu();

    if (action === 'switch') {
      handlers.onSwitch();
    } else if (action === 'logout') {
      clearActiveId();
      handlers.onLogout();
    }
  }

  /* ---------- Ініціалізація ---------- */

  function init(callbacks) {
    handlers = callbacks;

    el.profiles = document.getElementById('auth-profiles');
    el.list = document.getElementById('profile-list');
    el.form = document.getElementById('login-form');
    el.avatarInput = document.getElementById('avatar-input');
    el.preview = document.getElementById('avatar-preview');
    el.avatarHint = document.getElementById('avatar-hint');
    el.nameInput = document.getElementById('name-input');
    el.error = document.getElementById('login-error');
    el.submit = document.getElementById('login-submit');
    el.cancel = document.getElementById('auth-cancel');

    el.userMenu = document.getElementById('user-menu');
    el.menuToggle = document.getElementById('user-menu-toggle');
    el.dropdown = document.getElementById('user-menu-dropdown');
    el.userAvatar = document.getElementById('user-avatar');
    el.userName = document.getElementById('user-name');

    el.avatarInput.addEventListener('change', onAvatarChange);
    el.form.addEventListener('submit', onSubmit);
    el.list.addEventListener('click', onProfileClick);
    el.cancel.addEventListener('click', () => handlers.onCancel());

    el.menuToggle.addEventListener('click', () => (el.dropdown.hidden ? openMenu() : closeMenu()));
    el.dropdown.addEventListener('click', onMenuAction);
    document.addEventListener('click', (e) => {
      if (!el.userMenu.contains(e.target)) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });
  }

  window.Daily = window.Daily || {};
  window.Daily.auth = { init, getActiveProfile, showLogin, setUser, fillAvatar, renderProfileList };
})();

/**
 * Точка входу застосунку: ініціалізація Supabase, Realtime-підписки,
 * обробка помилок мережі та перемикання між екраном входу, календарем, відділами, стрічкою і рейтингом.
 */
(function () {
  const { db, auth, calendar, logs, leaderboard } = window.Daily;

  const views = {};
  let tabsNav = null;
  let banner = null;
  let bannerText = null;
  let statusEl = null;
  let currentProfile = null;
  let currentTab = 'calendar';

  function notifyError(message) {
    if (!banner || !message) return;
    bannerText.textContent = message;
    banner.hidden = false;
  }

  function clearError() {
    if (!banner) return;
    banner.hidden = true;
    bannerText.textContent = '';
  }

  function showView(name) {
    for (const [key, view] of Object.entries(views)) {
      view.hidden = key !== name;
    }
  }

  function renderTabs() {
    if (!tabsNav) return;
    tabsNav.replaceChildren();

    const calBtn = document.createElement('button');
    calBtn.type = 'button';
    calBtn.className = 'section-tab';
    calBtn.dataset.tab = 'calendar';
    calBtn.textContent = 'Календар';
    tabsNav.append(calBtn);

    for (const cat of logs.getCategories()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'section-tab';
      btn.dataset.tab = cat.id;

      const emoji = document.createElement('span');
      emoji.className = 'tab-emoji';
      emoji.setAttribute('aria-hidden', 'true');
      emoji.textContent = cat.icon;

      const label = document.createElement('span');
      label.textContent = cat.title;

      btn.append(emoji, label);
      tabsNav.append(btn);
    }

    const feedBtn = document.createElement('button');
    feedBtn.type = 'button';
    feedBtn.className = 'section-tab';
    feedBtn.dataset.tab = 'feed';
    feedBtn.textContent = 'Стрічка';
    tabsNav.append(feedBtn);

    const leaderBtn = document.createElement('button');
    leaderBtn.type = 'button';
    leaderBtn.className = 'section-tab';
    leaderBtn.dataset.tab = 'leaderboard';
    leaderBtn.textContent = 'Рейтинг';
    tabsNav.append(leaderBtn);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'section-tab section-tab--add';
    addBtn.id = 'add-category-btn';
    addBtn.dataset.action = 'add-category';
    addBtn.textContent = '+ Новий відділ';
    tabsNav.append(addBtn);

    updateActiveTabButton();
  }

  function updateActiveTabButton() {
    for (const btn of tabsNav.querySelectorAll('[data-tab]')) {
      const active = btn.dataset.tab === currentTab;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    }
  }

  function selectTab(tab) {
    currentTab = tab;
    updateActiveTabButton();

    if (tab === 'calendar') {
      showView('calendar');
    } else if (tab === 'feed') {
      logs.showFeed();
      showView('feed');
    } else if (tab === 'leaderboard') {
      leaderboard.show();
      showView('leaderboard');
    } else {
      logs.showCategory(tab);
      showView('tracker');
    }
  }

  function enter(profile) {
    clearError();
    currentProfile = profile;
    auth.setUser(profile);
    tabsNav.hidden = false;
    renderTabs();
    calendar.show(profile);
    logs.setProfile(profile);
    leaderboard.setProfile(profile);
    selectTab(currentTab || 'calendar');
  }

  async function openLogin({ cancellable = false } = {}) {
    auth.setUser(null);
    tabsNav.hidden = true;
    showView('auth');
    await auth.showLogin({ cancellable });
  }

  function initRealtime() {
    db.subscribeRealtime({
      onLogsChange: () => {
        if (currentProfile) {
          logs.reloadFromRealtime();
          leaderboard.reloadFromRealtime();
        }
      },
      onDayMarksChange: () => {
        if (currentProfile) {
          calendar.reload();
          leaderboard.reloadFromRealtime();
        }
      },
      onProfilesChange: () => {
        if (currentProfile) {
          logs.reloadFromRealtime();
          leaderboard.reloadFromRealtime();
        } else {
          auth.renderProfileList();
        }
      },
      onStatus: (status) => {
        if (!statusEl) return;
        if (status === 'SUBSCRIBED') {
          statusEl.textContent = 'Онлайн (Realtime підключено)';
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          statusEl.textContent = 'Помилка Realtime-зʼєднання';
        }
      },
    });
  }

  async function start() {
    statusEl = document.getElementById('status');
    tabsNav = document.getElementById('section-tabs');
    banner = document.getElementById('network-banner');
    bannerText = document.getElementById('network-banner-text');

    views.auth = document.getElementById('auth-view');
    views.calendar = document.getElementById('calendar-view');
    views.tracker = document.getElementById('tracker-view');
    views.feed = document.getElementById('feed-view');
    views.leaderboard = document.getElementById('leaderboard-view');

    document.getElementById('network-banner-close')?.addEventListener('click', clearError);
    window.addEventListener('offline', () =>
      notifyError('Відсутнє підключення до інтернету. Перевірте мережу.')
    );
    window.addEventListener('online', () => {
      clearError();
      if (currentProfile) {
        calendar.reload();
        logs.reloadFromRealtime();
        leaderboard.reloadFromRealtime();
      }
    });

    tabsNav.addEventListener('click', (e) => {
      if (!currentProfile) return;
      const addBtn = e.target.closest('[data-action="add-category"]');
      if (addBtn) {
        logs.openNewCategoryModal();
        return;
      }
      const btn = e.target.closest('[data-tab]');
      if (btn) selectTab(btn.dataset.tab);
    });

    auth.init({
      onLogin: (p) => {
        currentTab = 'calendar';
        enter(p);
      },
      onCancel: () => currentProfile && enter(currentProfile),
      onSwitch: () => openLogin({ cancellable: true }),
      onLogout: () => {
        currentProfile = null;
        currentTab = 'calendar';
        calendar.hide();
        logs.hide();
        leaderboard.hide();
        openLogin();
      },
    });
    calendar.init();
    logs.init({
      onCategoriesChange: (nextTab) => {
        renderTabs();
        if (nextTab) selectTab(nextTab);
      },
    });
    leaderboard.init();

    if (!db.isConfigured()) {
      notifyError('Щоб почати роботу з базою, вставте ваші SUPABASE_URL та SUPABASE_ANON_KEY у файл js/config.js.');
      statusEl.textContent = 'Очікування налаштування js/config.js';
      await openLogin();
      return;
    }

    try {
      await db.open();
      initRealtime();

      const profile = await auth.getActiveProfile();
      if (profile) {
        enter(profile);
      } else {
        await openLogin();
      }

      statusEl.textContent = 'Готово';
    } catch (err) {
      const msg = db.formatError(err);
      notifyError(msg);
      statusEl.textContent = 'Помилка підключення';
      await openLogin();
    }
  }

  window.Daily = window.Daily || {};
  window.Daily.notifyError = notifyError;
  window.Daily.clearError = clearError;

  document.addEventListener('DOMContentLoaded', start);
})();

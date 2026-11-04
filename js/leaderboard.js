/**
 * Вкладка "Рейтинг" (лідерборд усіх профілів):
 *  - +10 очок за кожен відмічений день (done або настрій)
 *  - +2 очки за кожен запис у відділах (максимум 10 записів на день на один профіль)
 *  - +5 очок бонус за кожен день у поточній серії днів підряд 🔥
 *  - Періоди: "Тиждень", "Місяць", "Весь час"
 *  - Топ-3 окремими великими картками (🥇🥈🥉), решта — списком
 *  - Титули відділів: "Головний ненажера" (Їжа) та "Король трону" (Туалет)
 */
(function () {
  const { db, auth } = window.Daily;

  const POINTS_PER_DAY = 10;
  const POINTS_PER_LOG = 2;
  const MAX_LOGS_PER_DAY = 10;
  const POINTS_PER_STREAK_DAY = 5;

  const MEDALS = ['🥇', '🥈', '🥉'];

  const el = {};

  let currentProfile = null;
  let period = 'all'; // 'week' | 'month' | 'all'
  let profiles = [];
  let dayMarks = [];
  let logs = [];
  let loadToken = 0;
  let isLoading = false;

  /* ---------- Дати ---------- */

  const pad = (n) => String(n).padStart(2, '0');

  function dateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function today() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function shiftDateKey(key, deltaDays) {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + deltaDays);
    return dateKey(dt);
  }

  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function isDateInPeriod(dateStr, selectedPeriod) {
    if (!dateStr) return false;
    if (selectedPeriod === 'all') return true;

    const tKey = dateKey(today());
    if (selectedPeriod === 'month') {
      return dateStr.slice(0, 7) === tKey.slice(0, 7);
    }
    if (selectedPeriod === 'week') {
      const weekStart = shiftDateKey(tKey, -6);
      return dateStr >= weekStart && dateStr <= tKey;
    }
    return true;
  }

  /* ---------- Підрахунок очок і титулів ---------- */

  function isMarked(mark) {
    return !!mark && (mark.done || !!mark.mood);
  }

  /** Поточна серія днів підряд із відміткою для одного профілю. */
  function calcStreak(markedDatesSet) {
    const d = today();
    if (!markedDatesSet.has(dateKey(d))) {
      d.setDate(d.getDate() - 1);
    }
    let count = 0;
    while (markedDatesSet.has(dateKey(d))) {
      count++;
      d.setDate(d.getDate() - 1);
    }
    return count;
  }

  function computeStandings() {
    const allMarkedByProfile = new Map(); // profileIdStr -> Set<date>
    const periodMarkedByProfile = new Map(); // profileIdStr -> Set<date>
    const periodLogsByProfileDate = new Map(); // profileIdStr -> Map<date, count>
    const foodCountByProfile = new Map(); // profileIdStr -> count
    const toiletCountByProfile = new Map(); // profileIdStr -> count

    for (const p of profiles) {
      const pid = String(p.id);
      allMarkedByProfile.set(pid, new Set());
      periodMarkedByProfile.set(pid, new Set());
      periodLogsByProfileDate.set(pid, new Map());
      foodCountByProfile.set(pid, 0);
      toiletCountByProfile.set(pid, 0);
    }

    for (const mark of dayMarks) {
      if (!isMarked(mark) || !mark.date) continue;
      const pid = String(mark.profile_id);
      if (!allMarkedByProfile.has(pid)) {
        allMarkedByProfile.set(pid, new Set());
        periodMarkedByProfile.set(pid, new Set());
      }
      allMarkedByProfile.get(pid).add(mark.date);
      if (isDateInPeriod(mark.date, period)) {
        periodMarkedByProfile.get(pid).add(mark.date);
      }
    }

    for (const log of logs) {
      if (!log.date || !isDateInPeriod(log.date, period)) continue;
      const pid = String(log.profile_id);
      if (!periodLogsByProfileDate.has(pid)) {
        periodLogsByProfileDate.set(pid, new Map());
      }
      const dateMap = periodLogsByProfileDate.get(pid);
      dateMap.set(log.date, (dateMap.get(log.date) || 0) + 1);

      if (log.category === 'food') {
        foodCountByProfile.set(pid, (foodCountByProfile.get(pid) || 0) + 1);
      } else if (log.category === 'toilet') {
        toiletCountByProfile.set(pid, (toiletCountByProfile.get(pid) || 0) + 1);
      }
    }

    const rows = profiles.map((p) => {
      const pid = String(p.id);
      const streak = calcStreak(allMarkedByProfile.get(pid) || new Set());
      const markedDays = (periodMarkedByProfile.get(pid) || new Set()).size;

      let cappedLogs = 0;
      const dateMap = periodLogsByProfileDate.get(pid);
      if (dateMap) {
        for (const countOnDay of dateMap.values()) {
          cappedLogs += Math.min(countOnDay, MAX_LOGS_PER_DAY);
        }
      }

      const dayPoints = markedDays * POINTS_PER_DAY;
      const logPoints = cappedLogs * POINTS_PER_LOG;
      const streakPoints = streak * POINTS_PER_STREAK_DAY;
      const totalPoints = dayPoints + logPoints + streakPoints;

      return {
        profile: p,
        streak,
        markedDays,
        cappedLogs,
        totalPoints,
        foodCount: foodCountByProfile.get(pid) || 0,
        toiletCount: toiletCountByProfile.get(pid) || 0,
      };
    });

    rows.sort(
      (a, b) =>
        b.totalPoints - a.totalPoints ||
        b.streak - a.streak ||
        b.markedDays - a.markedDays ||
        a.profile.name.localeCompare(b.profile.name, 'uk')
    );

    rows.forEach((r, idx) => {
      r.rank = idx + 1;
    });

    const topFood = [...rows]
      .filter((r) => r.foodCount > 0)
      .sort((a, b) => b.foodCount - a.foodCount || b.totalPoints - a.totalPoints)[0] || null;

    const topToilet = [...rows]
      .filter((r) => r.toiletCount > 0)
      .sort((a, b) => b.toiletCount - a.toiletCount || b.totalPoints - a.totalPoints)[0] || null;

    return { rows, topFood, topToilet };
  }

  /* ---------- Завантаження з Supabase ---------- */

  function renderSkeletons() {
    el.podium.replaceChildren();
    el.list.replaceChildren();
    el.empty.hidden = true;
    for (let i = 0; i < 3; i++) {
      const sk = document.createElement('div');
      sk.className = 'skeleton skeleton-podium';
      el.podium.append(sk);
    }
  }

  async function loadData({ showSkeleton = false } = {}) {
    if (!currentProfile) return false;
    const token = ++loadToken;
    isLoading = true;

    if (showSkeleton) renderSkeletons();

    try {
      const [profilesList, marksList, logsList] = await Promise.all([
        db.listProfiles(),
        db.getAllDayMarks(),
        db.getAllLogs(),
      ]);
      if (token !== loadToken) return false;
      profiles = profilesList;
      dayMarks = marksList;
      logs = logsList;
      return true;
    } finally {
      if (token === loadToken) isLoading = false;
    }
  }

  /* ---------- Рендер ---------- */

  function render() {
    if (!currentProfile) return;

    for (const btn of el.periods.querySelectorAll('[data-period]')) {
      const active = btn.dataset.period === period;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }

    if (isLoading && profiles.length === 0) return;

    const { rows, topFood, topToilet } = computeStandings();

    renderTitles(topFood, topToilet);

    el.podium.replaceChildren();
    el.list.replaceChildren();
    el.empty.hidden = rows.length > 0;

    if (!rows.length) return;

    const top3 = rows.slice(0, 3);
    const rest = rows.slice(3);

    for (const item of top3) {
      el.podium.append(createPodiumCard(item));
    }

    for (const item of rest) {
      el.list.append(createLeaderRow(item));
    }
  }

  function renderTitles(topFood, topToilet) {
    el.titles.replaceChildren();

    const cards = [
      {
        icon: '🍽',
        title: 'Головний ненажера',
        subtitle: 'Найбільше записів у «Їжа»',
        winner: topFood,
        count: topFood?.foodCount || 0,
      },
      {
        icon: '💩',
        title: 'Король трону',
        subtitle: 'Найбільше записів у «Туалет»',
        winner: topToilet,
        count: topToilet?.toiletCount || 0,
      },
    ];

    for (const c of cards) {
      const card = document.createElement('div');
      card.className = 'title-card';
      if (c.winner && String(c.winner.profile.id) === String(currentProfile?.id)) {
        card.classList.add('is-me');
      }

      const head = document.createElement('div');
      head.className = 'title-card-head';

      const icon = document.createElement('span');
      icon.className = 'title-card-icon';
      icon.textContent = c.icon;

      const meta = document.createElement('div');
      const h3 = document.createElement('h3');
      h3.className = 'title-card-name';
      h3.textContent = c.title;
      const sub = document.createElement('p');
      sub.className = 'title-card-sub';
      sub.textContent = c.subtitle;
      meta.append(h3, sub);

      head.append(icon, meta);
      card.append(head);

      const body = document.createElement('div');
      body.className = 'title-card-body';

      if (c.winner) {
        const av = document.createElement('span');
        av.className = 'avatar avatar--sm';
        auth.fillAvatar(av, c.winner.profile);

        const winnerName = document.createElement('span');
        winnerName.className = 'title-card-winner';
        winnerName.textContent = c.winner.profile.name;

        const badge = document.createElement('span');
        badge.className = 'title-card-count';
        badge.textContent = `${c.count} ${plural(c.count, 'запис', 'записи', 'записів')}`;

        body.append(av, winnerName, badge);
      } else {
        const none = document.createElement('span');
        none.className = 'title-card-empty';
        none.textContent = 'Поки що нікого';
        body.append(none);
      }

      card.append(body);
      el.titles.append(card);
    }
  }

  function createPodiumCard(item) {
    const isMe = String(item.profile.id) === String(currentProfile?.id);
    const isFirst = item.rank === 1;

    const card = document.createElement('article');
    card.className = 'podium-card';
    card.dataset.rank = String(item.rank);
    card.dataset.profileId = String(item.profile.id);
    if (isFirst) card.classList.add('podium-card--first');
    if (isMe) card.classList.add('is-me');

    const top = document.createElement('div');
    top.className = 'podium-top';

    const medal = document.createElement('span');
    medal.className = 'podium-medal';
    medal.textContent = MEDALS[item.rank - 1] || `#${item.rank}`;

    const rankLabel = document.createElement('span');
    rankLabel.className = 'podium-rank';
    rankLabel.textContent = `${item.rank} місце`;

    top.append(medal, rankLabel);
    if (isMe) {
      const meBadge = document.createElement('span');
      meBadge.className = 'leader-me-badge';
      meBadge.textContent = 'Ви';
      top.append(meBadge);
    }

    const av = document.createElement('span');
    av.className = 'avatar avatar--md podium-avatar';
    auth.fillAvatar(av, item.profile);

    const name = document.createElement('div');
    name.className = 'podium-name';
    name.textContent = item.profile.name;

    const stats = document.createElement('div');
    stats.className = 'podium-stats';

    const points = document.createElement('span');
    points.className = 'podium-points';
    points.textContent = `${item.totalPoints} ${plural(item.totalPoints, 'очко', 'очки', 'очок')}`;

    const streak = document.createElement('span');
    streak.className = 'podium-streak';
    streak.textContent = `${item.streak} 🔥`;

    stats.append(points, streak);
    card.append(top, av, name, stats);
    return card;
  }

  function createLeaderRow(item) {
    const isMe = String(item.profile.id) === String(currentProfile?.id);

    const row = document.createElement('div');
    row.className = 'leader-row';
    row.dataset.rank = String(item.rank);
    row.dataset.profileId = String(item.profile.id);
    if (isMe) row.classList.add('is-me');

    const rank = document.createElement('span');
    rank.className = 'leader-rank';
    rank.textContent = `#${item.rank}`;

    const av = document.createElement('span');
    av.className = 'avatar avatar--sm';
    auth.fillAvatar(av, item.profile);

    const nameWrap = document.createElement('div');
    nameWrap.className = 'leader-name-wrap';

    const name = document.createElement('span');
    name.className = 'leader-name';
    name.textContent = item.profile.name;
    nameWrap.append(name);

    if (isMe) {
      const meBadge = document.createElement('span');
      meBadge.className = 'leader-me-badge';
      meBadge.textContent = 'Ви';
      nameWrap.append(meBadge);
    }

    const streak = document.createElement('span');
    streak.className = 'leader-streak';
    streak.textContent = `${item.streak} 🔥`;

    const points = document.createElement('span');
    points.className = 'leader-points';
    points.textContent = `${item.totalPoints} ${plural(item.totalPoints, 'очко', 'очки', 'очок')}`;

    row.append(rank, av, nameWrap, streak, points);
    return row;
  }

  /* ---------- Публічне API ---------- */

  function init() {
    const $ = (id) => document.getElementById(id);

    el.periods = $('leaderboard-periods');
    el.titles = $('leaderboard-titles');
    el.podium = $('leaderboard-podium');
    el.list = $('leaderboard-list');
    el.empty = $('leaderboard-empty');

    el.periods.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-period]');
      if (!btn) return;
      period = btn.dataset.period;
      render();
    });
  }

  async function setProfile(profile) {
    currentProfile = profile;
    period = 'all';
    try {
      if (await loadData({ showSkeleton: true })) {
        render();
      }
    } catch (err) {
      window.Daily.notifyError?.(db.formatError(err));
    }
  }

  async function show() {
    render();
    try {
      if (await loadData({ showSkeleton: profiles.length === 0 })) {
        render();
      }
    } catch (err) {
      window.Daily.notifyError?.(db.formatError(err));
    }
  }

  async function reloadFromRealtime() {
    if (!currentProfile) return;
    try {
      if (await loadData({ showSkeleton: false })) {
        render();
      }
    } catch (err) {
      window.Daily.notifyError?.(db.formatError(err));
    }
  }

  function hide() {
    loadToken++;
    currentProfile = null;
    profiles = [];
    dayMarks = [];
    logs = [];
    el.podium.replaceChildren();
    el.list.replaceChildren();
    el.titles.replaceChildren();
  }

  window.Daily = window.Daily || {};
  window.Daily.leaderboard = { init, setProfile, show, reloadFromRealtime, hide };
})();

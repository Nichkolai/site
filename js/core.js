/* =========================================================
   KAZ — core: state, navigation, shared UI
   ========================================================= */
(() => {
  "use strict";

  const STORAGE_KEY = "kaz_ui_v2";
  const DEFAULT_BET = 50;
  const DAILY_BONUS = 10;
  const MIN_WITHDRAW = 500;
  const MIN_TOPUP = 1;
  const MAX_TOPUP = 1000000;
  const DEFAULT_TOPUP = 500;
  // ShuzaGram bot links use sgq.me; t.me links open the wrong client.
  const BOT_LINK = "https://sgq.me/kazbot";
  const MAX_HISTORY = 100;

  const GAME_VIEWS = new Set(["slots", "blackjack", "roulette", "mines", "crash", "upgrader"]);

  const VIEW_TITLES = {
    lobby: "Игры",
    slots: "Слоты",
    blackjack: "Блэкджек",
    roulette: "Рулетка",
    mines: "Мины",
    crash: "Краш",
    upgrader: "Апгрейд",
    history: "История"
  };

  const GAME_META = {
    slots: { label: "Слоты", icon: "#i-slots" },
    blackjack: { label: "Блэкджек", icon: "#i-cards" },
    roulette: { label: "Рулетка", icon: "#i-wheel" },
    mines: { label: "Мины", icon: "#i-bomb" },
    crash: { label: "Краш", icon: "#i-rocket" },
    upgrader: { label: "Апгрейд", icon: "#i-up" }
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const pad = (value) => String(value).padStart(2, "0");

  function todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function createDefaultState() {
    return {
      balance: 0,
      games: 0,
      wagered: 0,
      biggestWin: 0,
      history: [],
      withdrawals: [],
      purchases: [],
      lastDaily: null,
      active: {},
      loaded: false,
      sound: true
    };
  }

  function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  // The balance, history and rounds live on the server. The browser keeps
  // only the sound setting and the last known balance (shown until the
  // server answers).
  function loadState() {
    const fresh = createDefaultState();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return fresh;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") return fresh;
      fresh.sound = saved.sound !== false;
      fresh.balance = Math.max(0, Math.round(safeNumber(saved.balance)));
      return fresh;
    } catch (error) {
      return fresh;
    }
  }

  let state = loadState();
  let currentView = "lobby";
  let lastFocused = null;
  let audioContext = null;
  let telegram = null;
  let suspendHash = false;
  let dailyTimer = 0;
  let withdrawLocked = false;

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        sound: state.sound,
        balance: state.balance
      }));
    } catch (error) {
      /* localStorage can be unavailable in private mode. */
    }
  }

  function formatStars(value) {
    return Math.round(safeNumber(value)).toLocaleString("ru-RU");
  }

  function formatSigned(value) {
    const number = Math.round(safeNumber(value));
    if (number > 0) return `+${formatStars(number)}`;
    if (number < 0) return `−${formatStars(Math.abs(number))}`;
    return "0";
  }

  function plural(count, one, few, many) {
    const abs = Math.abs(count) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return many;
    if (last > 1 && last < 5) return few;
    if (last === 1) return one;
    return many;
  }

  function randomInt(max) {
    const limit = Math.max(1, Math.floor(max));
    try {
      const buffer = new Uint32Array(1);
      crypto.getRandomValues(buffer);
      return buffer[0] % limit;
    } catch (error) {
      return Math.floor(Math.random() * limit);
    }
  }

  function randomFloat() {
    try {
      const buffer = new Uint32Array(1);
      crypto.getRandomValues(buffer);
      return buffer[0] / 4294967296;
    } catch (error) {
      return Math.random();
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function iconMarkup(id) {
    return `<svg class="icon" aria-hidden="true"><use href="${id}"></use></svg>`;
  }

  function renderBalance(animate = false) {
    $$('[data-bind="balance"]').forEach((element) => {
      element.textContent = formatStars(state.balance);
      if (animate) {
        element.classList.remove("bump");
        void element.offsetWidth;
        element.classList.add("bump");
      }
    });
  }

  function renderStats() {
    $$('[data-bind="games"]').forEach((element) => {
      element.textContent = formatStars(state.games);
    });
    $$('[data-bind="wagered"]').forEach((element) => {
      element.textContent = formatStars(state.wagered);
    });
    $$('[data-bind="bestWin"]').forEach((element) => {
      element.textContent = formatStars(state.biggestWin);
    });
  }

  function setBalance(value, options = {}) {
    state.balance = Math.max(0, Math.round(safeNumber(value)));
    saveState();
    renderBalance(options.animate !== false);
  }

  function adjustBalance(delta, options = {}) {
    setBalance(state.balance + safeNumber(delta), options);
  }

  function relativeTime(timestamp) {
    const now = Date.now();
    const diff = Math.max(0, now - timestamp);
    if (diff < 45_000) return "только что";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`;
    if (diff < 21_600_000) return `${Math.floor(diff / 3_600_000)} ч назад`;

    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

    if (date.toDateString() === today.toDateString()) return `сегодня, ${time}`;
    if (date.toDateString() === yesterday.toDateString()) return `вчера, ${time}`;
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  }

  function historyDate(timestamp) {
    return new Date(timestamp).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function createHistoryNode(entry, full = false) {
    const meta = GAME_META[entry.game];
    const deltaClass = entry.delta > 0 ? "win" : entry.delta < 0 ? "loss" : "push";
    const row = document.createElement("div");

    if (full) {
      row.className = "history-row";
      row.innerHTML = `
        <span class="recent-icon ${entry.game}">${iconMarkup(meta.icon)}</span>
        <div class="history-title">
          <strong>${escapeHtml(entry.title)}</strong>
          <span>${escapeHtml(entry.detail)}</span>
          <small>${escapeHtml(historyDate(entry.at))}${entry.wager ? ` · ставка ${formatStars(entry.wager)} ★` : ""}</small>
        </div>
        <span class="history-delta ${deltaClass}">${formatSigned(entry.delta)}</span>
      `;
    } else {
      row.className = "recent-item";
      row.innerHTML = `
        <span class="recent-icon ${entry.game}">${iconMarkup(meta.icon)}</span>
        <div class="recent-main">
          <strong>${escapeHtml(entry.title)}</strong>
          <span>${escapeHtml(entry.detail)}</span>
        </div>
        <span class="recent-delta ${deltaClass}">${formatSigned(entry.delta)}</span>
      `;
      row.title = `${relativeTime(entry.at)} · ставка ${formatStars(entry.wager)} ★`;
    }
    return row;
  }

  function renderHistory() {
    const recent = document.getElementById("recentGames");
    if (recent) {
      recent.replaceChildren();
      if (!state.history.length) {
        const empty = document.createElement("p");
        empty.className = "empty-inline";
        empty.textContent = "Пока пусто. Сыграйте первый раунд.";
        recent.append(empty);
      } else {
        state.history.slice(0, 3).forEach((entry) => recent.append(createHistoryNode(entry, false)));
      }
    }

    const list = document.getElementById("historyList");
    if (list) {
      list.replaceChildren();
      if (!state.history.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.innerHTML = `
          <span>${iconMarkup("#i-history")}</span>
          <strong>История пока пуста</strong>
          <p>Сыграйте в любую игру — результаты сохранятся на этом устройстве.</p>
          <a class="btn btn-soft" href="#slots" data-nav="slots">Начать играть ${iconMarkup("#i-arrow")}</a>
        `;
        list.append(empty);
      } else {
        state.history.forEach((entry) => list.append(createHistoryNode(entry, true)));
      }
    }

    const count = document.getElementById("historyCount");
    if (count) {
      count.textContent = `${state.history.length} ${plural(state.history.length, "запись", "записи", "записей")}`;
    }

    renderWithdrawals();
  }

  const WITHDRAW_STATUS = {
    pending: "На проверке",
    paid: "Выплачено",
    rejected: "Отклонена"
  };

  function renderWithdrawals() {
    const list = document.getElementById("withdrawHistoryList");
    if (!list) return;

    list.replaceChildren();
    const count = document.getElementById("withdrawHistoryCount");
    if (count) {
      count.textContent = `${state.withdrawals.length} ${plural(
        state.withdrawals.length,
        "заявка",
        "заявки",
        "заявок"
      )}`;
    }

    if (!state.withdrawals.length) {
      const empty = document.createElement("p");
      empty.className = "empty-inline";
      empty.textContent = "Заявок пока нет. Вывести звёзды можно из кошелька.";
      list.append(empty);
      return;
    }

    state.withdrawals.slice(0, 5).forEach((request) => {
      const row = document.createElement("div");
      const contact = request.contact ? ` · ${request.contact}` : "";
      row.className = "history-row";
      row.innerHTML = `
        <span class="recent-icon withdraw">${iconMarkup("#i-star")}</span>
        <div class="history-title">
          <strong>Вывод ${formatStars(request.amount)} ★</strong>
          <span>Заявка ${escapeHtml(request.id)}</span>
          <small>${escapeHtml(historyDate(request.at))}${escapeHtml(contact)}</small>
        </div>
        <span class="withdraw-status">${escapeHtml(WITHDRAW_STATUS[request.status] || "На проверке")}</span>
      `;
      list.append(row);
    });
  }

  function renderPurchases() {
    const list = document.getElementById("purchaseHistoryList");
    if (!list) return;

    list.replaceChildren();
    const count = document.getElementById("purchaseHistoryCount");
    if (count) {
      count.textContent = `${state.purchases.length} ${plural(
        state.purchases.length,
        "пополнение",
        "пополнения",
        "пополнений"
      )}`;
    }

    if (!state.purchases.length) {
      const empty = document.createElement("p");
      empty.className = "empty-inline";
      empty.textContent = "Пополнений пока нет. Баланс можно пополнить за ShuzaGram Stars.";
      list.append(empty);
      return;
    }

    state.purchases.slice(0, 5).forEach((purchase) => {
      const row = document.createElement("div");
      row.className = "history-row";
      row.innerHTML = `
        <span class="recent-icon topup">${iconMarkup("#i-plus")}</span>
        <div class="history-title">
          <strong>Пополнение +${formatStars(purchase.amount)} ★</strong>
          <span>ShuzaGram Stars · 1 ★ = 1 Star</span>
          <small>${escapeHtml(historyDate(purchase.at))}</small>
        </div>
        <span class="withdraw-status credited">Зачислено</span>
      `;
      list.append(row);
    });
  }

  // History and statistics are written by the server together with the
  // result of the round; the app only displays them (see applyState).
  function recordResult() {}

  const DAY_MS = 86_400_000;
  const MSK_MS = 3 * 3_600_000;

  function mskDay() {
    return new Date(Date.now() + MSK_MS).toISOString().slice(0, 10);
  }

  function msUntilNextDay() {
    return DAY_MS - ((Date.now() + MSK_MS) % DAY_MS);
  }

  function timeUntilTomorrow() {
    const minutes = Math.max(0, Math.ceil(msUntilNextDay() / 60_000));
    if (minutes < 60) return `через ${minutes} мин`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `через ${hours} ч ${rest} мин` : `через ${hours} ч`;
  }

  function updateDailyUI() {
    const claimed = state.lastDaily === mskDay();
    const heroLabel = $("#heroBonusBtn span");
    if (heroLabel) heroLabel.textContent = claimed ? "Бонус получен" : "Забрать 10 звёзд";

    const claimButton = document.getElementById("claimBonusBtn");
    if (claimButton) {
      claimButton.disabled = claimed;
      claimButton.textContent = claimed ? "Уже получено" : "Забрать бонус";
    }
    const footnote = document.getElementById("bonusFootnote");
    if (footnote) {
      footnote.textContent = claimed
        ? `Следующий бонус ${timeUntilTomorrow()}`
        : "Доступно сегодня · начисляется мгновенно";
    }
  }

  function scheduleDailyRefresh() {
    window.clearTimeout(dailyTimer);
    const delay = Math.max(1_000, msUntilNextDay() + 1_000);
    dailyTimer = window.setTimeout(() => {
      updateDailyUI();
      scheduleDailyRefresh();
    }, delay);
  }

  function renderAll() {
    renderBalance(false);
    renderStats();
    renderHistory();
    renderPurchases();
    updateDailyUI();
  }

  /* ---------- Toasts ---------- */
  function toast(title, message = "", type = "success") {
    const stack = document.getElementById("toastStack");
    if (!stack) return;
    while (stack.children.length >= 3) stack.firstElementChild.remove();

    const icon = type === "error" ? "#i-shield" : type === "info" ? "#i-bolt" : "#i-spark";
    const element = document.createElement("div");
    element.className = `toast ${type}`;
    element.innerHTML = `
      <span class="toast-icon">${iconMarkup(icon)}</span>
      <div><strong>${escapeHtml(title)}</strong>${message ? `<p>${escapeHtml(message)}</p>` : ""}</div>
    `;
    stack.append(element);
    window.setTimeout(() => {
      element.classList.add("out");
      window.setTimeout(() => element.remove(), 260);
    }, 3600);
  }

  /* ---------- Telegram ---------- */
  function attachTelegram() {
    if (telegram) return;
    const webApp = window.Telegram && window.Telegram.WebApp;
    if (!webApp) return;
    telegram = webApp;
    try {
      webApp.ready();
      webApp.expand();
      if (typeof webApp.setHeaderColor === "function") webApp.setHeaderColor("#07110b");
      if (typeof webApp.setBackgroundColor === "function") webApp.setBackgroundColor("#07110b");
      if (typeof webApp.disableVerticalSwipes === "function") webApp.disableVerticalSwipes();
    } catch (error) {
      /* Older Telegram clients. */
    }
    try {
      if (webApp.BackButton) {
        webApp.BackButton.onClick(() => navigate("lobby"));
      }
    } catch (error) {
      /* BackButton is optional. */
    }
    syncTelegramBack();
    refreshState(true);
  }

  function prepareTelegram() {
    if (window.Telegram && window.Telegram.WebApp) {
      attachTelegram();
      return;
    }

    const likelyTelegram = Boolean(
      window.TelegramWebviewProxy || location.hash.includes("tgWebApp")
    );
    if (!likelyTelegram) return;

    // Telegram passes init data in the URL hash. Keep it intact until the
    // official SDK has read it, otherwise the Mini App loses its session.
    suspendHash = true;
    let settled = false;

    const finish = () => {
      if (!settled) {
        settled = true;
        suspendHash = false;
        window.history.replaceState({ view: currentView }, "", `#${currentView}`);
      }
      attachTelegram();
    };

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-web-app.js";
    script.async = true;
    script.onload = finish;
    script.onerror = finish;
    document.head.append(script);
    window.setTimeout(finish, 3000);
  }

  function syncTelegramBack() {
    if (!telegram || !telegram.BackButton) return;
    try {
      if (GAME_VIEWS.has(currentView)) telegram.BackButton.show();
      else telegram.BackButton.hide();
    } catch (error) {
      /* Ignore older clients. */
    }
  }

  function haptic(style = "light") {
    if (!telegram || !telegram.HapticFeedback) return;
    try {
      const feedback = telegram.HapticFeedback;
      if (style === "success" || style === "error" || style === "warning") {
        feedback.notificationOccurred(style);
      } else {
        feedback.impactOccurred(style);
      }
    } catch (error) {
      /* Haptics are optional. */
    }
  }

  /* ---------- Sound ---------- */
  function ensureAudio() {
    if (audioContext) return audioContext;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    audioContext = new AudioCtor();
    return audioContext;
  }

  function tone(frequency, start, duration, volume = 0.035, type = "triangle") {
    const context = ensureAudio();
    if (!context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, context.currentTime + start);
    gain.gain.setValueAtTime(0.0001, context.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(volume, context.currentTime + start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + start + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(context.currentTime + start);
    oscillator.stop(context.currentTime + start + duration + 0.02);
  }

  function sound(name) {
    if (!state.sound) return;
    try {
      const context = ensureAudio();
      if (!context) return;
      if (context.state === "suspended") context.resume();

      switch (name) {
        case "click":
          tone(560, 0.01, 0.04, 0.025, "sine");
          break;
        case "spin":
          tone(240, 0.01, 0.08, 0.028);
          tone(330, 0.09, 0.08, 0.028);
          tone(430, 0.17, 0.12, 0.025);
          break;
        case "stop":
          tone(520, 0.01, 0.045, 0.022, "square");
          break;
        case "win":
          tone(523, 0.02, 0.16, 0.03);
          tone(659, 0.09, 0.18, 0.03);
          tone(784, 0.17, 0.24, 0.03);
          break;
        case "bigwin":
          [523, 659, 784, 1046, 1318].forEach((frequency, index) => {
            tone(frequency, 0.02 + index * 0.075, 0.22, 0.033);
          });
          break;
        case "lose":
          tone(235, 0.02, 0.15, 0.025, "sine");
          tone(185, 0.12, 0.2, 0.022, "sine");
          break;
        case "push":
          tone(440, 0.02, 0.12, 0.026, "sine");
          tone(440, 0.15, 0.12, 0.02, "sine");
          break;
        case "cash":
          tone(880, 0.01, 0.1, 0.028, "sine");
          tone(1175, 0.09, 0.16, 0.026, "sine");
          break;
        case "card":
          tone(330, 0.01, 0.035, 0.018, "square");
          break;
        case "roulette":
          for (let index = 0; index < 7; index += 1) {
            tone(180 + index * 22, 0.01 + index * 0.055, 0.035, 0.018, "square");
          }
          break;
        default:
          tone(500, 0.01, 0.04, 0.02, "sine");
      }
    } catch (error) {
      /* Audio is optional. */
    }
  }

  function syncSoundButton() {
    const button = document.getElementById("soundBtn");
    if (!button) return;
    button.classList.toggle("muted", !state.sound);
    button.setAttribute("aria-label", state.sound ? "Выключить звук" : "Включить звук");
    button.title = state.sound ? "Звук включён" : "Звук выключен";
  }

  /* ---------- Confetti ---------- */
  function confetti(count = 55) {
    const layer = document.getElementById("confettiLayer");
    if (!layer) return;
    layer.replaceChildren();
    const colors = ["#c8f169", "#58d99a", "#e9c46a", "#eef7ef"];

    for (let index = 0; index < count; index += 1) {
      const piece = document.createElement("i");
      piece.className = "confetti";
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = colors[randomInt(colors.length)];
      piece.style.setProperty("--dur", `${1.6 + Math.random() * 1.8}s`);
      piece.style.setProperty("--drift", `${-80 + Math.random() * 160}px`);
      piece.style.animationDelay = `${Math.random() * 0.35}s`;
      piece.style.opacity = `${0.65 + Math.random() * 0.35}`;
      piece.style.transform = `rotate(${Math.random() * 180}deg)`;
      layer.append(piece);
    }
    window.setTimeout(() => layer.replaceChildren(), 4200);
  }

  /* ---------- Navigation ---------- */
  function getViewFromHash() {
    const view = location.hash.replace("#", "");
    return VIEW_TITLES[view] ? view : "lobby";
  }

  function syncBodyLock() {
    const modalOpen = Boolean(document.querySelector(".modal.open"));
    document.body.classList.toggle("modal-open", modalOpen);
  }

  function navigate(view, options = {}) {
    const target = VIEW_TITLES[view] ? view : "lobby";
    const push = options.push !== false;
    const shouldScroll = options.scroll !== false;
    currentView = target;

    $$(".view").forEach((element) => {
      element.classList.toggle("active", element.dataset.view === target);
    });

    $$(".tab").forEach((element) => {
      const tab = element.dataset.nav;
      const active = tab === "history" ? target === "history" : tab === "lobby" ? target === "lobby" || GAME_VIEWS.has(target) : false;
      element.classList.toggle("active", active);
      if (active) element.setAttribute("aria-current", "page");
      else element.removeAttribute("aria-current");
    });

    $$(".game-chip").forEach((element) => {
      const active = element.dataset.nav === target;
      element.classList.toggle("active", active);
      if (active) element.setAttribute("aria-current", "page");
      else element.removeAttribute("aria-current");
    });

    const centerGameChip = () => {
      const rail = document.getElementById("gameRail");
      if (!rail) return;
      const activeChip = rail.querySelector(".game-chip.active");
      if (!activeChip) {
        rail.scrollLeft = 0;
        return;
      }
      const railRect = rail.getBoundingClientRect();
      const chipRect = activeChip.getBoundingClientRect();
      const offset = chipRect.left - railRect.left - (rail.clientWidth - chipRect.width) / 2;
      const max = Math.max(0, rail.scrollWidth - rail.clientWidth);
      rail.scrollLeft = Math.max(0, Math.min(rail.scrollLeft + offset, max));
    };
    const back = document.getElementById("backBtn");
    if (back) back.hidden = !GAME_VIEWS.has(target);
    document.body.classList.toggle("is-game", GAME_VIEWS.has(target));
    centerGameChip();
    window.requestAnimationFrame(centerGameChip);

    document.title = target === "lobby" ? "KAZ - казино" : `${VIEW_TITLES[target]} - KAZ`;

    if (push && !suspendHash && location.hash !== `#${target}`) {
      window.history.pushState({ view: target }, "", `#${target}`);
    }
    closeAllModals();
    if (shouldScroll) window.scrollTo({ top: 0, behavior: "auto" });
    syncTelegramBack();
    document.dispatchEvent(new CustomEvent("np:navigate", { detail: { view: target } }));
  }

  /* ---------- Modals ---------- */
  function openModal(name) {
    const modal = typeof name === "string" ? document.getElementById(name) : name;
    if (!modal) return;
    lastFocused = document.activeElement;
    $$(".modal.open").forEach((open) => {
      open.classList.remove("open");
      open.setAttribute("aria-hidden", "true");
    });
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    syncBodyLock();
    if (modal.id === "modalBonus") updateDailyUI();
    window.setTimeout(() => {
      const focusTarget = modal.querySelector(".modal-close") || modal.querySelector("button");
      if (focusTarget) focusTarget.focus({ preventScroll: true });
    }, 80);
  }

  function closeModal(name) {
    const modal = typeof name === "string" ? document.getElementById(name) : name;
    if (!modal || !modal.classList.contains("open")) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    syncBodyLock();
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus({ preventScroll: true });
    }
  }

  function closeAllModals() {
    $$(".modal.open").forEach((modal) => {
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
    });
    syncBodyLock();
  }

  /* ---------- Daily bonus / top up ---------- */
  function openDaily() {
    updateDailyUI();
    openModal("modalBonus");
  }

  async function claimDaily() {
    if (state.lastDaily === mskDay()) {
      toast("Бонус уже получен", "Новый бонус будет доступен завтра.", "info");
      return;
    }
    try {
      const data = await api("daily.claim");
      applyState(data.state);
      closeModal("modalBonus");
      sound("cash");
      haptic("success");
      confetti(45);
      toast("Бонус получен", `+${formatStars(data.result.amount)} звёзд на баланс.`);
    } catch (error) {
      if (error.code === "already_claimed") refreshState(true);
      toast("Бонус недоступен", error.message, "info");
    }
  }

  function openTopup() {
    lastCreditAt = 0;
    const input = document.getElementById("topupAmount");
    if (input) input.value = String(DEFAULT_TOPUP);
    updateTopupUI();
    openModal("modalTopup");
  }

  function updateTopupUI() {
    const input = document.getElementById("topupAmount");
    const price = document.getElementById("topupPrice");
    const submit = document.getElementById("topupSubmitBtn");
    const footnote = document.getElementById("topupFootnote");
    const amount = Math.round(safeNumber(input && input.value));
    const valid = amount >= MIN_TOPUP && amount <= MAX_TOPUP;
    if (price) price.textContent = formatStars(valid ? amount : 0);
    if (submit) submit.disabled = !valid;
    if (footnote) {
      footnote.textContent = valid
        ? "После оплаты вернитесь в KAZ — баланс обновится"
        : `Введите сумму от ${MIN_TOPUP} до ${formatStars(MAX_TOPUP)} ★`;
    }
  }

  function tryOpenTopupLink(url) {
    if (!telegram) return false;
    if (typeof telegram.openTelegramLink === "function") {
      try {
        telegram.openTelegramLink(url);
        return true;
      } catch (error) {
        /* Fall through to the generic link API. */
      }
    }
    if (typeof telegram.openLink === "function") {
      try {
        telegram.openLink(url);
        return true;
      } catch (error) {
        /* Fall through to sendData/browser link. */
      }
    }
    return false;
  }

  const AUTH_KEY = "kaz_auth_token";

  function sessionToken() {
    let token = "";
    try {
      token = new URLSearchParams(window.location.search).get("auth") || "";
    } catch (error) {
      token = "";
    }
    if (!token && window.location.hash) {
      const match = window.location.hash.match(/[?&#]auth=([^&]+)/);
      if (match) {
        try { token = decodeURIComponent(match[1]); } catch (error) { token = ""; }
      }
    }
    try {
      if (token) {
        sessionStorage.setItem(AUTH_KEY, token);
        localStorage.setItem(AUTH_KEY, token);
      } else {
        token = sessionStorage.getItem(AUTH_KEY) || localStorage.getItem(AUTH_KEY) || "";
      }
    } catch (error) {
      /* Storage can be blocked; the token from the URL is still used. */
    }
    return token.slice(0, 512);
  }

  function authBody(extra) {
    const body = Object.assign({}, extra);
    const initData = telegram && telegram.initData ? telegram.initData : "";
    if (initData) {
      // Валидный initData главнее: устаревший токен из хранилища не должен давать 401.
      body.initData = initData;
    } else {
      const token = sessionToken();
      if (token) body.token = token;
    }
    return body;
  }

  function hasAuth() {
    return Boolean((telegram && telegram.initData) || sessionToken());
  }

  async function requestInvoice(amount) {
    if (!hasAuth()) return false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch("/api/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
        body: JSON.stringify(authBody({ amount }))
      });
      if (!response.ok) return false;
      const payload = await response.json();
      return Boolean(payload && payload.ok);
    } catch (error) {
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function submitTopup() {
    const input = document.getElementById("topupAmount");
    const amount = Math.round(safeNumber(input && input.value));
    if (amount < MIN_TOPUP || amount > MAX_TOPUP) {
      toast("Проверьте сумму", `Введите от ${MIN_TOPUP} до ${formatStars(MAX_TOPUP)} ★.`, "error");
      return;
    }
    if (!telegram) {
      try {
        window.open(`${BOT_LINK}?start=topup_${amount}`, "_blank");
        toast("Откройте чат бота", "Счёт на пополнение создаётся в чате с ботом.", "info");
      } catch (error) {
        toast("Откройте через ShuzaGram", "Пополнение доступно в Mini App по кнопке бота.", "error");
      }
      return;
    }

    const button = document.getElementById("topupSubmitBtn");
    const footnote = document.getElementById("topupFootnote");
    if (button) {
      button.disabled = true;
      button.textContent = "Отправляем счёт…";
    }
    const resetButton = () => {
      if (!button) return;
      button.textContent = "Пополнить за Stars";
      updateTopupUI();
    };

    // The bot sends the invoice straight into the user's chat, so the
    // top-up does not depend on deep-link support in the client.
    if (await requestInvoice(amount)) {
      resetButton();
      if (footnote) {
        footnote.textContent = `Счёт на ${formatStars(amount)} ★ отправлен в чат с ботом · оплатите и нажмите «Проверить»`;
      }
      toast("Счёт отправлен", `Счёт на ${formatStars(amount)} ★ — в чате с ботом.`, "info");
      return;
    }

    // Fallback: open the bot chat with a top-up deep link.
    const startUrl = `${BOT_LINK}?start=topup_${amount}`;
    if (tryOpenTopupLink(startUrl)) {
      toast("Счёт в чате", "Откройте чат с ботом — счёт уже там.", "info");
      window.setTimeout(resetButton, 4000);
      return;
    }

    if (typeof telegram.sendData === "function") {
      try {
        telegram.sendData(JSON.stringify({
          type: "topup",
          amount,
          at: Date.now()
        }));
        toast("Счёт отправлен", "Оплатите его в чате с ботом и вернитесь в KAZ.", "info");
        window.setTimeout(resetButton, 4000);
        return;
      } catch (error) {
        /* Fall through to the browser link. */
      }
    }

    try {
      window.open(startUrl, "_blank");
      toast("Откройте чат бота", "Счёт на пополнение создаётся в чате с ботом.", "info");
      window.setTimeout(resetButton, 4000);
    } catch (error) {
      resetButton();
      toast("Не удалось открыть оплату", "Попробуйте ещё раз или напишите администратору.", "error");
    }
  }

  function openTopupChat() {
    const input = document.getElementById("topupAmount");
    const amount = Math.round(safeNumber(input && input.value));
    if (amount < MIN_TOPUP || amount > MAX_TOPUP) {
      toast("Проверьте сумму", `Введите от ${MIN_TOPUP} до ${formatStars(MAX_TOPUP)} ★.`, "error");
      return;
    }
    const startUrl = `${BOT_LINK}?start=topup_${amount}`;
    if (tryOpenTopupLink(startUrl)) {
      closeModal("modalTopup");
      return;
    }
    try {
      window.open(startUrl, "_blank");
      closeModal("modalTopup");
    } catch (error) {
      toast("Не удалось открыть чат", "Напишите боту /buy " + amount + " вручную.", "error");
    }
  }

  async function checkTopup() {
    const button = document.getElementById("topupCheckBtn");
    if (!button) return;
    button.disabled = true;
    button.textContent = "Проверяем оплату…";
    const credited = await refreshState(true);
    button.disabled = false;
    button.textContent = "Уже оплатил · проверить";
    if (credited > 0) {
      closeModal("modalTopup");
      return;
    }
    if (!lastSyncProblem && lastCreditAt > 0) {
      // Платёж уже зачислен при возврате в приложение — не показываем «не найден».
      closeModal("modalTopup");
      toast("Баланс уже пополнен", `Сейчас на балансе ${formatStars(state.balance)} ★.`, "info");
      return;
    }
    const problems = {
      noauth: ["Не удалось определить аккаунт", "Откройте KAZ кнопкой «Открыть KAZ» из чата с ботом (команда /start) и нажмите проверку снова."],
      unauthorized: ["Сессия устарела", "Откройте KAZ заново кнопкой из чата с ботом (команда /start)."],
      storage_unavailable: ["Хранилище платежей недоступно", "Платёж не потерян. Попробуйте через минуту."],
      network: ["Нет связи с сервером", "Проверьте интернет и попробуйте снова."],
      internal_error: ["Ошибка сервера", "Попробуйте ещё раз через минуту."]
    };
    if (problems[lastSyncProblem]) {
      toast(problems[lastSyncProblem][0], problems[lastSyncProblem][1], "info");
      return;
    }
    toast("Платёж пока не найден", "Если оплата прошла, подождите несколько секунд и попробуйте снова.", "info");
  }

  /* ---------- Server state ---------- */
  class ApiError extends Error {
    constructor(code, message, status) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  const API_MESSAGES = {
    noauth: "Откройте KAZ кнопкой «Открыть KAZ» из чата с ботом (/start).",
    unauthorized: "Сессия устарела. Откройте KAZ заново кнопкой из чата с ботом.",
    network: "Нет связи с сервером. Попробуйте ещё раз.",
    storage_unavailable: "Хранилище временно недоступно. Попробуйте через минуту.",
    internal_error: "Ошибка сервера. Попробуйте ещё раз.",
    insufficient_funds: "Мало звёзд на балансе.",
    round_active: "Раунд уже идёт.",
    no_round: "Раунд не найден."
  };

  let roundLocks = 0;
  let refreshPromise = null;
  let lastRefresh = 0;
  let lastCreditAt = 0;
  let lastSyncProblem = "";

  /** Hold background refreshes while a round animation is still playing. */
  function lockSync() {
    roundLocks += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      roundLocks = Math.max(0, roundLocks - 1);
    };
  }

  async function api(action, params = {}) {
    if (!hasAuth()) throw new ApiError("noauth", API_MESSAGES.noauth, 0);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20000);
    let response;
    try {
      response = await fetch("/api/game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
        body: JSON.stringify(authBody(Object.assign({}, params, { action })))
      });
    } catch (error) {
      throw new ApiError("network", API_MESSAGES.network, 0);
    } finally {
      window.clearTimeout(timer);
    }
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    if (!response.ok || !data || !data.ok) {
      const code = data && data.error ? data.error : response.status === 401 ? "unauthorized" : "internal_error";
      const message = (data && data.message) || API_MESSAGES[code] || API_MESSAGES.internal_error;
      throw new ApiError(code, message, response.status);
    }
    return data;
  }

  function applyState(server, options = {}) {
    if (!server || typeof server !== "object") return;
    const int = (value) => Math.max(0, Math.round(safeNumber(value)));
    state.balance = int(server.balance);
    state.games = int(server.games);
    state.wagered = int(server.wagered);
    state.biggestWin = int(server.biggestWin);
    state.history = (Array.isArray(server.history) ? server.history : [])
      .filter((entry) => entry && GAME_META[entry.game])
      .slice(0, MAX_HISTORY)
      .map((entry) => ({
        id: String(entry.id),
        game: entry.game,
        title: String(entry.title || GAME_META[entry.game].label).slice(0, 80),
        detail: String(entry.detail || "").slice(0, 140),
        delta: Math.round(safeNumber(entry.delta)),
        wager: int(entry.wager),
        at: Number(entry.at) || Date.now()
      }));
    state.withdrawals = (Array.isArray(server.withdrawals) ? server.withdrawals : [])
      .slice(0, 20)
      .map((entry) => ({
        id: String(entry.id).slice(0, 60),
        amount: int(entry.amount),
        contact: String(entry.contact || "").slice(0, 80),
        at: Number(entry.at) || Date.now(),
        status: String(entry.status || "pending")
      }));
    state.purchases = (Array.isArray(server.purchases) ? server.purchases : [])
      .slice(0, 100)
      .map((entry) => ({
        chargeId: String(entry.chargeId).slice(0, 100),
        amount: int(entry.amount),
        at: Number(entry.at) || Date.now()
      }));
    state.lastDaily = typeof server.lastDaily === "string" ? server.lastDaily : null;
    state.active = server.active && typeof server.active === "object" ? server.active : {};
    state.loaded = true;
    saveState();
    renderBalance(options.animate !== false);
    renderStats();
    renderHistory();
    renderPurchases();
    renderWithdrawals();
    updateDailyUI();
    updateWithdrawUI();
    document.dispatchEvent(new CustomEvent("np:state"));
  }

  /**
   * Load the player's state from the server (this also credits new Telegram
   * Stars purchases). Resolves to the number of newly credited stars.
   */
  async function refreshState(force = false) {
    if (refreshPromise) return refreshPromise;
    if (!force && (roundLocks > 0 || Date.now() - lastRefresh < 3000)) return 0;
    if (roundLocks > 0) return 0;
    lastRefresh = Date.now();

    refreshPromise = (async () => {
      try {
        const data = await api("state");
        lastSyncProblem = "";
        if (roundLocks > 0) return 0;
        applyState(data.state);
        const credited = Math.max(0, Math.round(safeNumber(data.result && data.result.credited)));
        if (credited > 0) {
          lastCreditAt = Date.now();
          sound("cash");
          haptic("success");
          toast("Баланс пополнен", `+${formatStars(credited)} ★ зачислено.`);
        }
        document.dispatchEvent(new CustomEvent("np:synced"));
        return credited;
      } catch (error) {
        lastSyncProblem = error.code || "internal_error";
        return 0;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  }

  function telegramUser() {
    try {
      return telegram && telegram.initDataUnsafe ? telegram.initDataUnsafe.user || null : null;
    } catch (error) {
      return null;
    }
  }

  function telegramIdentity(user) {
    if (!user) return "";
    if (user.username) return `@${user.username}`;
    return [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  }

  function updateWithdrawUI() {
    const input = document.getElementById("withdrawAmount");
    const submit = document.getElementById("withdrawSubmitBtn");
    const footnote = document.getElementById("withdrawFootnote");
    const amount = Math.round(safeNumber(input && input.value));
    const identity = telegramIdentity(telegramUser());
    const canSend = hasAuth();
    const enough = state.balance >= MIN_WITHDRAW;
    const valid = !withdrawLocked
      && canSend
      && enough
      && amount >= MIN_WITHDRAW
      && amount <= state.balance;

    if (input) input.max = String(Math.max(0, state.balance));
    if (submit) {
      submit.disabled = !valid;
      submit.textContent = withdrawLocked ? "Заявка отправлена" : "Отправить заявку";
    }
    if (footnote) {
      if (withdrawLocked) footnote.textContent = "Заявка создана · звёзды зарезервированы";
      else if (!canSend) footnote.textContent = "Откройте приложение через ShuzaGram";
      else if (!enough) footnote.textContent = `Минимум ${MIN_WITHDRAW} ★ · недостаточно звёзд`;
      else if (!amount) footnote.textContent = `Минимум ${MIN_WITHDRAW} ★ · решение принимает администратор`;
      else if (amount < MIN_WITHDRAW) footnote.textContent = `Минимум ${MIN_WITHDRAW} ★`;
      else if (amount > state.balance) footnote.textContent = "Сумма больше баланса";
      else if (!identity) footnote.textContent = "Контакт возьмём из профиля ShuzaGram";
      else footnote.textContent = `Контакт: ${identity} · решение принимает администратор`;
    }
  }

  function openWithdraw() {
    withdrawLocked = false;
    const result = document.getElementById("withdrawResult");
    const amountInput = document.getElementById("withdrawAmount");
    const userLabel = document.getElementById("withdrawUserLabel");
    const user = telegramUser();
    const identity = telegramIdentity(user);

    if (result) {
      result.hidden = true;
      result.replaceChildren();
    }
    if (userLabel) {
      userLabel.textContent = identity
        ? (user && user.id ? `${identity} · ID ${user.id}` : identity)
        : "Определится автоматически";
    }
    if (amountInput) {
      amountInput.value = state.balance >= MIN_WITHDRAW
        ? String(Math.min(state.balance, MIN_WITHDRAW))
        : "";
    }
    updateWithdrawUI();
    openModal("modalWithdraw");
  }

  function showWithdrawResult(request) {
    const result = document.getElementById("withdrawResult");
    if (!result) return;
    result.hidden = false;
    result.innerHTML = `
      <p>Заявка <strong>${escapeHtml(request.id)}</strong> на <strong>${formatStars(request.amount)} ★</strong> отправлена администратору. Контакт для связи взят из ShuzaGram.</p>
    `;
  }

  async function submitWithdraw() {
    if (withdrawLocked) return;
    const input = document.getElementById("withdrawAmount");
    const amount = Math.round(safeNumber(input && input.value));

    if (state.balance < MIN_WITHDRAW) {
      toast("Мало звёзд", `Для вывода нужно минимум ${MIN_WITHDRAW} ★.`, "error");
      return;
    }
    if (amount < MIN_WITHDRAW || amount > state.balance) {
      toast("Проверьте сумму", `Введите сумму от ${MIN_WITHDRAW} до ${formatStars(state.balance)} ★.`, "error");
      return;
    }

    withdrawLocked = true;
    updateWithdrawUI();
    try {
      const data = await api("withdraw.request", { amount });
      applyState(data.state);
      sound("cash");
      haptic("success");
      showWithdrawResult(data.result.withdrawal);
      updateWithdrawUI();
      document.dispatchEvent(new CustomEvent("np:state"));
      toast(
        "Заявка создана",
        data.result.notified === false
          ? `${formatStars(amount)} ★ зарезервированы, но администратор пока не уведомлён.`
          : `${formatStars(amount)} ★ зарезервированы для вывода.`,
        "info"
      );
    } catch (error) {
      withdrawLocked = false;
      updateWithdrawUI();
      toast("Не удалось создать заявку", error.message, "error");
    }
  }

  /* ---------- Event wiring ---------- */
  function bindEvents() {
    document.addEventListener("click", (event) => {
      const nav = event.target.closest("[data-nav]");
      if (nav) {
        event.preventDefault();
        navigate(nav.dataset.nav);
        return;
      }

      const close = event.target.closest("[data-close-modal]");
      if (close) {
        closeModal(close.closest(".modal"));
        return;
      }

      const action = event.target.closest("[data-action]");
      if (action) {
        sound("click");
        if (action.dataset.action === "daily") openDaily();
        if (action.dataset.action === "daily-claim") claimDaily();
        if (action.dataset.action === "topup") openTopup();
        if (action.dataset.action === "withdraw") openWithdraw();
        if (action.dataset.action === "fair") openModal("modalFair");
        return;
      }
    });

    document.getElementById("soundBtn")?.addEventListener("click", () => {
      state.sound = !state.sound;
      saveState();
      syncSoundButton();
      if (state.sound) sound("click");
      toast(state.sound ? "Звук включён" : "Звук выключен", "", "info");
    });
    document.getElementById("claimBonusBtn")?.addEventListener("click", claimDaily);

    document.getElementById("topupAmount")?.addEventListener("input", updateTopupUI);
    document.getElementById("topupSubmitBtn")?.addEventListener("click", submitTopup);
    document.getElementById("topupChatBtn")?.addEventListener("click", openTopupChat);
    document.getElementById("topupCheckBtn")?.addEventListener("click", checkTopup);

    const withdrawAmount = document.getElementById("withdrawAmount");
    withdrawAmount?.addEventListener("input", updateWithdrawUI);
    document.getElementById("withdrawSubmitBtn")?.addEventListener("click", submitWithdraw);
    document.querySelectorAll("[data-withdraw-quick]").forEach((button) => {
      button.addEventListener("click", () => {
        if (withdrawLocked) return;
        const input = document.getElementById("withdrawAmount");
        if (!input) return;
        if (button.dataset.withdrawQuick === "max") {
          input.value = state.balance >= MIN_WITHDRAW ? String(state.balance) : "";
        } else {
          const current = Math.round(safeNumber(input.value)) || state.balance;
          input.value = String(Math.max(MIN_WITHDRAW, Math.floor(current / 2)));
        }
        updateWithdrawUI();
        sound("click");
      });
    });
    document.addEventListener("np:state", updateWithdrawUI);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && document.querySelector(".modal.open")) {
        closeAllModals();
      }
    });

    // If the tab stays open across midnight (or the clock changes), refresh
    // the daily-bonus state when the user comes back to the app.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        updateDailyUI();
        refreshState();
      }
    });
    window.addEventListener("pageshow", () => {
      updateDailyUI();
      refreshState();
    });

    window.addEventListener("popstate", () => {
      const view = getViewFromHash();
      if (view !== currentView) navigate(view, { push: false });
    });
    window.addEventListener("hashchange", () => {
      const view = getViewFromHash();
      if (view !== currentView) navigate(view, { push: false });
    });
  }

  function init() {
    prepareTelegram();
    bindEvents();
    renderAll();
    syncSoundButton();
    scheduleDailyRefresh();
    refreshState(true);
    const initialView = getViewFromHash();
    navigate(initialView, { push: false, scroll: false });
    if (!suspendHash) {
      window.history.replaceState({ view: initialView }, "", `#${initialView}`);
    }
  }

  window.NP = Object.freeze({
    getState: () => state,
    getCurrentView: () => currentView,
    DEFAULT_BET,
    saveState,
    formatStars,
    formatChips: formatStars,
    formatSigned,
    randomInt,
    randomFloat,
    setBalance,
    adjustBalance,
    recordResult,
    api,
    applyState,
    refreshState,
    lockSync,
    hasAuth,
    renderAll,
    renderStats,
    renderHistory,
    updateDailyUI,
    renderBalance,
    toast,
    sound,
    haptic,
    confetti,
    openModal,
    closeModal,
    closeAllModals,
    navigate,
    todayKey,
    escapeHtml
  });

  init();
})();

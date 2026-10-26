/* =========================================================
   KAZ — core: state, navigation, shared UI
   ========================================================= */
(() => {
  "use strict";

  const STORAGE_KEY = "kaz_demo_v1";
  const START_BALANCE = 50;
  const DAILY_BONUS = 10;
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
      balance: START_BALANCE,
      games: 0,
      wagered: 0,
      biggestWin: 0,
      history: [],
      lastDaily: null,
      sound: true
    };
  }

  function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function loadState() {
    const fresh = createDefaultState();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return fresh;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") return fresh;

      const history = Array.isArray(saved.history)
        ? saved.history
            .filter((entry) => entry && GAME_META[entry.game] && Number.isFinite(Number(entry.delta)))
            .slice(0, MAX_HISTORY)
            .map((entry) => ({
              id: String(entry.id || `${Date.now()}-${Math.random()}`),
              game: entry.game,
              title: String(entry.title || GAME_META[entry.game].label).slice(0, 80),
              detail: String(entry.detail || "").slice(0, 140),
              delta: Math.round(Number(entry.delta)),
              wager: Math.max(0, Math.round(Number(entry.wager) || 0)),
              at: Number(entry.at) || Date.now()
            }))
        : [];

      return {
        balance: Math.max(0, Math.round(safeNumber(saved.balance, START_BALANCE))),
        games: Math.max(0, Math.round(safeNumber(saved.games))),
        wagered: Math.max(0, Math.round(safeNumber(saved.wagered))),
        biggestWin: Math.max(0, Math.round(safeNumber(saved.biggestWin))),
        history,
        lastDaily: typeof saved.lastDaily === "string" ? saved.lastDaily : null,
        sound: saved.sound !== false
      };
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

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  }

  function recordResult({ game, title, detail, delta, wager }) {
    if (!GAME_META[game]) return;
    const net = Math.round(safeNumber(delta));
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      game,
      title: title || GAME_META[game].label,
      detail: detail || "",
      delta: net,
      wager: Math.max(0, Math.round(safeNumber(wager))),
      at: Date.now()
    };

    state.games += 1;
    state.wagered += entry.wager;
    state.biggestWin = Math.max(state.biggestWin, net);
    state.history.unshift(entry);
    state.history = state.history.slice(0, MAX_HISTORY);
    saveState();
    renderStats();
    renderHistory();
    document.dispatchEvent(new CustomEvent("np:state", { detail: { entry } }));
  }

  function timeUntilTomorrow() {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const minutes = Math.max(0, Math.ceil((tomorrow.getTime() - now.getTime()) / 60_000));
    if (minutes < 60) return `через ${minutes} мин`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `через ${hours} ч ${rest} мин` : `через ${hours} ч`;
  }

  function updateDailyUI() {
    const claimed = state.lastDaily === todayKey();
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
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const delay = Math.max(1_000, tomorrow.getTime() - now.getTime() + 1_000);
    dailyTimer = window.setTimeout(() => {
      updateDailyUI();
      scheduleDailyRefresh();
    }, delay);
  }

  function renderAll() {
    renderBalance(false);
    renderStats();
    renderHistory();
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
      if (typeof webApp.setHeaderColor === "function") webApp.setHeaderColor("#07090d");
      if (typeof webApp.setBackgroundColor === "function") webApp.setBackgroundColor("#07090d");
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
    const colors = ["#c8ff5e", "#ffd166", "#ff6478", "#a98bff", "#65b9ff", "#ffffff"];

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

    const back = document.getElementById("backBtn");
    if (back) back.hidden = !GAME_VIEWS.has(target);
    document.body.classList.toggle("is-game", GAME_VIEWS.has(target));

    document.title = target === "lobby" ? "KAZ — демо-казино" : `${VIEW_TITLES[target]} — KAZ`;

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

  function claimDaily() {
    if (state.lastDaily === todayKey()) {
      toast("Бонус уже получен", "Новый бонус будет доступен завтра.", "info");
      return;
    }
    state.lastDaily = todayKey();
    adjustBalance(DAILY_BONUS, { animate: true });
    saveState();
    updateDailyUI();
    closeModal("modalBonus");
    sound("cash");
    haptic("success");
    confetti(45);
    toast("Бонус получен", `+${formatStars(DAILY_BONUS)} звёзд на баланс.`);
    document.dispatchEvent(new CustomEvent("np:state"));
  }

  function topUp(amount) {
    const value = Math.max(0, Math.round(safeNumber(amount)));
    if (!value) return;
    adjustBalance(value, { animate: true });
    closeModal("modalTopup");
    sound("cash");
    haptic("success");
    confetti(28);
    toast("Баланс пополнен", `+${formatStars(value)} виртуальных звёзд.`);
    document.dispatchEvent(new CustomEvent("np:state"));
  }

  function confirmReset() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      /* Ignore storage errors. */
    }
    location.hash = "#lobby";
    location.reload();
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
        if (action.dataset.action === "topup") openModal("modalTopup");
        return;
      }

      const topup = event.target.closest("[data-topup]");
      if (topup) {
        topUp(topup.dataset.topup);
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
    document.getElementById("openResetBtn2")?.addEventListener("click", () => openModal("modalReset"));
    document.getElementById("confirmResetBtn")?.addEventListener("click", confirmReset);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && document.querySelector(".modal.open")) {
        closeAllModals();
      }
    });

    // If the tab stays open across midnight (or the clock changes), refresh
    // the daily-bonus state when the user comes back to the app.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) updateDailyUI();
    });
    window.addEventListener("pageshow", updateDailyUI);

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
    const initialView = getViewFromHash();
    navigate(initialView, { push: false, scroll: false });
    if (!suspendHash) {
      window.history.replaceState({ view: initialView }, "", `#${initialView}`);
    }
  }

  window.NP = Object.freeze({
    getState: () => state,
    getCurrentView: () => currentView,
    saveState,
    formatStars,
    formatChips: formatStars,
    formatSigned,
    randomInt,
    randomFloat,
    setBalance,
    adjustBalance,
    recordResult,
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

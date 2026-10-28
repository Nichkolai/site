/* =========================================================
   KAZ — Слоты
   ========================================================= */
(() => {
  "use strict";

  const NP = window.NP;
  if (!NP) return;

  // Weights are intentionally tuned below the displayed paytable RTP.
  // The paytable stays unchanged for players.
  const SYMBOLS = [
    { id: "cherry", icon: "🍒", weight: 30, triple: 10, name: "Вишня" },
    { id: "lemon", icon: "🍋", weight: 23, triple: 16, name: "Лимон" },
    { id: "bell", icon: "🔔", weight: 19, triple: 24, name: "Колокол" },
    { id: "star", icon: "⭐", weight: 13, triple: 50, name: "Звезда" },
    { id: "seven", icon: "7", weight: 9, triple: 100, name: "Семёрка" },
    { id: "diamond", icon: "💎", weight: 6, triple: 240, name: "Алмаз" }
  ];

  const TOTAL_WEIGHT = SYMBOLS.reduce((sum, symbol) => sum + symbol.weight, 0);
  const BET_STEPS = [1, 2, 5, 10, 25, 50];
  const MIN_BET = BET_STEPS[0];
  const startingBet = [...BET_STEPS]
    .reverse()
    .find((value) => value <= Math.min(NP.getState().balance, NP.DEFAULT_BET)) || MIN_BET;
  const LINES = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 4, 8],
    [2, 4, 6]
  ];

  const slot = {
    bet: startingBet,
    spinning: false,
    grid: [],
    wins: new Set()
  };

  const elements = {
    reels: [],
    grid: null,
    win: null,
    bet: null,
    spin: null,
    betDown: null,
    betUp: null,
    half: null,
    double: null,
    max: null
  };

  const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

  function randomSymbol() {
    let ticket = NP.randomInt(TOTAL_WEIGHT);
    for (const symbol of SYMBOLS) {
      ticket -= symbol.weight;
      if (ticket < 0) return symbol;
    }
    return SYMBOLS[0];
  }

  function randomGrid() {
    return Array.from({ length: 9 }, () => randomSymbol());
  }

  function columnSymbols(grid, column) {
    return [grid[column], grid[3 + column], grid[6 + column]];
  }

  function ensureReelCells(reel) {
    while (reel.children.length < 3) {
      const cell = document.createElement("div");
      cell.className = "slot-cell";
      reel.append(cell);
    }
  }

  function paintColumn(column, symbols) {
    const reel = elements.reels[column];
    if (!reel) return;
    ensureReelCells(reel);
    Array.from(reel.children).forEach((cell, row) => {
      const symbol = symbols[row];
      cell.textContent = symbol.icon;
      cell.dataset.index = String(row * 3 + column);
      cell.dataset.symbol = symbol.id;
      cell.setAttribute("aria-label", symbol.name);
    });
  }

  function paintGrid(grid) {
    for (let column = 0; column < 3; column += 1) {
      paintColumn(column, columnSymbols(grid, column));
    }
    applyWins();
  }

  function applyWins() {
    document.querySelectorAll(".slot-cell").forEach((cell) => {
      const index = Number(cell.dataset.index);
      cell.classList.toggle("win", slot.wins.has(index));
    });
  }

  function setWins(indices) {
    slot.wins = new Set(indices);
    applyWins();
  }

  function betOptions() {
    const balance = NP.getState().balance;
    const options = BET_STEPS.filter((step) => step <= balance);
    if (balance >= MIN_BET && !options.includes(balance)) options.push(balance);
    return options.sort((a, b) => a - b);
  }

  function setBet(value) {
    const balance = NP.getState().balance;
    const next = Math.max(MIN_BET, Math.min(balance, Math.round(value)));
    slot.bet = Number.isFinite(next) ? next : MIN_BET;
    updateBetUI();
    NP.sound("click");
  }

  function updateBetUI() {
    const balance = NP.getState().balance;
    if (elements.bet) elements.bet.textContent = NP.formatStars(slot.bet);
    if (elements.betDown) elements.betDown.disabled = slot.spinning || slot.bet <= MIN_BET;
    if (elements.betUp) elements.betUp.disabled = slot.spinning || slot.bet >= balance;
    if (elements.half) elements.half.disabled = slot.spinning || slot.bet <= MIN_BET;
    if (elements.double) elements.double.disabled = slot.spinning || slot.bet >= balance;
    if (elements.max) elements.max.disabled = slot.spinning || slot.bet >= balance || balance < MIN_BET;
  }

  function setControlsDisabled(disabled) {
    if (elements.betDown) elements.betDown.disabled = disabled || slot.bet <= MIN_BET;
    if (elements.betUp) elements.betUp.disabled = disabled || slot.bet >= NP.getState().balance;
    if (elements.half) elements.half.disabled = disabled || slot.bet <= MIN_BET;
    if (elements.double) elements.double.disabled = disabled || slot.bet >= NP.getState().balance;
    if (elements.max) elements.max.disabled = disabled || slot.bet >= NP.getState().balance;
    if (elements.spin) {
      elements.spin.disabled = disabled;
      elements.spin.classList.toggle("spinning", disabled);
      const label = elements.spin.querySelector("strong");
      if (label) label.textContent = disabled ? "Крутим…" : "Крутить";
      const note = elements.spin.querySelector("small");
      if (note) note.textContent = disabled ? "Удачи" : "5 линий";
    }
  }

  function changeBet(direction) {
    if (slot.spinning) return;
    const options = betOptions();
    const next = direction > 0
      ? options.find((value) => value > slot.bet)
      : [...options].reverse().find((value) => value < slot.bet);
    if (!next) return;
    slot.bet = next;
    updateBetUI();
    NP.sound("click");
  }

  function halveBet() {
    if (slot.spinning) return;
    setBet(Math.floor(slot.bet / 2));
  }

  function doubleBet() {
    if (slot.spinning) return;
    setBet(slot.bet * 2);
  }

  function chooseMaxBet() {
    if (slot.spinning) return;
    const balance = NP.getState().balance;
    if (balance < MIN_BET) {
      NP.toast("Мало звёзд", "Пополните баланс, чтобы продолжить.", "error");
      NP.openModal("modalTopup");
      return;
    }
    setBet(balance);
  }

  function showReadyState() {
    if (!elements.win) return;
    elements.win.className = "slot-win";
    elements.win.innerHTML = "<span>Готов к игре?</span><strong>Крути и лови удачу</strong>";
  }

  function showResult(total, lineCount) {
    if (!elements.win) return;
    if (total > 0) {
      elements.win.className = "slot-win is-win";
      elements.win.innerHTML = `
        <span>${lineCount} ${lineCount === 1 ? "линия" : lineCount < 5 ? "линии" : "линий"} · выигрыш</span>
        <strong>+${NP.formatStars(total)} ★</strong>
      `;
    } else {
      elements.win.className = "slot-win is-lose";
      elements.win.innerHTML = "<span>В этот раз пусто</span><strong>Попробуйте ещё</strong>";
    }
  }

  function randomizeReel(column) {
    paintColumn(column, [randomSymbol(), randomSymbol(), randomSymbol()]);
  }

  function animateReels(finalGrid) {
    return new Promise((resolve) => {
      if (document.hidden) {
        paintGrid(finalGrid);
        resolve();
        return;
      }

      let stopped = 0;
      let finished = false;
      const timers = [];

      const finish = () => {
        if (finished) return;
        finished = true;
        timers.forEach((timer) => {
          window.clearInterval(timer.flicker);
          window.clearTimeout(timer.stop);
        });
        window.clearTimeout(watchdog);
        elements.reels.forEach((reel, column) => {
          reel.classList.remove("is-spinning");
          paintColumn(column, columnSymbols(finalGrid, column));
        });
        resolve();
      };

      const watchdog = window.setTimeout(finish, 2800);

      elements.reels.forEach((reel, column) => {
        reel.classList.add("is-spinning");
        const flicker = window.setInterval(() => randomizeReel(column), 65);
        const stop = window.setTimeout(() => {
          window.clearInterval(flicker);
          paintColumn(column, columnSymbols(finalGrid, column));
          reel.classList.remove("is-spinning");
          NP.sound("stop");
          stopped += 1;
          if (stopped === elements.reels.length) finish();
        }, 620 + column * 330 + NP.randomInt(150));
        timers.push({ flicker, stop });
      });
    });
  }

  async function spin() {
    if (slot.spinning) return;
    const bet = slot.bet;
    if (NP.getState().balance < bet) {
      NP.toast("Мало звёзд", `Для ставки нужно ${NP.formatStars(bet)} ★.`, "error");
      NP.openModal("modalTopup");
      return;
    }

    slot.spinning = true;
    setWins([]);
    setControlsDisabled(true);
    if (elements.win) {
      elements.win.className = "slot-win";
      elements.win.innerHTML = "<span>Барабаны вращаются</span><strong>Удачи!</strong>";
    }

    const unlock = NP.lockSync();
    NP.adjustBalance(-bet, { animate: true });
    NP.sound("spin");
    NP.haptic("light");

    // The server rolls the reels and pays out; the app only shows the result.
    let data;
    try {
      data = await NP.api("slots.spin", { bet });
    } catch (error) {
      unlock();
      NP.refreshState(true);
      NP.toast("Спин не выполнен", error.message, "error");
      if (error.code === "insufficient_funds") NP.openModal("modalTopup");
      showReadyState();
      slot.spinning = false;
      setControlsDisabled(false);
      updateBetUI();
      return;
    }

    const byId = Object.fromEntries(SYMBOLS.map((symbol) => [symbol.id, symbol]));
    const finalGrid = data.result.grid.map((id) => byId[id] || SYMBOLS[0]);
    await animateReels(finalGrid);

    slot.grid = finalGrid;
    paintGrid(finalGrid);
    const result = {
      total: data.result.total,
      lineCount: data.result.lines,
      wins: new Set(data.result.wins)
    };
    setWins(result.wins);
    await wait(160);

    NP.applyState(data.state);
    unlock();

    if (result.total > 0) {
      NP.sound(result.total >= bet * 15 ? "bigwin" : "win");
      NP.haptic("success");
      if (result.total >= bet * 15) NP.confetti(55);
    } else {
      NP.sound("lose");
      NP.haptic("error");
    }

    showResult(result.total, result.lineCount);
    if (result.total > 0) {
      NP.toast(
        result.total >= bet * 15 ? "Крупный выигрыш!" : "Есть выигрыш!",
        `+${NP.formatStars(result.total)} звёзд на баланс.`
      );
    }

    slot.spinning = false;
    setControlsDisabled(false);
    updateBetUI();
  }

  function renderInitial() {
    slot.grid = randomGrid();
    paintGrid(slot.grid);
    showReadyState();
    updateBetUI();
  }

  function init() {
    elements.grid = document.getElementById("slotGrid");
    if (!elements.grid) return;
    elements.reels = Array.from(elements.grid.querySelectorAll(".slot-reel"));
    elements.win = document.getElementById("slotWin");
    elements.bet = document.getElementById("slotBet");
    elements.spin = document.getElementById("spinBtn");
    elements.betDown = document.getElementById("slotBetDown");
    elements.betUp = document.getElementById("slotBetUp");
    elements.half = document.getElementById("slotBetHalf");
    elements.double = document.getElementById("slotBetDouble");
    elements.max = document.getElementById("slotMax");

    renderInitial();

    elements.spin?.addEventListener("click", spin);
    elements.betDown?.addEventListener("click", () => changeBet(-1));
    elements.betUp?.addEventListener("click", () => changeBet(1));
    elements.half?.addEventListener("click", halveBet);
    elements.double?.addEventListener("click", doubleBet);
    elements.max?.addEventListener("click", chooseMaxBet);

    document.addEventListener("keydown", (event) => {
      if (event.code !== "Space") return;
      if (NP.getCurrentView() !== "slots") return;
      if (document.querySelector(".modal.open")) return;
      const tag = event.target.tagName;
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag)) return;
      event.preventDefault();
      spin();
    });

    document.addEventListener("np:state", updateBetUI);
    document.addEventListener("np:navigate", (event) => {
      if (event.detail.view === "slots") updateBetUI();
    });
  }

  init();
})();

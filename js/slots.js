/* =========================================================
   KAZ — Слоты
   ========================================================= */
(() => {
  "use strict";

  const NP = window.NP;
  if (!NP) return;

  const SYMBOLS = [
    { id: "cherry", icon: "🍒", weight: 32, triple: 10, name: "Вишня" },
    { id: "lemon", icon: "🍋", weight: 25, triple: 16, name: "Лимон" },
    { id: "bell", icon: "🔔", weight: 18, triple: 24, name: "Колокол" },
    { id: "star", icon: "⭐", weight: 14, triple: 50, name: "Звезда" },
    { id: "seven", icon: "7", weight: 8, triple: 100, name: "Семёрка" },
    { id: "diamond", icon: "💎", weight: 3, triple: 240, name: "Алмаз" }
  ];

  const TOTAL_WEIGHT = SYMBOLS.reduce((sum, symbol) => sum + symbol.weight, 0);
  const BET_STEPS = [1, 2, 5, 10];
  const LINES = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 4, 8],
    [2, 4, 6]
  ];

  const slot = {
    bet: 2,
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

  function updateBetUI() {
    if (elements.bet) elements.bet.textContent = NP.formatStars(slot.bet);
    if (elements.betDown) elements.betDown.disabled = slot.spinning || slot.bet <= BET_STEPS[0];
    if (elements.betUp) elements.betUp.disabled = slot.spinning || slot.bet >= BET_STEPS[BET_STEPS.length - 1];
    if (elements.max) elements.max.disabled = slot.spinning;
  }

  function setControlsDisabled(disabled) {
    if (elements.betDown) elements.betDown.disabled = disabled || slot.bet <= BET_STEPS[0];
    if (elements.betUp) elements.betUp.disabled = disabled || slot.bet >= BET_STEPS[BET_STEPS.length - 1];
    if (elements.max) elements.max.disabled = disabled;
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
    const currentIndex = BET_STEPS.indexOf(slot.bet);
    const nextIndex = Math.min(
      BET_STEPS.length - 1,
      Math.max(0, (currentIndex === -1 ? 1 : currentIndex) + direction)
    );
    slot.bet = BET_STEPS[nextIndex];
    updateBetUI();
    NP.sound("click");
  }

  function chooseMaxBet() {
    if (slot.spinning) return;
    const balance = NP.getState().balance;
    const affordable = BET_STEPS.filter((step) => step <= balance);
    if (!affordable.length) {
      NP.toast("Мало звёзд", "Пополните демо-баланс, чтобы продолжить.", "error");
      NP.openModal("modalTopup");
      return;
    }
    slot.bet = affordable[affordable.length - 1];
    updateBetUI();
    NP.sound("click");
  }

  function evaluateGrid(grid, bet) {
    const lineStake = bet / LINES.length;
    const wins = new Set();
    let total = 0;
    let lineCount = 0;

    LINES.forEach((line) => {
      const symbols = line.map((index) => grid[index]);
      if (symbols[0].id === symbols[1].id && symbols[1].id === symbols[2].id) {
        total += Math.round(lineStake * symbols[0].triple);
        lineCount += 1;
        line.forEach((index) => wins.add(index));
      }
    });

    return { total, lineCount, wins };
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

    NP.adjustBalance(-bet, { animate: true });
    NP.sound("spin");
    NP.haptic("light");

    const finalGrid = randomGrid();
    await animateReels(finalGrid);

    slot.grid = finalGrid;
    paintGrid(finalGrid);
    const result = evaluateGrid(finalGrid, bet);
    setWins(result.wins);
    await wait(160);

    if (result.total > 0) {
      NP.adjustBalance(result.total, { animate: true });
      NP.sound(result.total >= bet * 15 ? "bigwin" : "win");
      NP.haptic("success");
      if (result.total >= bet * 15) NP.confetti(55);
    } else {
      NP.sound("lose");
      NP.haptic("error");
    }

    showResult(result.total, result.lineCount);
    const net = result.total - bet;
    const detail = result.total > 0
      ? `${result.lineCount} ${result.lineCount === 1 ? "линия" : result.lineCount < 5 ? "линии" : "линий"} · ставка ${NP.formatStars(bet)}`
      : `Без выигрыша · ставка ${NP.formatStars(bet)}`;

    NP.recordResult({
      game: "slots",
      title: "Слоты",
      detail,
      delta: net,
      wager: bet
    });

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
    elements.max = document.getElementById("slotMax");

    renderInitial();

    elements.spin?.addEventListener("click", spin);
    elements.betDown?.addEventListener("click", () => changeBet(-1));
    elements.betUp?.addEventListener("click", () => changeBet(1));
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

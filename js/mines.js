/* =========================================================
   KAZ — Mines (5 x 5, 5 mines)
   ========================================================= */
(() => {
  "use strict";

  const NP = window.NP;
  if (!NP) return;

  const CELLS = 25;
  const MINES = 5;
  const BET_STEPS = [5, 10, 25, 50];
  const HOUSE_EDGE = 0.92;
  const MAX_MULTIPLIER = 250;

  const game = {
    bet: 5,
    active: false,
    over: false,
    mines: new Set(),
    picks: 0,
    wager: 0,
    busy: false
  };

  const elements = {
    grid: null,
    bet: null,
    betDown: null,
    betUp: null,
    multiplier: null,
    next: null,
    status: null,
    action: null
  };

  function multiplierFor(picks) {
    if (!picks) return 1;
    let multiplier = 1;
    for (let index = 0; index < picks; index += 1) {
      multiplier *= (CELLS - index) / (CELLS - MINES - index);
    }
    return Math.min(MAX_MULTIPLIER, multiplier * HOUSE_EDGE);
  }

  function potentialPayout(picks = game.picks) {
    if (!picks) return 0;
    return Math.round(game.wager * multiplierFor(picks));
  }

  function buildGrid() {
    if (!elements.grid) return;
    elements.grid.replaceChildren();
    for (let index = 0; index < CELLS; index += 1) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "mine-cell";
      cell.dataset.index = String(index);
      cell.setAttribute("aria-label", `Клетка ${index + 1}`);
      cell.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-star"></use></svg>';
      elements.grid.append(cell);
    }
  }

  function resetCells() {
    if (!elements.grid) return;
    Array.from(elements.grid.children).forEach((cell) => {
      cell.className = "mine-cell";
      cell.disabled = false;
      cell.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-star"></use></svg>';
      cell.setAttribute("aria-label", `Клетка ${Number(cell.dataset.index) + 1}`);
    });
  }

  function revealMines() {
    if (!elements.grid) return;
    Array.from(elements.grid.children).forEach((cell) => {
      const index = Number(cell.dataset.index);
      cell.disabled = true;
      if (game.mines.has(index)) {
        if (!cell.classList.contains("safe")) cell.classList.add("mine", "revealed");
        cell.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-bomb"></use></svg>';
        cell.setAttribute("aria-label", "Мина");
      }
    });
  }

  function setStatus(text, tone = "") {
    if (!elements.status) return;
    elements.status.textContent = text;
    elements.status.className = `game-status${tone ? ` ${tone}` : ""}`;
  }

  function updateUI() {
    if (elements.bet) elements.bet.textContent = NP.formatStars(game.bet);
    if (elements.betDown) elements.betDown.disabled = game.active || game.busy || game.bet <= BET_STEPS[0];
    if (elements.betUp) elements.betUp.disabled = game.active || game.busy || game.bet >= BET_STEPS[BET_STEPS.length - 1];
    if (elements.multiplier) elements.multiplier.textContent = `${multiplierFor(game.picks).toFixed(2)}×`;

    if (elements.next) {
      if (game.active && game.picks >= CELLS - MINES) {
        elements.next.textContent = "MAX";
      } else {
        elements.next.textContent = `${multiplierFor(game.picks + 1).toFixed(2)}×`;
      }
    }

    if (elements.action) {
      elements.action.disabled = game.busy || (game.active && game.picks === 0);
      if (game.active) {
        elements.action.textContent = game.picks > 0
          ? `Забрать ${NP.formatStars(potentialPayout())} ★`
          : "Открой клетку";
      } else if (game.over) {
        elements.action.textContent = "Ещё раз";
      } else {
        elements.action.textContent = "Начать";
      }
    }
  }

  function changeBet(direction) {
    if (game.active || game.busy) return;
    const currentIndex = BET_STEPS.indexOf(game.bet);
    const nextIndex = Math.min(
      BET_STEPS.length - 1,
      Math.max(0, (currentIndex === -1 ? 0 : currentIndex) + direction)
    );
    game.bet = BET_STEPS[nextIndex];
    updateUI();
    NP.sound("click");
  }

  function startRound() {
    if (game.active || game.busy) return;
    if (NP.getState().balance < game.bet) {
      NP.toast("Мало звёзд", "Пополните демо-баланс или выберите ставку меньше.", "error");
      NP.openModal("modalTopup");
      return;
    }

    const pool = Array.from({ length: CELLS }, (_, index) => index);
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swap = NP.randomInt(index + 1);
      [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }
    game.mines = new Set(pool.slice(0, MINES));
    game.active = true;
    game.over = false;
    game.picks = 0;
    game.wager = game.bet;
    game.busy = false;

    NP.adjustBalance(-game.wager, { animate: true });
    NP.sound("click");
    NP.haptic("light");
    resetCells();
    setStatus("Откройте звезду. Чем больше открыто, тем выше множитель.");
    updateUI();
  }

  function finishRound(won) {
    game.active = false;
    game.over = true;
    revealMines();
    updateUI();
  }

  function cashOut() {
    if (!game.active || game.busy || game.picks === 0) return;
    game.busy = true;
    updateUI();

    const payout = potentialPayout();
    NP.adjustBalance(payout, { animate: true });
    const net = payout - game.wager;
    finishRound(true);

    setStatus(`Забрали ${NP.formatStars(payout)} ★ · чистый ${net >= 0 ? "+" : "−"}${NP.formatStars(Math.abs(net))}`, "win");
    NP.sound("cash");
    NP.haptic("success");
    if (net >= game.wager * 3) NP.confetti(50);

    NP.recordResult({
      game: "mines",
      title: "Мины",
      detail: `Открыто ${game.picks} из 20 · ставка ${NP.formatStars(game.wager)}`,
      delta: net,
      wager: game.wager
    });

    game.busy = false;
    updateUI();
  }

  function revealCell(cell) {
    if (!game.active || game.busy) return;
    const index = Number(cell.dataset.index);
    if (cell.classList.contains("safe") || cell.classList.contains("mine")) return;

    if (game.mines.has(index)) {
      game.busy = true;
      game.active = false;
      cell.classList.add("mine");
      setStatus(`Мина! Потеряно ${NP.formatStars(game.wager)} ★`, "lose");
      revealMines();
      game.over = true;
      NP.sound("lose");
      NP.haptic("error");

      NP.recordResult({
        game: "mines",
        title: "Мины",
        detail: `Мина после ${game.picks} ${game.picks === 1 ? "звезды" : "звёзд"} · ставка ${NP.formatStars(game.wager)}`,
        delta: -game.wager,
        wager: game.wager
      });

      game.busy = false;
      updateUI();
      return;
    }

    cell.classList.add("safe");
    game.picks += 1;
    NP.sound("click");
    NP.haptic("light");

    if (game.picks >= CELLS - MINES) {
      setStatus("Все 20 звёзд открыты! Забираем максимум.");
      cashOut();
      return;
    }

    setStatus(`Открыто ${game.picks}. Можно забрать ${NP.formatStars(potentialPayout())} ★.`);
    updateUI();
  }

  function handleAction() {
    if (game.active) cashOut();
    else startRound();
  }

  function init() {
    elements.grid = document.getElementById("minesGrid");
    if (!elements.grid) return;
    elements.bet = document.getElementById("minesBet");
    elements.betDown = document.getElementById("minesBetDown");
    elements.betUp = document.getElementById("minesBetUp");
    elements.multiplier = document.getElementById("minesMultiplier");
    elements.next = document.getElementById("minesNext");
    elements.status = document.getElementById("minesStatus");
    elements.action = document.getElementById("minesAction");

    buildGrid();
    updateUI();

    elements.grid.addEventListener("click", (event) => {
      const cell = event.target.closest(".mine-cell");
      if (cell && !cell.disabled) revealCell(cell);
    });
    elements.betDown?.addEventListener("click", () => changeBet(-1));
    elements.betUp?.addEventListener("click", () => changeBet(1));
    elements.action?.addEventListener("click", handleAction);
    document.addEventListener("np:state", updateUI);
    document.addEventListener("np:navigate", (event) => {
      if (event.detail.view === "mines") updateUI();
    });
  }

  init();
})();

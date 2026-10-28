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
  const MIN_BET = BET_STEPS[0];
  const startingBet = [...BET_STEPS]
    .reverse()
    .find((value) => value <= Math.min(NP.getState().balance, NP.DEFAULT_BET)) || MIN_BET;
  const HOUSE_EDGE = 0.92;
  const MAX_MULTIPLIER = 250;
  const game = {
    bet: startingBet,
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
    betHalf: null,
    betDouble: null,
    betMax: null,
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
    const balance = NP.getState().balance;
    const locked = game.active || game.busy;
    if (elements.bet) elements.bet.textContent = NP.formatStars(game.bet);
    if (elements.betDown) elements.betDown.disabled = locked || game.bet <= MIN_BET;
    if (elements.betUp) elements.betUp.disabled = locked || game.bet >= balance;
    if (elements.betHalf) elements.betHalf.disabled = locked || game.bet <= MIN_BET;
    if (elements.betDouble) elements.betDouble.disabled = locked || game.bet >= balance;
    if (elements.betMax) elements.betMax.disabled = locked || game.bet >= balance || balance < MIN_BET;
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

  function betOptions() {
    const balance = NP.getState().balance;
    const options = BET_STEPS.filter((value) => value <= balance);
    if (balance >= MIN_BET && !options.includes(balance)) options.push(balance);
    return options.sort((a, b) => a - b);
  }

  function setBet(value) {
    if (game.active || game.busy) return;
    const balance = NP.getState().balance;
    const next = Math.max(MIN_BET, Math.min(balance, Math.round(value)));
    game.bet = Number.isFinite(next) ? next : MIN_BET;
    updateUI();
    NP.sound("click");
  }

  function halveBet() {
    setBet(Math.floor(game.bet / 2));
  }

  function doubleBet() {
    setBet(game.bet * 2);
  }

  function maxBet() {
    if (game.active || game.busy) return;
    const balance = NP.getState().balance;
    if (balance < MIN_BET) {
      NP.toast("Мало звёзд", "Пополните баланс, чтобы продолжить.", "error");
      NP.openModal("modalTopup");
      return;
    }
    setBet(balance);
  }

  function changeBet(direction) {
    if (game.active || game.busy) return;
    const options = betOptions();
    const next = direction > 0
      ? options.find((value) => value > game.bet)
      : [...options].reverse().find((value) => value < game.bet);
    if (!next) return;
    game.bet = next;
    updateUI();
    NP.sound("click");
  }

  function describeError(error) {
    return error && error.message ? error.message : "Попробуйте ещё раз.";
  }

  function finishRound() {
    game.active = false;
    game.over = true;
    revealMines();
    updateUI();
  }

  /** Rebuild a round that is still running on the server (e.g. after a reload). */
  function restoreFromServer() {
    const saved = NP.getState().active && NP.getState().active.mines;
    if (!saved || game.active || game.busy) return;
    game.active = true;
    game.over = false;
    game.wager = saved.wager;
    game.picks = saved.picks;
    game.mines = new Set();
    resetCells();
    saved.revealed.forEach((index) => {
      const cell = elements.grid.children[index];
      if (cell) cell.classList.add("safe");
    });
    setStatus(
      saved.picks > 0
        ? `Открыто ${saved.picks}. Можно забрать ${NP.formatStars(saved.potential)} ★.`
        : "Откройте звезду. Чем больше открыто, тем выше множитель."
    );
    updateUI();
  }

  async function startRound() {
    if (game.active || game.busy) return;
    if (NP.getState().balance < game.bet) {
      NP.toast("Мало звёзд", "Пополните баланс или выберите ставку меньше.", "error");
      NP.openModal("modalTopup");
      return;
    }

    game.busy = true;
    updateUI();
    const unlock = NP.lockSync();
    NP.adjustBalance(-game.bet, { animate: true });

    let data;
    try {
      data = await NP.api("mines.start", { bet: game.bet });
    } catch (error) {
      unlock();
      game.busy = false;
      await NP.refreshState(true);
      if (error.code === "round_active") restoreFromServer();
      else NP.toast("Раунд не начат", describeError(error), "error");
      if (error.code === "insufficient_funds") NP.openModal("modalTopup");
      updateUI();
      return;
    }

    // The server placed the mines; the app never learns where they are
    // until the round is over.
    game.mines = new Set();
    game.active = true;
    game.over = false;
    game.picks = 0;
    game.wager = data.result.wager;
    game.busy = false;
    NP.applyState(data.state);
    unlock();

    NP.sound("click");
    NP.haptic("light");
    resetCells();
    setStatus("Откройте звезду. Чем больше открыто, тем выше множитель.");
    updateUI();
  }

  function showCashed(result, data, unlock) {
    game.mines = new Set(result.mines);
    game.picks = result.picks;
    finishRound();
    NP.applyState(data.state);
    unlock();

    const net = result.net;
    setStatus(
      `Забрали ${NP.formatStars(result.payout)} ★ · чистый ${net >= 0 ? "+" : "−"}${NP.formatStars(Math.abs(net))}`,
      "win"
    );
    NP.sound("cash");
    NP.haptic("success");
    if (net >= result.wager * 3) NP.confetti(50);
    game.busy = false;
    updateUI();
  }

  async function cashOut() {
    if (!game.active || game.busy || game.picks === 0) return;
    game.busy = true;
    updateUI();
    const unlock = NP.lockSync();

    let data;
    try {
      data = await NP.api("mines.cashout");
    } catch (error) {
      unlock();
      game.busy = false;
      NP.toast("Не удалось забрать выигрыш", describeError(error), "error");
      await NP.refreshState(true);
      updateUI();
      return;
    }
    showCashed(data.result, data, unlock);
  }

  async function revealCell(cell) {
    if (!game.active || game.busy) return;
    const index = Number(cell.dataset.index);
    if (cell.classList.contains("safe") || cell.classList.contains("mine")) return;

    game.busy = true;
    updateUI();
    const unlock = NP.lockSync();

    let data;
    try {
      data = await NP.api("mines.reveal", { index });
    } catch (error) {
      unlock();
      game.busy = false;
      NP.toast("Клетка не открыта", describeError(error), "error");
      await NP.refreshState(true);
      updateUI();
      return;
    }

    const result = data.result;
    if (result.status === "lost") {
      game.mines = new Set(result.mines);
      game.picks = result.picks;
      cell.classList.add("mine");
      setStatus(`Мина! Потеряно ${NP.formatStars(result.wager)} ★`, "lose");
      finishRound();
      NP.applyState(data.state);
      unlock();
      NP.sound("lose");
      NP.haptic("error");
      game.busy = false;
      updateUI();
      return;
    }

    cell.classList.add("safe");
    game.picks = result.picks;
    NP.sound("click");
    NP.haptic("light");

    if (result.status === "cashed") {
      setStatus("Все 20 звёзд открыты! Забираем максимум.");
      showCashed(result, data, unlock);
      return;
    }

    NP.applyState(data.state);
    unlock();
    setStatus(`Открыто ${result.picks}. Можно забрать ${NP.formatStars(result.potential)} ★.`);
    game.busy = false;
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
    elements.betHalf = document.getElementById("minesBetHalf");
    elements.betDouble = document.getElementById("minesBetDouble");
    elements.betMax = document.getElementById("minesBetMax");
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
    elements.betHalf?.addEventListener("click", halveBet);
    elements.betDouble?.addEventListener("click", doubleBet);
    elements.betMax?.addEventListener("click", maxBet);
    elements.action?.addEventListener("click", handleAction);
    document.addEventListener("np:state", () => {
      restoreFromServer();
      updateUI();
    });
    document.addEventListener("np:navigate", (event) => {
      if (event.detail.view === "mines") updateUI();
    });
    restoreFromServer();
  }

  init();
})();

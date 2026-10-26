/* =========================================================
   KAZ — Upgrader
   ========================================================= */
(() => {
  "use strict";

  const NP = window.NP;
  if (!NP) return;

  const BET_STEPS = [2, 5, 10, 25];
  const TARGETS = [1.5, 2, 3, 5, 10];
  const HOUSE_EDGE = 0.93;

  const game = {
    bet: 2,
    target: 2,
    busy: false
  };

  const elements = {
    bet: null,
    betDown: null,
    betUp: null,
    target: null,
    chance: null,
    payout: null,
    zone: null,
    marker: null,
    result: null,
    action: null,
    targets: null
  };

  function chanceFor(target = game.target) {
    return Math.min(1, HOUSE_EDGE / target);
  }

  function payoutFor(bet = game.bet, target = game.target) {
    return Math.round(bet * target);
  }

  function formatChance(value) {
    return `${(value * 100).toFixed(1).replace(".0", "")}%`;
  }

  function updateUI() {
    if (elements.bet) elements.bet.textContent = NP.formatStars(game.bet);
    if (elements.target) elements.target.textContent = `×${game.target.toFixed(2)}`;
    if (elements.chance) elements.chance.textContent = formatChance(chanceFor());
    if (elements.payout) elements.payout.textContent = `${NP.formatStars(payoutFor())} ★`;
    if (elements.zone) elements.zone.style.width = `${chanceFor() * 100}%`;

    if (elements.betDown) elements.betDown.disabled = game.busy || game.bet <= BET_STEPS[0];
    if (elements.betUp) elements.betUp.disabled = game.busy || game.bet >= BET_STEPS[BET_STEPS.length - 1];
    if (elements.action) elements.action.disabled = game.busy;

    if (elements.targets) {
      elements.targets.querySelectorAll("[data-up-target]").forEach((button) => {
        button.disabled = game.busy;
        button.classList.toggle("is-active", Number(button.dataset.upTarget) === game.target);
      });
    }
  }

  function resetResult(text = "Нажмите «Апгрейд»") {
    if (!elements.result) return;
    elements.result.textContent = text;
    elements.result.className = "up-result";
    if (elements.marker) elements.marker.classList.remove("show");
  }

  function chooseTarget(value) {
    if (game.busy || !TARGETS.includes(value)) return;
    game.target = value;
    updateUI();
    resetResult();
    NP.sound("click");
  }

  function changeBet(direction) {
    if (game.busy) return;
    const currentIndex = BET_STEPS.indexOf(game.bet);
    const nextIndex = Math.min(
      BET_STEPS.length - 1,
      Math.max(0, (currentIndex === -1 ? 0 : currentIndex) + direction)
    );
    game.bet = BET_STEPS[nextIndex];
    updateUI();
    resetResult();
    NP.sound("click");
  }

  function startRound() {
    if (game.busy) return;
    if (NP.getState().balance < game.bet) {
      NP.toast("Мало звёзд", "Пополните демо-баланс или выберите ставку меньше.", "error");
      NP.openModal("modalTopup");
      return;
    }

    const bet = game.bet;
    const target = game.target;
    const chance = chanceFor(target);
    const roll = NP.randomFloat();
    const won = roll < chance;

    game.busy = true;
    NP.adjustBalance(-bet, { animate: true });
    NP.sound("spin");
    NP.haptic("light");
    updateUI();

    if (elements.result) {
      elements.result.textContent = "Проверяем…";
      elements.result.className = "up-result";
    }
    if (elements.marker) {
      elements.marker.classList.remove("show");
      elements.marker.style.left = "0%";
      void elements.marker.offsetWidth;
      elements.marker.style.left = `${roll * 100}%`;
      elements.marker.classList.add("show");
    }

    window.setTimeout(() => {
      const payout = Math.round(bet * target);
      const net = won ? payout - bet : -bet;

      if (won) {
        NP.adjustBalance(payout, { animate: true });
        NP.sound(target >= 5 ? "bigwin" : "win");
        NP.haptic("success");
        if (target >= 5 || net >= bet * 4) NP.confetti(45);
        if (elements.result) {
          elements.result.textContent = `Выигрыш +${NP.formatStars(net)} ★`;
          elements.result.className = "up-result win";
        }
      } else {
        NP.sound("lose");
        NP.haptic("error");
        if (elements.result) {
          elements.result.textContent = `Мимо · −${NP.formatStars(bet)} ★`;
          elements.result.className = "up-result lose";
        }
      }

      NP.recordResult({
        game: "upgrader",
        title: "Апгрейд",
        detail: `Цель ×${target.toFixed(2)} · шанс ${formatChance(chance)} · ставка ${NP.formatStars(bet)}`,
        delta: net,
        wager: bet
      });

      game.busy = false;
      updateUI();
    }, 760);
  }

  function init() {
    elements.bet = document.getElementById("upBet");
    elements.betDown = document.getElementById("upBetDown");
    elements.betUp = document.getElementById("upBetUp");
    elements.target = document.getElementById("upTarget");
    elements.chance = document.getElementById("upChance");
    elements.payout = document.getElementById("upPayout");
    elements.zone = document.getElementById("upZone");
    elements.marker = document.getElementById("upMarker");
    elements.result = document.getElementById("upResult");
    elements.action = document.getElementById("upAction");
    elements.targets = document.getElementById("upTargets");
    if (!elements.action) return;

    updateUI();
    resetResult("Выберите множитель");

    elements.action.addEventListener("click", startRound);
    elements.betDown?.addEventListener("click", () => changeBet(-1));
    elements.betUp?.addEventListener("click", () => changeBet(1));
    elements.targets?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-up-target]");
      if (button) chooseTarget(Number(button.dataset.upTarget));
    });

    document.addEventListener("np:state", updateUI);
    document.addEventListener("np:navigate", (event) => {
      if (event.detail.view === "upgrader") updateUI();
    });
  }

  init();
})();

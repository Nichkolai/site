/* =========================================================
   KAZ — Upgrader
   ========================================================= */
(() => {
  "use strict";

  const NP = window.NP;
  if (!NP) return;

  const BET_STEPS = [2, 5, 10, 25, 50];
  const MIN_BET = BET_STEPS[0];
  const startingBet = [...BET_STEPS]
    .reverse()
    .find((value) => value <= Math.min(NP.getState().balance, NP.DEFAULT_BET)) || MIN_BET;
  const TARGETS = [1.5, 2, 3, 5, 10];
  const TARGET_EMOJI = { 1.5: "🎁", 2: "🌹", 3: "🎂", 5: "🏆", 10: "💎" };
  const HOUSE_EDGE = 0.93;
  // The displayed chance stays the same; the actual roll uses a hidden
  // reduction so the visible marker never contradicts the result.
  const HIDDEN_CHANCE_FACTOR = 0.88;

  const game = {
    bet: startingBet,
    target: 2,
    busy: false
  };

  const elements = {
    bet: null,
    betDown: null,
    betUp: null,
    betHalf: null,
    betDouble: null,
    betMax: null,
    target: null,
    chance: null,
    wheelChance: null,
    payout: null,
    zone: null,
    marker: null,
    emoji: null,
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
    if (elements.wheelChance) elements.wheelChance.textContent = formatChance(chanceFor());
    if (elements.emoji) elements.emoji.textContent = TARGET_EMOJI[game.target] || "🎁";
    if (elements.payout) elements.payout.textContent = `${NP.formatStars(payoutFor())} ★`;
    if (elements.zone) {
      elements.zone.setAttribute(
        "aria-label",
        `Колесо апгрейда, множитель ×${game.target}, шанс ${formatChance(chanceFor())}`
      );
    }
    if (elements.zone) {
      elements.zone.style.setProperty("--chance", (chanceFor() * 100).toFixed(2));
    }

    const balance = NP.getState().balance;
    if (elements.betDown) elements.betDown.disabled = game.busy || game.bet <= MIN_BET;
    if (elements.betUp) elements.betUp.disabled = game.busy || game.bet >= balance;
    if (elements.betHalf) elements.betHalf.disabled = game.busy || game.bet <= MIN_BET;
    if (elements.betDouble) elements.betDouble.disabled = game.busy || game.bet >= balance;
    if (elements.betMax) elements.betMax.disabled = game.busy || game.bet >= balance || balance < MIN_BET;
    if (elements.action) elements.action.disabled = game.busy;

    if (elements.targets) {
      elements.targets.querySelectorAll("[data-up-target]").forEach((button) => {
        button.disabled = game.busy;
        button.classList.toggle("is-active", Number(button.dataset.upTarget) === game.target);
      });
    }
  }

  function resetResult(text = "Нажмите «Апгрейд»") {
    if (elements.zone) elements.zone.classList.remove("is-spinning", "is-win", "is-lose");
    if (elements.emoji) elements.emoji.classList.remove("is-popping");
    if (elements.marker) {
      elements.marker.classList.remove("show");
      elements.marker.style.setProperty("--marker-angle", "0deg");
    }
    if (!elements.result) return;
    elements.result.textContent = text;
    elements.result.className = "up-result";
  }

  function popEmoji() {
    if (!elements.emoji) return;
    elements.emoji.classList.remove("is-popping");
    void elements.emoji.offsetWidth;
    elements.emoji.classList.add("is-popping");
  }

  function chooseTarget(value) {
    if (game.busy || !TARGETS.includes(value)) return;
    game.target = value;
    updateUI();
    resetResult();
    popEmoji();
    NP.sound("click");
  }

  function betOptions() {
    const balance = NP.getState().balance;
    return BET_STEPS.filter((value) => value <= balance);
  }

  function setBet(value) {
    if (game.busy) return;
    const balance = NP.getState().balance;
    const next = Math.max(MIN_BET, Math.min(balance, Math.round(value)));
    game.bet = Number.isFinite(next) ? next : MIN_BET;
    updateUI();
    resetResult();
    NP.sound("click");
  }

  function halveBet() {
    setBet(Math.floor(game.bet / 2));
  }

  function doubleBet() {
    setBet(game.bet * 2);
  }

  function maxBet() {
    if (game.busy) return;
    const balance = NP.getState().balance;
    if (balance < MIN_BET) {
      NP.toast("Мало звёзд", "Пополните баланс, чтобы продолжить.", "error");
      NP.openModal("modalTopup");
      return;
    }
    setBet(balance);
  }

  function changeBet(direction) {
    if (game.busy) return;
    const options = betOptions();
    const next = direction > 0
      ? options.find((value) => value > game.bet)
      : [...options].reverse().find((value) => value < game.bet);
    if (!next) return;
    game.bet = next;
    updateUI();
    resetResult();
    NP.sound("click");
  }

  function startRound() {
    if (game.busy) return;
    if (NP.getState().balance < game.bet) {
      NP.toast("Мало звёзд", "Пополните баланс или выберите ставку меньше.", "error");
      NP.openModal("modalTopup");
      return;
    }

    const bet = game.bet;
    const target = game.target;
    const chance = chanceFor(target);
    const roll = NP.randomFloat();
    const won = roll < chance * HIDDEN_CHANCE_FACTOR;
    const markerRoll = won || roll >= chance
      ? roll
      : chance + NP.randomFloat() * (1 - chance);

    game.busy = true;
    NP.adjustBalance(-bet, { animate: true });
    NP.sound("spin");
    NP.haptic("light");
    updateUI();

    if (elements.result) {
      elements.result.textContent = "Проверяем…";
      elements.result.className = "up-result";
    }
    if (elements.zone) elements.zone.classList.remove("is-spinning", "is-win", "is-lose");
    if (elements.emoji) elements.emoji.classList.remove("is-popping");
    if (elements.marker) {
      const wheel = elements.zone;
      elements.marker.classList.remove("show");
      elements.marker.style.setProperty("--marker-angle", "0deg");
      void elements.marker.offsetWidth;
      if (wheel) void wheel.offsetWidth;
      if (wheel) wheel.classList.add("is-spinning");
      elements.marker.classList.add("show");
      // Two and a half turns before the pointer settles on the result.
      elements.marker.style.setProperty("--marker-angle", `${900 + markerRoll * 360}deg`);
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
        detail: `Цель ×${target.toFixed(2)} · шанс ${formatChance(chance)}`,
        delta: net,
        wager: bet
      });

      if (elements.zone) {
        elements.zone.classList.remove("is-spinning");
        elements.zone.classList.add(won ? "is-win" : "is-lose");
      }
      game.busy = false;
      updateUI();
    }, 1100);
  }

  function init() {
    elements.bet = document.getElementById("upBet");
    elements.betDown = document.getElementById("upBetDown");
    elements.betUp = document.getElementById("upBetUp");
    elements.betHalf = document.getElementById("upBetHalf");
    elements.betDouble = document.getElementById("upBetDouble");
    elements.betMax = document.getElementById("upBetMax");
    elements.target = document.getElementById("upTarget");
    elements.chance = document.getElementById("upChance");
    elements.wheelChance = document.getElementById("upWheelChance");
    elements.payout = document.getElementById("upPayout");
    elements.zone = document.getElementById("upWheel");
    elements.marker = document.getElementById("upMarker");
    elements.emoji = document.getElementById("upEmoji");
    elements.result = document.getElementById("upResult");
    elements.action = document.getElementById("upAction");
    elements.targets = document.getElementById("upTargets");
    if (!elements.action) return;

    updateUI();
    resetResult("Выберите множитель");

    elements.action.addEventListener("click", startRound);
    elements.betDown?.addEventListener("click", () => changeBet(-1));
    elements.betUp?.addEventListener("click", () => changeBet(1));
    elements.betHalf?.addEventListener("click", halveBet);
    elements.betDouble?.addEventListener("click", doubleBet);
    elements.betMax?.addEventListener("click", maxBet);
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

/* =========================================================
   KAZ — Blackjack
   ========================================================= */
(() => {
  "use strict";

  const NP = window.NP;
  if (!NP) return;

  const SUITS = [
    { symbol: "♠", color: "black", name: "пики" },
    { symbol: "♥", color: "red", name: "черви" },
    { symbol: "♦", color: "red", name: "бубны" },
    { symbol: "♣", color: "black", name: "трефы" }
  ];
  const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const BET_STEPS = [5, 10, 25, 50];
  const MIN_BET = BET_STEPS[0];
  const startingBet = [...BET_STEPS]
    .reverse()
    .find((value) => value <= Math.min(NP.getState().balance, NP.DEFAULT_BET)) || MIN_BET;

  const bj = {
    bet: startingBet,
    phase: "idle",
    player: [],
    dealer: [],
    hidden: true,
    wager: 0,
    settled: false,
    busy: false,
    doubled: false
  };

  const elements = {};

  const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

  // Cards come from the server as [rank, suitIndex]; null is the dealer's
  // face-down card, which the app never receives until the round is over.
  function toCard(raw) {
    return raw ? { rank: raw[0], suit: SUITS[raw[1]] } : null;
  }

  function cardPoints(card) {
    if (card.rank === "A") return 11;
    if (["K", "Q", "J"].includes(card.rank)) return 10;
    return Number(card.rank);
  }

  function handValue(rawHand) {
    const hand = rawHand.filter(Boolean);
    let total = hand.reduce((sum, card) => sum + cardPoints(card), 0);
    let aces = hand.filter((card) => card.rank === "A").length;
    while (total > 21 && aces > 0) {
      total -= 10;
      aces -= 1;
    }
    return { total, soft: aces > 0 };
  }

  function isPlaying() {
    return bj.phase === "player" || bj.phase === "dealer";
  }

  function setStatus(text, tone = "") {
    if (!elements.status) return;
    elements.status.textContent = text;
    elements.status.className = `bj-status${tone ? ` ${tone}` : ""}`;
  }

  function cardElement(card, index, hidden = false) {
    const element = document.createElement("div");
    hidden = hidden || !card;
    element.className = `playing-card ${card ? card.suit.color : "black"}${hidden ? " hidden-card" : ""}`;
    element.style.animationDelay = `${Math.min(index * 55, 280)}ms`;
    if (hidden) {
      element.setAttribute("aria-label", "Закрытая карта дилера");
      return element;
    }
    element.setAttribute("aria-label", `${card.rank} ${card.suit.name}`);
    element.innerHTML = `
      <span class="card-corner">${card.rank}<small>${card.suit.symbol}</small></span>
      <span class="card-center">${card.suit.symbol}</span>
      <span class="card-corner bottom">${card.rank}<small>${card.suit.symbol}</small></span>
    `;
    return element;
  }

  function renderHand(container, hand, hiddenIndex = -1) {
    if (!container) return;
    container.replaceChildren();
    if (!hand.length) {
      const empty = document.createElement("div");
      empty.className = "hand-empty";
      empty.textContent = "Карты появятся здесь";
      container.append(empty);
      return;
    }
    hand.forEach((card, index) => {
      container.append(cardElement(card, index, index === hiddenIndex));
    });
  }

  function renderHands() {
    renderHand(elements.dealerHand, bj.dealer, bj.hidden ? 1 : -1);
    renderHand(elements.playerHand, bj.player);

    const playerValue = handValue(bj.player);
    const dealerValue = handValue(bj.dealer);

    if (elements.playerScore) {
      elements.playerScore.textContent = bj.player.length ? String(playerValue.total) : "—";
    }
    if (elements.dealerScore) {
      if (!bj.dealer.length) {
        elements.dealerScore.textContent = "—";
      } else if (bj.hidden) {
        elements.dealerScore.textContent = `${handValue([bj.dealer[0]]).total} + ?`;
      } else {
        elements.dealerScore.textContent = String(dealerValue.total);
      }
    }
  }

  function updateControls() {
    const balance = NP.getState().balance;
    const playing = isPlaying();

    document.querySelectorAll("[data-bj-bet]").forEach((button) => {
      const value = Number(button.dataset.bjBet);
      button.classList.toggle("active", value === bj.bet);
      button.disabled = playing;
    });

    if (elements.betAmount) elements.betAmount.textContent = NP.formatStars(bj.bet);
    if (elements.betHalf) elements.betHalf.disabled = playing || bj.bet <= MIN_BET;
    if (elements.betDouble) elements.betDouble.disabled = playing || bj.bet >= balance;
    if (elements.betMax) elements.betMax.disabled = playing || bj.bet >= balance || balance < MIN_BET;
    if (elements.deal) {
      elements.deal.disabled = playing || bj.busy;
      elements.deal.textContent = playing ? "Идёт раунд" : bj.phase === "done" ? "Новая игра" : "Раздать";
    }
    if (elements.actions) elements.actions.hidden = bj.phase !== "player";
    if (elements.hit) elements.hit.disabled = bj.busy || bj.phase !== "player";
    if (elements.stand) elements.stand.disabled = bj.busy || bj.phase !== "player";
    if (elements.double) {
      elements.double.disabled = bj.busy
        || bj.phase !== "player"
        || bj.doubled
        || bj.player.length !== 2
        || balance < bj.bet;
    }
  }

  function describeError(error) {
    return error && error.message ? error.message : "Попробуйте ещё раз.";
  }

  function applyView(view) {
    bj.player = view.player.map(toCard);
    bj.dealer = view.dealer.map(toCard);
    bj.hidden = view.hidden;
    bj.wager = view.wager;
    bj.bet = view.bet;
    bj.doubled = view.doubled;
  }

  /** Rebuild a round that is still running on the server (e.g. after a reload). */
  function restoreFromServer() {
    const saved = NP.getState().active && NP.getState().active.blackjack;
    if (!saved || isPlaying() || bj.busy) return;
    applyView(saved);
    bj.phase = "player";
    bj.settled = false;
    renderHands();
    setStatus("Ваш ход: «Ещё», «Хватит» или «Удвоить»");
    updateControls();
  }

  async function startRound() {
    if (isPlaying() || bj.busy) return;
    if (NP.getState().balance < bj.bet) {
      NP.toast("Мало звёзд", "Пополните баланс или выберите ставку меньше.", "error");
      NP.openModal("modalTopup");
      return;
    }

    bj.busy = true;
    updateControls();
    const unlock = NP.lockSync();
    NP.adjustBalance(-bj.bet, { animate: true });

    let data;
    try {
      data = await NP.api("blackjack.deal", { bet: bj.bet });
    } catch (error) {
      unlock();
      bj.busy = false;
      await NP.refreshState(true);
      if (error.code === "round_active") restoreFromServer();
      else NP.toast("Раздача не началась", describeError(error), "error");
      if (error.code === "insufficient_funds") NP.openModal("modalTopup");
      updateControls();
      return;
    }

    const view = data.result.view;
    applyView(view);
    bj.phase = "player";
    bj.settled = false;
    NP.sound("card");
    NP.haptic("light");
    renderHands();
    setStatus("Ваш ход: «Ещё», «Хватит» или «Удвоить»");

    if (view.phase === "done") {
      await conclude(view, data, unlock);
      return;
    }
    NP.applyState(data.state);
    unlock();
    bj.busy = false;
    updateControls();
  }

  async function sendAction(action) {
    if (bj.phase !== "player" || bj.busy) return null;
    bj.busy = true;
    updateControls();
    const unlock = NP.lockSync();
    try {
      const data = await NP.api(action);
      return { data, unlock };
    } catch (error) {
      unlock();
      bj.busy = false;
      NP.toast("Действие не выполнено", describeError(error), "error");
      await NP.refreshState(true);
      if (error.code === "no_round") {
        bj.phase = "idle";
        restoreFromServer();
      }
      updateControls();
      return null;
    }
  }

  async function hit() {
    const sent = await sendAction("blackjack.hit");
    if (!sent) return;
    const { data, unlock } = sent;
    const view = data.result.view;
    NP.sound("card");
    NP.haptic("light");
    bj.player = view.player.map(toCard);
    renderHands();

    if (view.phase === "done") {
      await conclude(view, data, unlock);
      return;
    }
    NP.applyState(data.state);
    unlock();
    bj.busy = false;
    setStatus(`У вас ${view.playerTotal}. Ещё карту?`);
    updateControls();
  }

  async function stand() {
    const sent = await sendAction("blackjack.stand");
    if (!sent) return;
    await conclude(sent.data.result.view, sent.data, sent.unlock);
  }

  async function doubleDown() {
    if (bj.phase !== "player" || bj.busy || bj.doubled || bj.player.length !== 2) return;
    if (NP.getState().balance < bj.bet) {
      NP.toast("Мало звёзд для удвоения", "Выберите меньшую ставку в следующем раунде.", "error");
      return;
    }
    NP.adjustBalance(-bj.bet, { animate: true });
    const sent = await sendAction("blackjack.double");
    if (!sent) return;
    const view = sent.data.result.view;
    bj.doubled = true;
    bj.wager = view.wager;
    bj.player = view.player.map(toCard);
    NP.sound("card");
    renderHands();
    setStatus("Ставка удвоена. Одна карта — и ход дилеру.");
    await wait(600);
    await conclude(view, sent.data, sent.unlock);
  }

  /** Play back the server's finished round: dealer cards, then the result. */
  async function conclude(view, data, unlock) {
    bj.busy = true;
    bj.phase = "dealer";
    bj.player = view.player.map(toCard);
    bj.wager = view.wager;
    bj.doubled = view.doubled;
    const finalDealer = view.dealer.map(toCard);
    const outcome = view.outcome;
    updateControls();

    const dealtBlackjack = view.player.length === 2
      && finalDealer.length === 2
      && !view.doubled
      && (view.playerTotal === 21 || view.dealerTotal === 21);

    if (outcome === "bust") {
      bj.hidden = false;
      bj.dealer = finalDealer;
      renderHands();
      setStatus(`Перебор: ${view.playerTotal}. Дилер открывает карты…`, "lose");
      await wait(720);
    } else if (dealtBlackjack) {
      bj.hidden = false;
      bj.dealer = finalDealer;
      renderHands();
      await wait(760);
    } else {
      if (view.playerTotal === 21) {
        setStatus("Ровно 21! Передаём ход дилеру…");
        await wait(520);
      }
      bj.hidden = false;
      bj.dealer = finalDealer.slice(0, 2);
      renderHands();
      setStatus("Дилер открывает карты…");
      await wait(450);
      for (let index = 2; index < finalDealer.length; index += 1) {
        bj.dealer.push(finalDealer[index]);
        NP.sound("card");
        renderHands();
        setStatus(`Дилер добирает: ${handValue(bj.dealer).total}`);
        await wait(450);
      }
      await wait(240);
    }

    settle(view, data, unlock);
  }

  function settle(view, data, unlock) {
    if (bj.settled) return;
    bj.settled = true;
    bj.hidden = false;
    bj.phase = "done";
    bj.busy = false;

    const outcome = view.outcome;
    const wager = view.wager;
    const playerTotal = view.playerTotal;
    const dealerTotal = view.dealerTotal;
    const net = view.net;
    const money = NP.formatStars(Math.abs(net));
    let tone = "lose";
    let statusText = "";

    switch (outcome) {
      case "blackjack":
        tone = "win";
        statusText = `Блэкджек! +${money} ★`;
        break;
      case "win":
        tone = "win";
        statusText = `Вы выиграли ${playerTotal}:${dealerTotal} · +${money} ★`;
        break;
      case "dealerBust":
        tone = "win";
        statusText = `Перебор у дилера: ${dealerTotal} · +${money} ★`;
        break;
      case "push":
        tone = "push";
        statusText = `Ничья ${playerTotal}:${dealerTotal} · ставка возвращена`;
        break;
      case "bust":
        statusText = `Перебор ${playerTotal} · −${NP.formatStars(wager)} ★`;
        break;
      case "dealerBlackjack":
        statusText = `Блэкджек у дилера · −${NP.formatStars(wager)} ★`;
        break;
      default:
        statusText = `Дилер сильнее ${dealerTotal}:${playerTotal} · −${NP.formatStars(wager)} ★`;
    }

    NP.applyState(data.state);
    unlock();
    renderHands();
    setStatus(statusText, tone);

    if (outcome === "blackjack") {
      NP.sound("bigwin");
      NP.haptic("success");
      NP.confetti(60);
      NP.toast("Блэкджек!", `Выплата 6:5 · +${NP.formatStars(net)} звёзд.`);
    } else if (net > 0) {
      NP.sound("win");
      NP.haptic("success");
      NP.toast("Вы победили", `+${NP.formatStars(net)} звёзд.`);
    } else if (outcome === "push") {
      NP.sound("push");
    } else {
      NP.sound("lose");
      NP.haptic("error");
    }

    updateControls();
  }

  function chooseBet(value) {
    if (isPlaying()) return;
    const balance = NP.getState().balance;
    bj.bet = Math.max(MIN_BET, Math.min(balance, Math.round(value)));
    updateControls();
    NP.sound("click");
  }

  function halveBet() {
    if (isPlaying()) return;
    chooseBet(Math.floor(bj.bet / 2));
  }

  function doubleBet() {
    if (isPlaying()) return;
    chooseBet(bj.bet * 2);
  }

  function maxBet() {
    if (isPlaying()) return;
    const balance = NP.getState().balance;
    if (balance < MIN_BET) {
      NP.toast("Мало звёзд", "Пополните баланс или выберите ставку меньше.", "error");
      NP.openModal("modalTopup");
      return;
    }
    chooseBet(balance);
  }

  function init() {
    elements.dealerHand = document.getElementById("dealerHand");
    elements.playerHand = document.getElementById("playerHand");
    elements.dealerScore = document.getElementById("dealerScore");
    elements.playerScore = document.getElementById("playerScore");
    elements.status = document.getElementById("bjStatus");
    elements.actions = document.getElementById("bjActions");
    elements.hit = document.getElementById("bjHitBtn");
    elements.stand = document.getElementById("bjStandBtn");
    elements.double = document.getElementById("bjDoubleBtn");
    elements.deal = document.getElementById("bjDealBtn");
    elements.betAmount = document.getElementById("bjBetAmount");
    elements.betHalf = document.getElementById("bjBetHalf");
    elements.betDouble = document.getElementById("bjBetDouble");
    elements.betMax = document.getElementById("bjBetMax");
    if (!elements.deal) return;

    renderHands();
    updateControls();

    document.querySelectorAll("[data-bj-bet]").forEach((button) => {
      button.addEventListener("click", () => chooseBet(Number(button.dataset.bjBet)));
    });
    elements.deal.addEventListener("click", startRound);
    elements.hit?.addEventListener("click", hit);
    elements.stand?.addEventListener("click", stand);
    elements.double?.addEventListener("click", doubleDown);
    elements.betHalf?.addEventListener("click", halveBet);
    elements.betDouble?.addEventListener("click", doubleBet);
    elements.betMax?.addEventListener("click", maxBet);
    document.addEventListener("np:state", () => {
      restoreFromServer();
      updateControls();
    });
    document.addEventListener("np:navigate", (event) => {
      if (event.detail.view === "blackjack") updateControls();
    });
    restoreFromServer();
  }

  init();
})();

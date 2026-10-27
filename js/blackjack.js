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
    deck: [],
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

  function createDeck() {
    const deck = [];
    SUITS.forEach((suit) => {
      RANKS.forEach((rank) => deck.push({ rank, suit }));
    });
    for (let index = deck.length - 1; index > 0; index -= 1) {
      const swap = NP.randomInt(index + 1);
      [deck[index], deck[swap]] = [deck[swap], deck[index]];
    }
    return deck;
  }

  function drawCard(bias = false) {
    if (!bj.deck.length) bj.deck = createDeck();
    // Hidden house protection: a small share of player hits are replaced by
    // a ten-value card. The table and displayed rules stay unchanged.
    if (bias && NP.randomFloat() < 0.12) {
      const index = bj.deck.findIndex((card) => cardPoints(card) === 10);
      if (index >= 0) return bj.deck.splice(index, 1)[0];
    }
    return bj.deck.pop();
  }

  function cardPoints(card) {
    if (card.rank === "A") return 11;
    if (["K", "Q", "J"].includes(card.rank)) return 10;
    return Number(card.rank);
  }

  function handValue(hand) {
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
    element.className = `playing-card ${card.suit.color}${hidden ? " hidden-card" : ""}`;
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
      elements.deal.disabled = playing;
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

  function startRound() {
    if (isPlaying() || bj.busy) return;
    if (NP.getState().balance < bj.bet) {
      NP.toast("Мало звёзд", "Пополните баланс или выберите ставку меньше.", "error");
      NP.openModal("modalTopup");
      return;
    }

    bj.deck = createDeck();
    bj.player = [drawCard(), drawCard()];
    bj.dealer = [drawCard(), drawCard()];
    bj.hidden = true;
    bj.phase = "player";
    bj.wager = bj.bet;
    bj.settled = false;
    bj.busy = false;
    bj.doubled = false;

    NP.adjustBalance(-bj.bet, { animate: true });
    NP.sound("card");
    NP.haptic("light");
    renderHands();
    setStatus("Ваш ход: «Ещё», «Хватит» или «Удвоить»");
    updateControls();

    const playerTotal = handValue(bj.player).total;
    const dealerTotal = handValue(bj.dealer).total;

    if (playerTotal === 21 || dealerTotal === 21) {
      bj.busy = true;
      updateControls();
      window.setTimeout(() => {
        if (playerTotal === 21 && dealerTotal === 21) {
          settle("push");
        } else if (playerTotal === 21) {
          settle("blackjack");
        } else {
          settle("dealerBlackjack");
        }
      }, 760);
    }
  }

  function hit() {
    if (bj.phase !== "player" || bj.busy) return;
    bj.player.push(drawCard(true));
    NP.sound("card");
    NP.haptic("light");
    renderHands();

    const value = handValue(bj.player);
    if (value.total > 21) {
      bj.phase = "dealer";
      bj.busy = true;
      setStatus(`Перебор: ${value.total}. Дилер открывает карты…`, "lose");
      updateControls();
      bj.hidden = false;
      renderHands();
      window.setTimeout(() => settle("bust"), 720);
    } else if (value.total === 21) {
      bj.busy = true;
      setStatus("Ровно 21! Передаём ход дилеру…");
      updateControls();
      window.setTimeout(() => {
        bj.busy = false;
        stand();
      }, 520);
    } else {
      setStatus(`У вас ${value.total}. Ещё карту?`);
      updateControls();
    }
  }

  function shouldDealerHit(hand) {
    const value = handValue(hand);
    return value.total < 17 || (value.total === 17 && value.soft);
  }

  async function dealerTurn() {
    bj.phase = "dealer";
    bj.hidden = false;
    bj.busy = true;
    renderHands();
    updateControls();
    setStatus("Дилер открывает карты…");

    await wait(450);

    while (shouldDealerHit(bj.dealer)) {
      bj.dealer.push(drawCard());
      NP.sound("card");
      renderHands();
      setStatus(`Дилер добирает: ${handValue(bj.dealer).total}`);
      updateControls();
      await wait(450);
    }

    await wait(240);
    const playerTotal = handValue(bj.player).total;
    const finalDealer = handValue(bj.dealer).total;

    if (finalDealer > 21) settle("dealerBust");
    else if (playerTotal > finalDealer) settle("win");
    else if (playerTotal === finalDealer) settle("push");
    else settle("lose");
  }

  function stand() {
    if (bj.phase !== "player" || bj.busy) return;
    if (handValue(bj.player).total > 21) {
      settle("bust");
      return;
    }
    dealerTurn();
  }

  function doubleDown() {
    if (bj.phase !== "player" || bj.busy || bj.doubled || bj.player.length !== 2) return;
    if (NP.getState().balance < bj.bet) {
      NP.toast("Мало звёзд для удвоения", "Выберите меньшую ставку в следующем раунде.", "error");
      return;
    }

    bj.doubled = true;
    bj.wager += bj.bet;
    NP.adjustBalance(-bj.bet, { animate: true });
    bj.player.push(drawCard(true));
    NP.sound("card");
    renderHands();
    setStatus("Ставка удвоена. Одна карта — и ход дилеру.");
    updateControls();

    bj.hidden = false;
    bj.busy = true;
    updateControls();
    renderHands();

    window.setTimeout(() => {
      const total = handValue(bj.player).total;
      if (total > 21) {
        setStatus(`Перебор: ${total}`, "lose");
        window.setTimeout(() => settle("bust"), 500);
      } else {
        dealerTurn();
      }
    }, 600);
  }

  function settle(outcome) {
    if (bj.settled) return;
    bj.settled = true;
    bj.hidden = false;
    bj.phase = "done";
    bj.busy = false;

    const wager = bj.wager;
    const playerTotal = handValue(bj.player).total;
    const dealerTotal = handValue(bj.dealer).total;
    const blackjackProfit = Math.round(wager * 1.2);
    let payout = 0;
    let tone = "lose";
    let statusText = "";
    let detailText = "";

    switch (outcome) {
      case "blackjack":
        payout = wager + blackjackProfit;
        tone = "win";
        statusText = `Блэкджек! +${NP.formatStars(blackjackProfit)} ★`;
        detailText = "Блэкджек";
        break;
      case "win":
        payout = wager * 2;
        tone = "win";
        statusText = `Вы выиграли ${playerTotal}:${dealerTotal} · +${NP.formatStars(wager)} ★`;
        detailText = `${playerTotal}:${dealerTotal} в вашу пользу`;
        break;
      case "dealerBust":
        payout = wager * 2;
        tone = "win";
        statusText = `Перебор у дилера: ${dealerTotal} · +${NP.formatStars(wager)} ★`;
        detailText = `Перебор дилера ${dealerTotal}`;
        break;
      case "push":
        payout = wager;
        tone = "push";
        statusText = `Ничья ${playerTotal}:${dealerTotal} · ставка возвращена`;
        detailText = `Ничья ${playerTotal}:${dealerTotal} · возврат ставки`;
        break;
      case "bust":
        statusText = `Перебор ${playerTotal} · −${NP.formatStars(wager)} ★`;
        detailText = `Перебор ${playerTotal}`;
        break;
      case "dealerBlackjack":
        statusText = `Блэкджек у дилера · −${NP.formatStars(wager)} ★`;
        detailText = "Блэкджек у дилера";
        break;
      default:
        statusText = `Дилер сильнее ${dealerTotal}:${playerTotal} · −${NP.formatStars(wager)} ★`;
        detailText = `Дилер ${dealerTotal}:${playerTotal}`;
    }

    if (payout > 0) NP.adjustBalance(payout, { animate: true });
    renderHands();
    setStatus(statusText, tone);

    const net = payout - wager;
    NP.recordResult({
      game: "blackjack",
      title: "Блэкджек",
      detail: detailText,
      delta: net,
      wager
    });

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

    bj.busy = false;
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
    document.addEventListener("np:state", updateControls);
    document.addEventListener("np:navigate", (event) => {
      if (event.detail.view === "blackjack") updateControls();
    });
  }

  init();
})();

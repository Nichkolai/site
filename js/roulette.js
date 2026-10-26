/* =========================================================
   KAZ — American roulette (0 + 00)
   ========================================================= */
(() => {
  "use strict";

  const NP = window.NP;
  if (!NP) return;

  // 37 is the "00" pocket.
  const WHEEL_ORDER = [
    0, 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1, 37,
    27, 10, 25, 29, 12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2
  ];
  const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const SEGMENT = (Math.PI * 2) / WHEEL_ORDER.length;

  const roulette = {
    bets: {},
    betStack: [],
    denomination: 1,
    spinning: false,
    rotation: 0,
    last: []
  };

  const elements = {};
  let context = null;

  const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

  function isZero(number) {
    return number === 0 || number === 37;
  }

  function labelOf(number) {
    return number === 37 ? "00" : String(number);
  }

  function parseBetNumber(key) {
    if (key === "num:00") return 37;
    return Number(key.slice(4));
  }

  function colorOf(number) {
    if (isZero(number)) return "green";
    return RED_NUMBERS.has(number) ? "red" : "black";
  }

  function colorName(number) {
    if (isZero(number)) return "зеро";
    return RED_NUMBERS.has(number) ? "красное" : "чёрное";
  }

  function totalStake() {
    return Object.values(roulette.bets).reduce((sum, amount) => sum + amount, 0);
  }

  function compactChip(amount) {
    if (amount >= 1000) {
      const thousands = amount / 1000;
      return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
    }
    return String(amount);
  }

  function buildNumbers() {
    const container = document.getElementById("rouletteNumbers");
    if (!container) return;
    container.replaceChildren();
    for (let number = 1; number <= 36; number += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.bet = `num:${number}`;
      button.className = colorOf(number);
      button.textContent = String(number);
      button.setAttribute("aria-label", `Поставить на число ${number}`);
      container.append(button);
    }
  }

  function updateUI() {
    const stake = totalStake();
    const balance = NP.getState().balance;

    document.querySelectorAll("[data-bet]").forEach((button) => {
      const amount = roulette.bets[button.dataset.bet] || 0;
      button.classList.toggle("has-bet", amount > 0);
      if (amount > 0) button.dataset.chip = compactChip(amount);
      else button.removeAttribute("data-chip");
      button.disabled = roulette.spinning;
    });

    document.querySelectorAll(".roulette-chip").forEach((button) => {
      button.classList.toggle("is-active", Number(button.dataset.chip) === roulette.denomination);
      button.disabled = roulette.spinning;
    });

    if (elements.stake) elements.stake.textContent = NP.formatStars(stake);
    if (elements.spinSub) {
      elements.spinSub.textContent = stake ? `${NP.formatStars(stake)} ★` : "Ставок нет";
    }
    if (elements.spin) elements.spin.disabled = roulette.spinning || stake === 0 || stake > balance;
    if (elements.undo) elements.undo.disabled = roulette.spinning || roulette.betStack.length === 0;
    if (elements.clear) elements.clear.disabled = roulette.spinning || stake === 0;
    if (elements.spin) elements.spin.classList.toggle("spinning", roulette.spinning);
  }

  function placeBet(key) {
    if (roulette.spinning) return;
    const stake = totalStake();
    const balance = NP.getState().balance;
    if (stake + roulette.denomination > balance) {
      NP.toast("Мало звёзд", `На балансе ${NP.formatStars(balance)} ★.`, "error");
      return;
    }
    roulette.bets[key] = (roulette.bets[key] || 0) + roulette.denomination;
    roulette.betStack.push({ key, amount: roulette.denomination });
    updateUI();
    NP.sound("click");
    NP.haptic("light");
  }

  function undoBet() {
    if (roulette.spinning || !roulette.betStack.length) return;
    const last = roulette.betStack.pop();
    roulette.bets[last.key] = Math.max(0, (roulette.bets[last.key] || 0) - last.amount);
    if (!roulette.bets[last.key]) delete roulette.bets[last.key];
    updateUI();
    NP.sound("click");
  }

  function clearBets() {
    if (roulette.spinning) return;
    roulette.bets = {};
    roulette.betStack = [];
    updateUI();
    NP.sound("click");
  }

  function chooseChip(value) {
    if (roulette.spinning) return;
    roulette.denomination = value;
    updateUI();
    NP.sound("click");
  }

  /* ---------- Wheel rendering ---------- */
  function drawWheel(rotation = roulette.rotation) {
    if (!context) return;
    const size = 720;
    const center = size / 2;
    const outer = 350;
    const rim = 338;
    const pocket = 328;
    const labelRadius = 269;

    context.clearRect(0, 0, size, size);

    const outsideGradient = context.createRadialGradient(center, center, 180, center, center, outer);
    outsideGradient.addColorStop(0, "#2a2114");
    outsideGradient.addColorStop(0.72, "#15120c");
    outsideGradient.addColorStop(1, "#302416");
    context.beginPath();
    context.arc(center, center, outer, 0, Math.PI * 2);
    context.fillStyle = outsideGradient;
    context.fill();

    context.beginPath();
    context.arc(center, center, rim, 0, Math.PI * 2);
    context.lineWidth = 3;
    context.strokeStyle = "rgba(255, 207, 112, 0.4)";
    context.stroke();

    // Pockets.
    WHEEL_ORDER.forEach((number, index) => {
      const start = rotation + index * SEGMENT;
      const end = start + SEGMENT;
      context.beginPath();
      context.moveTo(center, center);
      context.arc(center, center, pocket, start, end);
      context.closePath();
      context.fillStyle = number === 0 || number === 37
        ? "#3f7d22"
        : RED_NUMBERS.has(number)
          ? "#a92f41"
          : "#181c22";
      context.fill();
      context.lineWidth = 1;
      context.strokeStyle = "rgba(255, 207, 112, 0.16)";
      context.stroke();
    });

    // Separators and studs.
    WHEEL_ORDER.forEach((number, index) => {
      const angle = rotation + index * SEGMENT;
      context.beginPath();
      context.moveTo(center + Math.cos(angle) * 84, center + Math.sin(angle) * 84);
      context.lineTo(center + Math.cos(angle) * (pocket - 2), center + Math.sin(angle) * (pocket - 2));
      context.strokeStyle = "rgba(255, 225, 170, 0.22)";
      context.lineWidth = 1;
      context.stroke();

      const studAngle = angle + SEGMENT / 2;
      const studX = center + Math.cos(studAngle) * (rim - 25);
      const studY = center + Math.sin(studAngle) * (rim - 25);
      context.beginPath();
      context.arc(studX, studY, 2.2, 0, Math.PI * 2);
      context.fillStyle = "rgba(255, 219, 151, 0.6)";
      context.fill();
    });

    // Labels.
    WHEEL_ORDER.forEach((number, index) => {
      const angle = rotation + (index + 0.5) * SEGMENT;
      const x = center + Math.cos(angle) * labelRadius;
      const y = center + Math.sin(angle) * labelRadius;
      context.save();
      context.translate(x, y);
      context.rotate(angle + Math.PI / 2);
      context.fillStyle = "rgba(255, 255, 255, 0.92)";
      context.font = `600 ${number === 37 ? 16 : 19}px "Segoe UI", system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(labelOf(number), 0, 0);
      context.restore();
    });

    // Inner rings.
    context.beginPath();
    context.arc(center, center, 96, 0, Math.PI * 2);
    context.fillStyle = "#0c0f0b";
    context.fill();
    context.lineWidth = 7;
    context.strokeStyle = "rgba(255, 207, 112, 0.22)";
    context.stroke();
    context.beginPath();
    context.arc(center, center, 77, 0, Math.PI * 2);
    context.lineWidth = 1;
    context.strokeStyle = "rgba(200, 255, 94, 0.15)";
    context.stroke();

    // Outer dots.
    for (let index = 0; index < 76; index += 1) {
      const angle = rotation + index * ((Math.PI * 2) / 76);
      const x = center + Math.cos(angle) * 346;
      const y = center + Math.sin(angle) * 346;
      context.beginPath();
      context.arc(x, y, index % 2 === 0 ? 1.7 : 1, 0, Math.PI * 2);
      context.fillStyle = index % 2 === 0 ? "rgba(200, 255, 94, 0.38)" : "rgba(255, 255, 255, 0.16)";
      context.fill();
    }

    // Ball under the pointer.
    const ballX = center;
    const ballY = center - (pocket - 17);
    context.save();
    context.shadowColor = "rgba(0, 0, 0, 0.55)";
    context.shadowBlur = 14;
    context.shadowOffsetY = 4;
    context.beginPath();
    context.arc(ballX, ballY, 9.5, 0, Math.PI * 2);
    context.fillStyle = "#f8f7ef";
    context.fill();
    context.restore();
    context.beginPath();
    context.arc(ballX - 2, ballY - 2, 3.2, 0, Math.PI * 2);
    context.fillStyle = "rgba(255, 255, 255, 0.92)";
    context.fill();
  }

  function easeOutQuint(value) {
    return 1 - Math.pow(1 - value, 5);
  }

  function animateWheel(targetRotation, duration = 4000) {
    return new Promise((resolve) => {
      const finish = () => {
        roulette.rotation = targetRotation % (Math.PI * 2);
        drawWheel(roulette.rotation);
        resolve();
      };

      if (document.hidden) {
        finish();
        return;
      }

      const startRotation = roulette.rotation;
      const startedAt = performance.now();
      const distance = targetRotation - startRotation;
      let finished = false;
      const watchdog = window.setTimeout(() => {
        if (finished) return;
        finished = true;
        finish();
      }, duration + 550);

      function frame(now) {
        if (finished) return;
        const progress = Math.min(1, (now - startedAt) / duration);
        roulette.rotation = startRotation + distance * easeOutQuint(progress);
        drawWheel(roulette.rotation);
        if (progress < 1) {
          requestAnimationFrame(frame);
        } else {
          finished = true;
          window.clearTimeout(watchdog);
          finish();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  function isWinningBet(key, number) {
    if (key.startsWith("num:")) return parseBetNumber(key) === number;
    if (isZero(number)) return false;
    switch (key) {
      case "red":
        return RED_NUMBERS.has(number);
      case "black":
        return !RED_NUMBERS.has(number);
      case "even":
        return number % 2 === 0;
      case "odd":
        return number % 2 !== 0;
      case "low":
        return number >= 1 && number <= 18;
      case "high":
        return number >= 19 && number <= 36;
      case "dozen:1":
        return number >= 1 && number <= 12;
      case "dozen:2":
        return number >= 13 && number <= 24;
      case "dozen:3":
        return number >= 25 && number <= 36;
      default:
        return false;
    }
  }

  function calculatePayout(number) {
    let payout = 0;
    Object.entries(roulette.bets).forEach(([key, amount]) => {
      if (!isWinningBet(key, number)) return;
      const straight = key.startsWith("num:");
      const dozen = key.startsWith("dozen:");
      payout += amount * (straight ? 36 : dozen ? 3 : 2);
    });
    return payout;
  }

  function renderLastNumbers() {
    if (!elements.last) return;
    elements.last.replaceChildren();
    if (!roulette.last.length) {
      const empty = document.createElement("i");
      empty.className = "empty";
      empty.textContent = "Пока пусто";
      elements.last.append(empty);
      return;
    }
    roulette.last.forEach((number) => {
      const item = document.createElement("i");
      item.className = colorOf(number);
      item.textContent = labelOf(number);
      elements.last.append(item);
    });
  }

  function showResult(number, payout, stake) {
    if (elements.resultNumber) {
      elements.resultNumber.textContent = labelOf(number);
      elements.resultNumber.className = `result-number ${colorOf(number)}`;
    }
    if (!elements.resultCopy) return;

    const parity = isZero(number) ? "зеро" : number % 2 === 0 ? "чётное" : "нечётное";
    const net = payout - stake;
    const summary = payout > 0
      ? `${colorName(number)} · ${parity}<strong>${net >= 0 ? `+${NP.formatStars(net)}` : `−${NP.formatStars(Math.abs(net))}`} ★</strong>`
      : `${colorName(number)} · ${parity}<strong>Ставка не сыграла</strong>`;
    elements.resultCopy.innerHTML = summary;
  }

  async function spinWheel() {
    if (roulette.spinning) return;
    const stake = totalStake();
    if (!stake) {
      NP.toast("Сначала сделайте ставку", "Выберите фишку и нажмите на поле.", "info");
      return;
    }
    if (NP.getState().balance < stake) {
      NP.toast("Мало звёзд", "Пополните демо-баланс.", "error");
      NP.openModal("modalTopup");
      return;
    }

    roulette.spinning = true;
    updateUI();
    NP.adjustBalance(-stake, { animate: true });
    NP.sound("roulette");
    NP.haptic("light");

    if (elements.resultNumber) {
      elements.resultNumber.textContent = "—";
      elements.resultNumber.className = "result-number";
    }
    if (elements.resultCopy) elements.resultCopy.textContent = "Колесо вращается…";

    const winnerIndex = NP.randomInt(WHEEL_ORDER.length);
    const winner = WHEEL_ORDER[winnerIndex];
    const targetBase = -Math.PI / 2 - (winnerIndex + 0.5) * SEGMENT;
    let turns = 6 + NP.randomInt(3);
    let target = targetBase + Math.PI * 2 * turns;
    while (target < roulette.rotation + Math.PI * 4) {
      turns += 1;
      target = targetBase + Math.PI * 2 * turns;
    }

    await animateWheel(target, 4100);
    await wait(180);

    const payout = calculatePayout(winner);
    if (payout > 0) NP.adjustBalance(payout, { animate: true });

    roulette.last.unshift(winner);
    roulette.last = roulette.last.slice(0, 10);
    renderLastNumbers();
    showResult(winner, payout, stake);

    const net = payout - stake;
    NP.recordResult({
      game: "roulette",
      title: "Рулетка",
      detail: `Выпало ${labelOf(winner)} · ${colorName(winner)} · ставка ${NP.formatStars(stake)}`,
      delta: net,
      wager: stake
    });

    if (payout > 0 && net > 0) {
      NP.sound(payout >= stake * 10 ? "bigwin" : "win");
      NP.haptic("success");
      if (payout >= stake * 10) NP.confetti(55);
      NP.toast("Выигрыш в рулетке", `+${NP.formatStars(net)} звёзд на баланс.`);
    } else if (payout === stake && stake > 0) {
      NP.sound("push");
    } else {
      NP.sound("lose");
      NP.haptic("error");
    }

    roulette.bets = {};
    roulette.betStack = [];
    roulette.spinning = false;
    updateUI();
  }

  function init() {
    const canvas = document.getElementById("rouletteWheel");
    if (!canvas) return;
    context = canvas.getContext("2d");

    elements.stake = document.getElementById("rouletteStake");
    elements.spin = document.getElementById("rouletteSpin");
    elements.spinSub = document.getElementById("rouletteSpinSub");
    elements.undo = document.getElementById("rouletteUndo");
    elements.clear = document.getElementById("rouletteClear");
    elements.resultNumber = document.getElementById("resultNumber");
    elements.resultCopy = document.getElementById("resultCopy");
    elements.last = document.getElementById("lastNumbers");

    buildNumbers();
    drawWheel(0);
    renderLastNumbers();
    updateUI();

    document.querySelector(".board-panel")?.addEventListener("click", (event) => {
      const chipButton = event.target.closest(".roulette-chip");
      if (chipButton) {
        chooseChip(Number(chipButton.dataset.chip));
        return;
      }
      const betButton = event.target.closest("[data-bet]");
      if (betButton) {
        placeBet(betButton.dataset.bet);
      }
    });

    elements.undo?.addEventListener("click", undoBet);
    elements.clear?.addEventListener("click", clearBets);
    elements.spin?.addEventListener("click", spinWheel);
    document.addEventListener("np:state", updateUI);
    document.addEventListener("np:navigate", (event) => {
      if (event.detail.view === "roulette") {
        updateUI();
        drawWheel(roulette.rotation);
      }
    });
  }

  init();
})();

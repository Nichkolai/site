/* =========================================================
   KAZ — Crash
   ========================================================= */
(() => {
  "use strict";

  const NP = window.NP;
  if (!NP) return;

  const BET_STEPS = [2, 5, 10, 25];
  const HOUSE_EDGE = 0.93;
  const MAX_CRASH = 50;
  const GROWTH = 0.22;

  const game = {
    bet: 2,
    phase: "idle",
    wager: 0,
    crashAt: 1,
    startedAt: 0,
    crashDuration: 0,
    timer: null,
    history: [],
    crashed: false
  };

  const elements = {
    canvas: null,
    multiplier: null,
    status: null,
    stage: null,
    action: null,
    bet: null,
    betDown: null,
    betUp: null,
    history: null
  };

  let context = null;

  function currentMultiplier(elapsed = performance.now() - game.startedAt) {
    return Math.exp(GROWTH * (Math.max(0, elapsed) / 1000));
  }

  function formatMultiplier(value) {
    return `${value.toFixed(2)}×`;
  }

  function generateCrashPoint() {
    const roll = NP.randomFloat();
    const raw = HOUSE_EDGE / Math.max(0.0001, 1 - roll);
    return Math.max(1, Math.min(MAX_CRASH, Math.round(raw * 100) / 100));
  }

  function updateUI() {
    const running = game.phase === "running";
    const elapsed = running ? performance.now() - game.startedAt : 0;
    const value = running ? currentMultiplier(elapsed) : game.phase === "done" ? game.crashAt : 1;

    if (elements.multiplier) elements.multiplier.textContent = formatMultiplier(value);
    if (elements.bet) elements.bet.textContent = NP.formatStars(game.bet);
    if (elements.betDown) elements.betDown.disabled = running || game.bet <= BET_STEPS[0];
    if (elements.betUp) elements.betUp.disabled = running || game.bet >= BET_STEPS[BET_STEPS.length - 1];

    if (elements.action) {
      elements.action.disabled = false;
      if (running) {
        elements.action.textContent = `Забрать ${NP.formatStars(Math.round(game.wager * value))} ★`;
      } else if (game.phase === "done") {
        elements.action.textContent = "Ещё раз";
      } else {
        elements.action.textContent = "Начать";
      }
    }

    if (elements.stage) {
      elements.stage.classList.toggle("hot", running && value >= 2);
      elements.stage.classList.toggle("crashed", game.crashed);
    }
  }

  function drawChart(value, elapsed, crashed = false) {
    if (!context || !elements.canvas) return;
    const width = elements.canvas.width;
    const height = elements.canvas.height;
    const pad = { top: 16, right: 10, bottom: 18, left: 34 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const windowMs = Math.max(3500, elapsed);
    const yMax = Math.max(2, value * 1.12);

    context.clearRect(0, 0, width, height);

    // Grid.
    context.lineWidth = 1;
    context.font = '500 11px "Segoe UI", system-ui, sans-serif';
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (let row = 0; row <= 3; row += 1) {
      const ratio = row / 3;
      const y = pad.top + plotHeight * ratio;
      const mark = yMax - (yMax - 1) * ratio;
      context.beginPath();
      context.moveTo(pad.left, y);
      context.lineTo(width - pad.right, y);
      context.strokeStyle = "rgba(255, 255, 255, 0.055)";
      context.stroke();
      context.fillStyle = "rgba(255, 255, 255, 0.28)";
      context.fillText(`${mark.toFixed(1)}×`, pad.left - 6, y);
    }

    // Curve.
    const points = [];
    const steps = Math.max(2, Math.ceil(Math.min(elapsed, windowMs) / 40));
    for (let index = 0; index <= steps; index += 1) {
      const t = (elapsed * index) / steps;
      const m = Math.exp(GROWTH * (t / 1000));
      const x = pad.left + (t / windowMs) * plotWidth;
      const y = pad.top + plotHeight - ((Math.min(m, yMax) - 1) / (yMax - 1)) * plotHeight;
      points.push([x, y]);
    }

    if (points.length > 1) {
      context.beginPath();
      context.moveTo(points[0][0], points[0][1]);
      points.slice(1).forEach(([x, y]) => context.lineTo(x, y));
      context.lineTo(points[points.length - 1][0], pad.top + plotHeight);
      context.lineTo(pad.left, pad.top + plotHeight);
      context.closePath();
      const fill = context.createLinearGradient(0, pad.top, 0, pad.top + plotHeight);
      fill.addColorStop(0, crashed ? "rgba(255, 93, 115, 0.2)" : "rgba(200, 255, 94, 0.18)");
      fill.addColorStop(1, "rgba(200, 255, 94, 0)");
      context.fillStyle = fill;
      context.fill();

      context.beginPath();
      context.moveTo(points[0][0], points[0][1]);
      points.slice(1).forEach(([x, y]) => context.lineTo(x, y));
      context.lineWidth = 2.5;
      context.strokeStyle = crashed ? "#ff8494" : "#c8ff5e";
      context.shadowColor = crashed ? "rgba(255, 93, 115, 0.5)" : "rgba(200, 255, 94, 0.55)";
      context.shadowBlur = 10;
      context.stroke();
      context.shadowBlur = 0;

      const [endX, endY] = points[points.length - 1];
      context.beginPath();
      context.arc(endX, endY, 4, 0, Math.PI * 2);
      context.fillStyle = crashed ? "#ff8494" : "#d8ff7b";
      context.fill();
    }
  }

  function renderHistory() {
    if (!elements.history) return;
    elements.history.replaceChildren();
    if (!game.history.length) {
      const empty = document.createElement("i");
      empty.textContent = "—";
      elements.history.append(empty);
      return;
    }
    game.history.slice(0, 10).forEach((point) => {
      const item = document.createElement("i");
      item.textContent = `×${point.toFixed(2)}`;
      if (point < 1.5) item.className = "low";
      else if (point >= 5) item.className = "high";
      elements.history.append(item);
    });
  }

  function startRound() {
    if (game.phase === "running") return;
    if (NP.getState().balance < game.bet) {
      NP.toast("Мало звёзд", "Пополните демо-баланс или выберите ставку меньше.", "error");
      NP.openModal("modalTopup");
      return;
    }

    game.phase = "running";
    game.crashed = false;
    game.wager = game.bet;
    game.crashAt = generateCrashPoint();
    game.startedAt = performance.now();
    game.crashDuration = game.crashAt <= 1.01
      ? 1
      : (Math.log(game.crashAt) / GROWTH) * 1000;

    NP.adjustBalance(-game.wager, { animate: true });
    NP.sound("spin");
    NP.haptic("light");
    if (elements.status) elements.status.textContent = "Множитель растёт. Забирайте вовремя.";
    drawChart(1, 0);
    updateUI();

    window.clearInterval(game.timer);
    game.timer = window.setInterval(tick, 40);
  }

  function tick() {
    if (game.phase !== "running") return;
    const elapsed = performance.now() - game.startedAt;
    if (elapsed >= game.crashDuration) {
      crash();
      return;
    }
    const value = currentMultiplier(elapsed);
    if (elements.multiplier) elements.multiplier.textContent = formatMultiplier(value);
    if (elements.action) {
      elements.action.textContent = `Забрать ${NP.formatStars(Math.round(game.wager * value))} ★`;
    }
    if (elements.stage) elements.stage.classList.toggle("hot", value >= 2);
    drawChart(value, Math.min(elapsed, game.crashDuration));
  }

  function stopTimer() {
    window.clearInterval(game.timer);
    game.timer = null;
  }

  function crash() {
    if (game.phase !== "running") return;
    stopTimer();
    game.phase = "done";
    game.crashed = true;
    const value = game.crashAt;

    if (elements.multiplier) elements.multiplier.textContent = formatMultiplier(value);
    if (elements.status) elements.status.textContent = `Краш на ${formatMultiplier(value)} · −${NP.formatStars(game.wager)} ★`;
    if (elements.stage) {
      elements.stage.classList.remove("hot");
      elements.stage.classList.add("crashed");
    }
    drawChart(value, game.crashDuration, true);

    game.history.unshift(value);
    game.history = game.history.slice(0, 10);
    renderHistory();

    NP.recordResult({
      game: "crash",
      title: "Краш",
      detail: `Краш на ${formatMultiplier(value)} · ставка ${NP.formatStars(game.wager)}`,
      delta: -game.wager,
      wager: game.wager
    });

    NP.sound("lose");
    NP.haptic("error");
    updateUI();
  }

  function cashOut(auto = false) {
    if (game.phase !== "running") return;
    const elapsed = performance.now() - game.startedAt;
    if (elapsed >= game.crashDuration) {
      crash();
      return;
    }

    stopTimer();
    const value = currentMultiplier(elapsed);
    const payout = Math.round(game.wager * value);
    const net = payout - game.wager;
    game.phase = "done";
    game.crashed = false;
    game.crashAt = value;

    NP.adjustBalance(payout, { animate: true });
    if (elements.multiplier) elements.multiplier.textContent = formatMultiplier(value);
    if (elements.status) {
      elements.status.textContent = `${auto ? "Авто-забрали" : "Забрали"} ${NP.formatStars(payout)} ★ · ${net >= 0 ? "+" : "−"}${NP.formatStars(Math.abs(net))}`;
    }
    if (elements.stage) elements.stage.classList.remove("hot");
    drawChart(value, elapsed);

    game.history.unshift(value);
    game.history = game.history.slice(0, 10);
    renderHistory();

    NP.recordResult({
      game: "crash",
      title: "Краш",
      detail: `Забрали на ${formatMultiplier(value)} · ставка ${NP.formatStars(game.wager)}`,
      delta: net,
      wager: game.wager
    });

    NP.sound("cash");
    NP.haptic("success");
    if (net >= game.wager * 3) NP.confetti(45);
    updateUI();
  }

  function handleAction() {
    if (game.phase === "running") cashOut(false);
    else startRound();
  }

  function changeBet(direction) {
    if (game.phase === "running") return;
    const currentIndex = BET_STEPS.indexOf(game.bet);
    const nextIndex = Math.min(
      BET_STEPS.length - 1,
      Math.max(0, (currentIndex === -1 ? 0 : currentIndex) + direction)
    );
    game.bet = BET_STEPS[nextIndex];
    updateUI();
    NP.sound("click");
  }

  function init() {
    elements.canvas = document.getElementById("crashCanvas");
    if (!elements.canvas) return;
    context = elements.canvas.getContext("2d");
    elements.multiplier = document.getElementById("crashMultiplier");
    elements.status = document.getElementById("crashStatus");
    elements.stage = document.querySelector(".crash-stage");
    elements.action = document.getElementById("crashAction");
    elements.bet = document.getElementById("crashBet");
    elements.betDown = document.getElementById("crashBetDown");
    elements.betUp = document.getElementById("crashBetUp");
    elements.history = document.getElementById("crashHistory");

    drawChart(1, 0);
    renderHistory();
    updateUI();

    elements.action?.addEventListener("click", handleAction);
    elements.betDown?.addEventListener("click", () => changeBet(-1));
    elements.betUp?.addEventListener("click", () => changeBet(1));

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && game.phase === "running") {
        cashOut(true);
      } else if (!document.hidden && game.phase === "running") {
        tick();
      }
    });

    document.addEventListener("np:state", updateUI);
    document.addEventListener("np:navigate", (event) => {
      if (event.detail.view === "crash" && game.phase !== "running") updateUI();
    });
  }

  init();
})();

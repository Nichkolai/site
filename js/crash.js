/* =========================================================
   KAZ — Crash
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
  const GROWTH = 0.22;
  // 50× is the highest crash point: ln(50) / 0.22 ≈ 17.8 s. The cap below is
  // a safety net so a lost poll can never leave the multiplier growing forever.
  const MAX_ROUND_MS = 20_000;

  const game = {
    bet: startingBet,
    phase: "idle",
    wager: 0,
    crashAt: 1,
    startedAt: 0,
    frozenElapsed: null,
    busy: false,
    polling: false,
    pollFailures: 0,
    connectionLost: false,
    settleAttempted: false,
    poller: null,
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
    betHalf: null,
    betDouble: null,
    betMax: null,
    history: null
  };

  let context = null;

  function currentMultiplier(elapsed = performance.now() - game.startedAt) {
    return Math.exp(GROWTH * (Math.max(0, elapsed) / 1000));
  }

  function formatMultiplier(value) {
    return `${value.toFixed(2)}×`;
  }

  /** Elapsed time shown on screen; frozen while a request is in flight or the connection is lost. */
  function displayElapsed() {
    if ((game.busy || game.connectionLost) && game.frozenElapsed != null) return game.frozenElapsed;
    return performance.now() - game.startedAt;
  }

  function updateUI() {
    const running = game.phase === "running";
    const elapsed = running ? displayElapsed() : 0;
    const value = running ? currentMultiplier(elapsed) : game.phase === "done" ? game.crashAt : 1;

    if (elements.multiplier) elements.multiplier.textContent = formatMultiplier(value);
    const balance = NP.getState().balance;
    if (elements.bet) elements.bet.textContent = NP.formatStars(game.bet);
    if (elements.betDown) elements.betDown.disabled = running || game.bet <= MIN_BET;
    if (elements.betUp) elements.betUp.disabled = running || game.bet >= balance;
    if (elements.betHalf) elements.betHalf.disabled = running || game.bet <= MIN_BET;
    if (elements.betDouble) elements.betDouble.disabled = running || game.bet >= balance;
    if (elements.betMax) elements.betMax.disabled = running || game.bet >= balance || balance < MIN_BET;

    if (elements.action) {
      elements.action.disabled = game.busy || game.connectionLost;
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
      fill.addColorStop(0, crashed ? "rgba(238, 107, 124, 0.12)" : "rgba(200, 241, 105, 0.1)");
      fill.addColorStop(1, "rgba(200, 241, 105, 0)");
      context.fillStyle = fill;
      context.fill();

      context.beginPath();
      context.moveTo(points[0][0], points[0][1]);
      points.slice(1).forEach(([x, y]) => context.lineTo(x, y));
      context.lineWidth = 2.5;
      context.strokeStyle = crashed ? "#ee6b7c" : "#c8f169";
      context.stroke();

      const [endX, endY] = points[points.length - 1];
      context.beginPath();
      context.arc(endX, endY, 4, 0, Math.PI * 2);
      context.fillStyle = crashed ? "#ee6b7c" : "#c8f169";
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

  const POLL_MS = 150;

  function describeError(error) {
    return error && error.message ? error.message : "Попробуйте ещё раз.";
  }

  function stopTimers() {
    window.clearInterval(game.timer);
    window.clearInterval(game.poller);
    game.timer = null;
    game.poller = null;
  }

  function runTimers() {
    window.clearInterval(game.timer);
    window.clearInterval(game.poller);
    game.timer = window.setInterval(tick, 40);
    game.poller = window.setInterval(poll, POLL_MS);
  }

  /** Rebuild a round that is still running on the server (e.g. after a reload). */
  function restoreFromServer() {
    const saved = NP.getState().active && NP.getState().active.crash;
    if (!saved || game.phase === "running" || game.busy) return;
    game.phase = "running";
    game.crashed = false;
    game.wager = saved.wager;
    game.frozenElapsed = null;
    game.pollFailures = 0;
    game.connectionLost = false;
    game.settleAttempted = false;
    game.startedAt = performance.now() - saved.elapsed;
    if (elements.stage) elements.stage.classList.remove("crashed");
    if (elements.status) elements.status.textContent = "Множитель растёт. Забирайте вовремя.";
    drawChart(currentMultiplier(saved.elapsed), saved.elapsed);
    updateUI();
    runTimers();
  }

  async function startRound() {
    if (game.phase === "running" || game.busy) return;
    if (NP.getState().balance < game.bet) {
      NP.toast("Мало звёзд", "Пополните баланс или выберите ставку меньше.", "error");
      NP.openModal("modalTopup");
      return;
    }

    game.busy = true;
    updateUI();
    const unlock = NP.lockSync();
    NP.adjustBalance(-game.bet, { animate: true });
    NP.sound("spin");
    NP.haptic("light");

    // The server picks the crash point and keeps it secret until the round
    // ends. The app only animates the growing multiplier.
    const sent = performance.now();
    let data;
    try {
      data = await NP.api("crash.start", { bet: game.bet });
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
    const received = performance.now();

    game.phase = "running";
    game.crashed = false;
    game.wager = data.result.wager;
    game.frozenElapsed = null;
    game.pollFailures = 0;
    game.connectionLost = false;
    game.settleAttempted = false;
    // Use the elapsed time from the committed state: it is measured right
    // before the response is serialized, so the local clock does not inherit
    // the Blob write latency.
    const active = data.state && data.state.active && data.state.active.crash;
    const serverElapsed = active && Number.isFinite(Number(active.elapsed))
      ? Math.max(0, Number(active.elapsed))
      : Math.max(0, Number(data.result.elapsed) || 0);
    game.startedAt = received - (received - sent) / 2 - serverElapsed;
    game.busy = false;
    NP.applyState(data.state);
    unlock();

    if (elements.status) elements.status.textContent = "Множитель растёт. Забирайте вовремя.";
    if (elements.stage) elements.stage.classList.remove("crashed");
    drawChart(1, 0);
    updateUI();
    runTimers();
  }

  function tick() {
    if (game.phase !== "running" || game.busy || game.connectionLost) return;
    const elapsed = performance.now() - game.startedAt;
    if (elapsed >= MAX_ROUND_MS) {
      // The server cannot keep a round running longer than 50×. If a poll was
      // lost, settle instead of animating forever. Try only once so a network
      // outage cannot turn this into a request storm.
      if (!game.settleAttempted) {
        game.settleAttempted = true;
        cashOut(true);
      }
      return;
    }
    const value = currentMultiplier(elapsed);
    if (elements.multiplier) elements.multiplier.textContent = formatMultiplier(value);
    if (elements.action && !game.busy) {
      elements.action.textContent = `Забрать ${NP.formatStars(Math.round(game.wager * value))} ★`;
    }
    if (elements.stage) elements.stage.classList.toggle("hot", value >= 2);
    drawChart(value, elapsed);
  }

  /** Ask the server whether the round has crashed yet. */
  async function poll() {
    if (game.phase !== "running" || game.polling || game.busy) return;
    game.polling = true;
    const sent = performance.now();
    let data;
    try {
      // A read-only poll should answer quickly. Do not let a hung request
      // keep the multiplier growing for the full 20 s API timeout.
      data = await NP.api("crash.poll", {}, { timeout: 6000 });
    } catch (error) {
      game.polling = false;
      if (game.phase !== "running") return;
      if (error.code === "no_round") {
        await roundEndedElsewhere();
        return;
      }
      game.pollFailures += 1;
      if (game.pollFailures >= 5 && !game.connectionLost) {
        game.connectionLost = true;
        game.frozenElapsed = performance.now() - game.startedAt;
        if (elements.status) {
          elements.status.textContent = "Связь с сервером нестабильна. Проверяем результат…";
        }
        updateUI();
      }
      return;
    }
    game.polling = false;
    const wasDisconnected = game.connectionLost;
    if (game.pollFailures > 0) game.pollFailures = 0;
    if (game.phase !== "running" || game.busy) return;

    const result = data.result;
    if (result.status === "crashed") {
      showCrash(result, data);
      return;
    }
    // Keep the local clock close to the server clock. The state's elapsed is
    // measured at response serialization, unlike result.elapsed which is
    // measured before the transaction commits.
    const active = data.state && data.state.active && data.state.active.crash;
    const serverElapsed = active && Number.isFinite(Number(active.elapsed))
      ? Math.max(0, Number(active.elapsed))
      : Math.max(0, Number(result.elapsed) || 0);
    const received = performance.now();
    const serverStart = received - (received - sent) / 2 - serverElapsed;
    if (Math.abs(serverStart - game.startedAt) > 80) game.startedAt = serverStart;

    if (wasDisconnected) {
      game.connectionLost = false;
      game.frozenElapsed = null;
      if (elements.status) elements.status.textContent = "Множитель растёт. Забирайте вовремя.";
      updateUI();
    }
  }

  async function roundEndedElsewhere() {
    stopTimers();
    game.phase = "done";
    game.crashed = true;
    game.frozenElapsed = null;
    game.connectionLost = false;
    await NP.refreshState(true);
    if (elements.status) elements.status.textContent = "Раунд завершён · результат в истории";
    updateUI();
  }

  function showCrash(result, data) {
    stopTimers();
    game.phase = "done";
    game.crashed = true;
    game.frozenElapsed = null;
    game.connectionLost = false;
    game.crashAt = result.crashAt;
    const value = result.crashAt;
    const duration = Math.log(Math.max(1.0001, value)) / GROWTH * 1000;

    if (elements.multiplier) elements.multiplier.textContent = formatMultiplier(value);
    if (elements.status) elements.status.textContent = `Краш на ${formatMultiplier(value)} · −${NP.formatStars(result.wager)} ★`;
    if (elements.stage) {
      elements.stage.classList.remove("hot");
      elements.stage.classList.add("crashed");
    }
    drawChart(value, duration, true);

    game.history.unshift(value);
    game.history = game.history.slice(0, 10);
    renderHistory();
    NP.applyState(data.state);

    NP.sound("lose");
    NP.haptic("error");
    updateUI();
  }

  async function cashOut(auto = false) {
    if (game.phase !== "running" || game.busy) return;
    game.frozenElapsed = performance.now() - game.startedAt;
    game.busy = true;
    if (elements.action) elements.action.disabled = true;
    const unlock = NP.lockSync();

    let data;
    try {
      data = await NP.api("crash.cashout");
    } catch (error) {
      unlock();
      game.busy = false;
      game.frozenElapsed = null;
      if (error.code === "no_round") await roundEndedElsewhere();
      else {
        NP.toast("Не удалось забрать", describeError(error), "error");
        updateUI();
      }
      return;
    }

    const result = data.result;
    game.busy = false;
    game.frozenElapsed = null;
    if (result.status === "crashed") {
      unlock();
      showCrash(result, data);
      return;
    }

    stopTimers();
    const value = result.multiplier;
    const net = result.net;
    game.phase = "done";
    game.crashed = false;
    game.crashAt = value;

    if (elements.multiplier) elements.multiplier.textContent = formatMultiplier(value);
    if (elements.status) {
      elements.status.textContent = `${auto ? "Авто-забрали" : "Забрали"} ${NP.formatStars(result.payout)} ★ · ${net >= 0 ? "+" : "−"}${NP.formatStars(Math.abs(net))}`;
    }
    if (elements.stage) elements.stage.classList.remove("hot");
    drawChart(value, Math.log(Math.max(1.0001, value)) / GROWTH * 1000);

    game.history.unshift(value);
    game.history = game.history.slice(0, 10);
    renderHistory();
    NP.applyState(data.state);
    unlock();

    NP.sound("cash");
    NP.haptic("success");
    if (net >= result.wager * 3) NP.confetti(45);
    updateUI();
  }

  function handleAction() {
    if (game.phase === "running") cashOut(false);
    else startRound();
  }

  function betOptions() {
    const balance = NP.getState().balance;
    const options = BET_STEPS.filter((value) => value <= balance);
    if (balance >= MIN_BET && !options.includes(balance)) options.push(balance);
    return options.sort((a, b) => a - b);
  }

  function setBet(value) {
    if (game.phase === "running") return;
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
    if (game.phase === "running") return;
    const balance = NP.getState().balance;
    if (balance < MIN_BET) {
      NP.toast("Мало звёзд", "Пополните баланс, чтобы продолжить.", "error");
      NP.openModal("modalTopup");
      return;
    }
    setBet(balance);
  }

  function changeBet(direction) {
    if (game.phase === "running") return;
    const options = betOptions();
    const next = direction > 0
      ? options.find((value) => value > game.bet)
      : [...options].reverse().find((value) => value < game.bet);
    if (!next) return;
    game.bet = next;
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
    elements.betHalf = document.getElementById("crashBetHalf");
    elements.betDouble = document.getElementById("crashBetDouble");
    elements.betMax = document.getElementById("crashBetMax");
    elements.history = document.getElementById("crashHistory");

    drawChart(1, 0);
    renderHistory();
    updateUI();

    elements.action?.addEventListener("click", handleAction);
    elements.betDown?.addEventListener("click", () => changeBet(-1));
    elements.betUp?.addEventListener("click", () => changeBet(1));
    elements.betHalf?.addEventListener("click", halveBet);
    elements.betDouble?.addEventListener("click", doubleBet);
    elements.betMax?.addEventListener("click", maxBet);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && game.phase === "running") {
        cashOut(true);
      } else if (!document.hidden && game.phase === "running") {
        tick();
      }
    });

    document.addEventListener("np:state", () => {
      restoreFromServer();
      updateUI();
    });
    document.addEventListener("np:navigate", (event) => {
      if (event.detail.view === "crash" && game.phase !== "running") updateUI();
    });
    restoreFromServer();
  }

  init();
})();

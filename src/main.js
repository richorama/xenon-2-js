import { loadAssets } from "./assets.js";
import { loadAssetBundle } from "./asset-bundle.js";
import { Game, TICK_RATE } from "./game.js";
import { Renderer } from "./renderer.js";
import { AmigaAudio } from "./amiga-audio.js";
import { ShopScreen } from "./shop-screen.js";

const $ = (id) => document.getElementById(id);
const canvas = $("game");
const overlay = $("overlay");
const launch = $("launch");
const bundlePath = document.querySelector('meta[name="xenon-assets"]')?.content;
const player = $("player");
const menu = $("menu-panel");
const menuChoices = [...menu.children];
const keys = new Set();
let game;
let renderer;
let shopScreen;
let accumulator = 0;
let previousTime;
let pointerTarget;
let canvasPointer;
let firePointer;
let diveRequested = false;
let scoreStep = 0;
let scoreConfirm = false;
let cheatsEnabled = false;
let bundledAudio;
const audio = new AmigaAudio({
  onState: updateSoundButton,
  loadTrack: bundlePath ? (name) => bundledAudio[name].slice().buffer : undefined,
});

function updateAudio() {
  audio.setActive(Boolean(game && !["ready", "menu", "paused"].includes(game.status) && !document.hidden));
}

function flushSoundRequests() {
  if (!game.sounds.length) return;
  updateAudio();
  audio.playFrame(game.sounds.splice(0));
}

function updateSoundButton() {
  const failed = audio.state === "error";
  $("sound").textContent = failed ? "AUDIO UNAVAILABLE" : !audio.enabled ? "SOUND OFF"
    : audio.state === "loading" ? "LOADING AUDIO" : "SOUND ON";
  $("sound").setAttribute("aria-pressed", String(audio.enabled && !failed));
  $("sound").title = failed ? audio.error.message
    : "Toggle recovered Amiga music and effects (M)";
}

function resumeSound() {
  updateAudio();
  void audio.unlock();
}

function toggleSound() {
  audio.setEnabled(!audio.enabled);
  if (audio.enabled) resumeSound();
}

function clearInput() {
  keys.clear();
  pointerTarget = undefined;
  canvasPointer = undefined;
  firePointer = undefined;
  diveRequested = false;
  scoreStep = 0;
  scoreConfirm = false;
}

function start(players = game?.playerCount, fromMenu = false) {
  if (!game || game.status === "score-entry") return;
  clearInput();
  game.start(1, players, fromMenu);
  shopScreen = undefined;
  lastStatus = undefined;
  audio.restart();
  void resumeSound();
  accumulator = 0;
  updateInterface();
  canvas.focus({ preventScroll: true });
}

function openMenu() {
  if (!game?.openMenu()) return;
  clearInput();
  accumulator = 0;
  updateInterface();
  canvas.focus({ preventScroll: true });
}

function activateMenu(selection) {
  if (selection === 2) toggleSound();
  else start(selection + 1, true);
}

function continueRun() {
  if (!game?.continueRun()) return;
  void resumeSound();
  clearInput();
  accumulator = 0;
  updateInterface();
  canvas.focus({ preventScroll: true });
}

function pause() {
  if (!game) return;
  clearInput();
  game.togglePause();
  accumulator = 0;
  updateInterface();
  if (game.status === "playing") canvas.focus({ preventScroll: true });
  if (game.status === "playing") void resumeSound();
}

async function toggleFullscreen() {
  if (!document.fullscreenEnabled || !player.requestFullscreen) return;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await player.requestFullscreen();
  } catch {
    $("fullscreen").textContent = "FULLSCREEN UNAVAILABLE";
    $("fullscreen").title = "Your browser could not switch fullscreen mode.";
  }
}

function updateFullscreenButton() {
  const supported = Boolean(document.fullscreenEnabled && player.requestFullscreen);
  const fullscreen = document.fullscreenElement === player;
  $("fullscreen").hidden = !supported;
  $("touch-exit-fullscreen").hidden = !fullscreen;
  $("fullscreen-help").hidden = !supported;
  $("fullscreen").textContent = fullscreen ? "EXIT FULLSCREEN" : "FULLSCREEN";
  $("fullscreen").setAttribute("aria-pressed", String(fullscreen));
  $("fullscreen").title = fullscreen ? "Exit fullscreen (F or Esc)" : "Enter fullscreen (F)";
  clearInput();
  if (game?.status === "playing") canvas.focus({ preventScroll: true });
}

document.addEventListener("fullscreenchange", updateFullscreenButton);
updateFullscreenButton();
$("fullscreen").addEventListener("click", toggleFullscreen);
$("touch-exit-fullscreen").addEventListener("click", toggleFullscreen);
launch.addEventListener("click", () => {
  if (game?.status === "ready") openMenu();
  else if (game?.status === "paused") pause();
  else if (["continue", "turn-ready"].includes(game?.status)) continueRun();
  else if (["shop", "gameover"].includes(game?.status)) return;
  else if (game?.closeScores()) updateInterface();
  else start();
});
for (const [index, button] of menuChoices.entries()) {
  button.addEventListener("focus", () => { if (game?.status === "menu") game.menuSelection = index; });
  button.addEventListener("click", () => activateMenu(index));
}
$("player-mode").addEventListener("click", () => start(game.playerCount === 1 ? 2 : 1));
$("high-scores").addEventListener("click", () => {
  if (!game?.showScores()) return;
  clearInput();
  accumulator = 0;
  updateInterface();
  canvas.focus({ preventScroll: true });
});
$("score-previous").addEventListener("click", () => { scoreStep = -1; });
$("score-next").addEventListener("click", () => { scoreStep = 1; });
$("score-confirm").addEventListener("click", () => { scoreConfirm = true; });
$("restart").addEventListener("click", () => start());
$("pause").addEventListener("click", pause);
$("sound").addEventListener("click", (event) => {
  toggleSound();
  if (event.detail && game?.status === "playing") canvas.focus({ preventScroll: true });
});
$("touch-dive").addEventListener("click", (event) => {
  diveRequested = true;
  if (event.detail && game?.status === "playing") canvas.focus({ preventScroll: true });
});
$("touch-fire").addEventListener("pointerdown", (event) => {
  firePointer = event.pointerId;
  event.currentTarget.setPointerCapture(event.pointerId);
  event.preventDefault();
});
for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
  $("touch-fire").addEventListener(name, (event) => {
    if (event.pointerId === firePointer) firePointer = undefined;
  });
}

function setPointer(event) {
  const rect = canvas.getBoundingClientRect();
  pointerTarget = {
    x: (event.clientX - rect.left) / rect.width * canvas.width,
    y: (event.clientY - rect.top) / rect.height * canvas.height + 12,
  };
}
canvas.addEventListener("pointerdown", (event) => {
  if (game?.status !== "playing" || canvasPointer !== undefined) return;
  canvas.focus({ preventScroll: true });
  canvasPointer = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  setPointer(event);
});
canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId === canvasPointer) setPointer(event);
});
for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
  canvas.addEventListener(name, (event) => {
    if (event.pointerId === canvasPointer) {
      pointerTarget = undefined;
      canvasPointer = undefined;
    }
  });
}

const gameKeys = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight",
]);
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.code === "F7" && ["ready", "menu"].includes(game?.status)) {
    event.preventDefault();
    if (!event.repeat) {
      cheatsEnabled = true;
      updateInterface();
    }
    return;
  }
  if (event.code === "KeyI" && cheatsEnabled && game?.status === "playing") {
    event.preventDefault();
    if (!event.repeat) {
      game.run.cheatInvulnerable = !game.run.cheatInvulnerable;
      updateInterface();
    }
    return;
  }
  if (game?.status === "menu") {
    const step = { ArrowUp: -1, KeyW: -1, ArrowDown: 1, KeyS: 1 }[event.code];
    if (step) {
      event.preventDefault();
      keys.add(event.code);
      if (!event.repeat) game.moveMenu(step);
      canvas.focus({ preventScroll: true });
      return;
    }
    if (["Space", "Enter"].includes(event.code) && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      if (!event.repeat) activateMenu(game.menuSelection);
      return;
    }
  }
  if (game?.status === "ready" && ["Space", "Enter"].includes(event.code)
    && (!(event.target instanceof HTMLButtonElement) || event.target === launch)) {
    event.preventDefault();
    if (!event.repeat) openMenu();
    return;
  }
  if (game?.status === "score-entry") {
    if (["ArrowLeft", "ArrowRight", "KeyA", "KeyD"].includes(event.code)) {
      event.preventDefault();
      keys.add(event.code);
      return;
    }
    if (["Space", "Enter"].includes(event.code) && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      if (!event.repeat) scoreConfirm = true;
      return;
    }
  }
  if (game?.status === "score-table" && ["Space", "Enter"].includes(event.code)
    && (!(event.target instanceof HTMLButtonElement) || event.target === launch)) {
    event.preventDefault();
    if (!event.repeat && game.closeScores()) updateInterface();
    return;
  }
  if (["continue", "turn-ready"].includes(game?.status) && ["Space", "Enter"].includes(event.code)
    && (!(event.target instanceof HTMLButtonElement) || event.target === launch)) {
    event.preventDefault();
    if (!event.repeat) continueRun();
    return;
  }
  if (game?.status === "shop") {
    const move = { ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
      ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1] }[event.code];
    if (move) {
      event.preventDefault();
      shopScreen.move(...move);
      canvas.focus({ preventScroll: true });
      renderShopControls();
      return;
    }
    if (!(event.target instanceof HTMLButtonElement) && ["Space", "Enter"].includes(event.code)) {
      event.preventDefault();
      if (!event.repeat) shopScreen.activate();
      renderShopControls();
      updateInterface();
      return;
    }
  }
  if (event.target instanceof HTMLButtonElement && ["Space", "Enter"].includes(event.code)) return;
  if (gameKeys.has(event.code) && game?.status === "playing") {
    event.preventDefault();
    if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
      if (!event.repeat) diveRequested = true;
    } else keys.add(event.code);
  }
  if (event.repeat) return;
  if (event.code === "Escape" && document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
    return;
  }
  if (event.code === "KeyF") {
    event.preventDefault();
    void toggleFullscreen();
  }
  if (event.code === "KeyP" || event.code === "Escape") pause();
  if (event.code === "KeyR") start();
  if (event.code === "KeyM") void toggleSound();
  if (event.code === "Enter" && game && !["playing", "dying", "ending", "stage-loading", "turn-over", "gameover"].includes(game.status)) {
    event.preventDefault();
    if (game.status === "paused") pause();
    else start();
  }
});
window.addEventListener("keyup", (event) => keys.delete(event.code));
window.addEventListener("blur", () => {
  clearInput();
  if (game?.status === "playing") pause();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInput();
    if (game?.status === "playing") pause();
  }
  updateAudio();
});

let lastStatus;
const overlayContent = {
  ready: ["XENON 2", "OPEN MENU"],
  "turn-ready": ["GET READY", "START TURN"],
  paused: ["PAUSED", "RESUME"],
  continue: ["CONTINUE GAME", "CONTINUE"],
  "score-table": ["HIGH SCORES", "BACK"],
  complete: ["XENON 2 COMPLETE", "PLAY AGAIN"],
};

function renderShopControls() {
  if (game.status !== "shop") return;
  for (const [index, button] of [...$("shop-hotspots").children].entries()) {
    const label = shopScreen.label(index);
    if (button.getAttribute("aria-label") !== label) {
      button.setAttribute("aria-label", label);
      button.title = label;
    }
    button.disabled = shopScreen.busy;
    const pressed = String(shopScreen.selection === index);
    if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
  }
  const message = `${shopScreen.message.replace(/\r/g, " ")}. ${game.credits} credits.`;
  if ($("shop-message").textContent !== message) $("shop-message").textContent = message;
}

function openShopScreen() {
  clearInput();
  shopScreen = new ShopScreen(game);
  $("shop-hotspots").replaceChildren(...Array.from({ length: 22 }, (_, index) => {
    const button = document.createElement("button");
    const x = 4 + (index < 20 ? index % 5 : index - 20) * 41;
    const y = index < 20 ? 4 + Math.floor(index / 5) * 41 : 168;
    button.type = "button";
    button.style.cssText = `left:${x / 3.2}%;top:${y / 2}%;width:10%;height:${index < 20 ? 18 : 12}%;`;
    button.addEventListener("focus", () => {
      if (!shopScreen.busy) shopScreen.selection = index;
    });
    button.addEventListener("click", () => {
      shopScreen.activate(index);
      renderShopControls();
      updateInterface();
      if (game.status === "playing") canvas.focus({ preventScroll: true });
    });
    return button;
  }));
  renderShopControls();
  canvas.focus({ preventScroll: true });
}

function updateInterface() {
  if (!game) return;
  if (game !== game.activeGame) {
    game = game.activeGame;
    clearInput();
    shopScreen = undefined;
    lastStatus = undefined;
  }
  const status = game.status;
  if (status === "menu") {
    for (const [index, button] of menuChoices.entries()) {
      const current = String(game.menuSelection === index);
      if (button.getAttribute("aria-current") !== current) button.setAttribute("aria-current", current);
    }
    const music = String(audio.enabled);
    if (menuChoices[2].getAttribute("aria-pressed") !== music) menuChoices[2].setAttribute("aria-pressed", music);
  }
  const cheatStatus = $("cheat-status");
  cheatStatus.hidden = !cheatsEnabled;
  const cheatText = game.run.cheatInvulnerable ? "CHEAT: INVULNERABLE" : "CHEATS ARMED - I: OFF";
  if (cheatStatus.textContent !== cheatText) cheatStatus.textContent = cheatText;
  const count = $("continue-count");
  if (status === "continue") {
    const text = `${game.continueTicks >> 3}. ${game.continues} ${game.continues === 1 ? "continue" : "continues"} left.`;
    if (count.textContent !== text) count.textContent = text;
  }
  const dive = $("touch-dive");
  dive.disabled = status !== "playing" || (!game.divePhase && !game.player.dives);
  const diveLabel = game.divePhase ? "SURFACE" : "DIVE";
  if (dive.textContent !== diveLabel) dive.textContent = diveLabel;
  $("touch-fire").disabled = status !== "playing";
  const scoreControls = $("score-controls");
  const enteringScore = status === "score-entry" && !game.runScreen.scoreHold;
  if (scoreControls.hidden === enteringScore) {
    scoreControls.hidden = !enteringScore;
    if (!enteringScore && scoreControls.contains(document.activeElement)) canvas.focus({ preventScroll: true });
  }
  const scoreStatus = $("score-status");
  const scoreText = enteringScore
    ? `Initial ${game.runScreen.initialIndex + 1} of 3: ${game.runScreen.art.alphabet[game.runScreen.letter]}`
    : status === "score-table" ? game.highScores.map(({ score, initials }, index) =>
      `${index + 1}. ${initials}: ${score}.`).join(" ") : "";
  if (scoreStatus.textContent !== scoreText) scoreStatus.textContent = scoreText;
  if (status === lastStatus) return;
  const leftShop = lastStatus === "shop";
  lastStatus = status;
  updateAudio();
  player.dataset.status = status;
  $("pause").disabled = !["playing", "paused"].includes(status);
  $("pause").textContent = status === "paused" ? "RESUME" : "PAUSE";
  $("restart").disabled = status === "score-entry";
  const atMenu = status === "ready";
  $("high-scores").hidden = !atMenu && status !== "menu";
  $("player-mode").hidden = !atMenu;
  $("player-mode").textContent = game.playerCount === 1 ? "TWO PLAYERS" : "ONE PLAYER";
  overlay.hidden = ["playing", "dying", "shop", "menu", "ending", "stage-loading", "score-entry", "turn-over", "gameover"].includes(status);
  overlay.classList.toggle("run-overlay", Boolean(game.runScreen));
  count.hidden = status !== "continue";
  $("shop-panel").hidden = status !== "shop";
  menu.hidden = status !== "menu";
  canvas.setAttribute("aria-label", status === "shop"
    ? "Colin's equipment shop. Arrows or WASD move selection; Enter or Space selects. Confirm a quote by selecting the item again or choosing Buy or Sell. Exit finishes selling, then leaves."
    : status === "ending" ? "Xenon 2 victory scene."
      : status === "continue" ? "Continue game. Press Enter or Space, or tap Continue."
      : status === "gameover" ? "Game over. Returning to the title screen."
      : status === "turn-over" ? `Player ${game.playerNumber}: game over.`
      : status === "stage-loading" ? `Loading stage ${game.stage}.`
      : status === "turn-ready" ? `Get ready, player ${game.playerNumber}. Press Enter or Space, or tap to start.`
      : status === "score-entry" ? "High score. Choose each initial with Left or Right and confirm with Enter or Space. On touch, tap the left or right third to change the letter, or the middle to confirm."
      : status === "score-table" ? "High scores. Press Enter, Space, or tap to go back."
      : status === "ready" ? "Xenon 2. Press Enter or Space, or tap the logo for the game menu."
      : status === "menu" ? "Game menu. Up or Down to select; Enter or Space confirms. You can also tap an option."
      : "Xenon 2. Move with arrows or WASD, fire with Space, dive or surface with Shift, pause with P, fullscreen with F.");
  if (status === "dying") clearInput();
  else if (status === "shop") openShopScreen();
  else if (status === "score-entry" || status === "turn-ready") {
    clearInput();
    canvas.focus({ preventScroll: true });
  }
  else if (status === "ending") {
    clearInput();
    shopScreen = new ShopScreen(game);
  } else if (status === "playing") {
    shopScreen = undefined;
    if (leftShop) canvas.focus({ preventScroll: true });
  }
  if (overlayContent[status]) {
    const [title, button] = overlayContent[status];
    $("overlay-title").textContent = title;
    launch.textContent = button;
    launch.disabled = false;
  }
}

let paintedLoadingScreen;
function animate(time) {
  const elapsed = previousTime === undefined ? 0 : Math.min(0.1, (time - previousTime) / 1000);
  previousTime = time;
  if (game?.status === "stage-loading" && game.runScreen !== paintedLoadingScreen) {
    accumulator = 0;
  } else if (game && (["playing", "dying", "continue"].includes(game.status) || game.animateRunScreen)) {
    accumulator += elapsed;
    while (accumulator >= 1 / TICK_RATE) {
      const loading = game.status === "stage-loading";
      game.update({
        left: keys.has("ArrowLeft") || keys.has("KeyA"),
        right: keys.has("ArrowRight") || keys.has("KeyD"),
        up: keys.has("ArrowUp") || keys.has("KeyW"),
        down: keys.has("ArrowDown") || keys.has("KeyS"),
        fire: keys.has("Space") || canvasPointer !== undefined || firePointer !== undefined,
        dive: diveRequested,
        target: pointerTarget,
        scoreStep,
        confirm: scoreConfirm,
        music: audio.enabled,
      });
      flushSoundRequests();
      diveRequested = false;
      scoreStep = 0;
      scoreConfirm = false;
      accumulator -= 1 / TICK_RATE;
      if (loading || game.status === "stage-loading") {
        accumulator = 0;
        break;
      }
    }
  } else if (game?.status === "shop" || game?.status === "ending") {
    const status = game.status;
    accumulator += elapsed;
    while (accumulator >= 1 / TICK_RATE) {
      shopScreen?.update();
      flushSoundRequests();
      if (game.status !== status) {
        accumulator = 0;
        break;
      }
      accumulator -= 1 / TICK_RATE;
    }
  } else accumulator = 0;
  if (game) {
    updateAudio();
    flushSoundRequests();
    updateInterface();
    if (game.status === "shop") {
      renderer.drawShop(shopScreen);
      renderShopControls();
    } else if (game.status === "ending") {
      renderer.drawShop(shopScreen);
    } else renderer.draw(game);
    paintedLoadingScreen = game.status === "stage-loading" ? game.runScreen : undefined;
  }
  requestAnimationFrame(animate);
}

try {
  const progress = (loaded, total) => {
    $("load-count").textContent = `${loaded} / ${total}`;
  };
  let assets;
  if (bundlePath) {
    progress(0, 1);
    ({ assets, audio: bundledAudio } = await loadAssetBundle(new URL(bundlePath, document.baseURI)));
    progress(1, 1);
  } else assets = await loadAssets(progress);
  renderer = new Renderer(canvas, assets);
  game = new Game(assets);
  game.openAttract();
  // A read-only observation surface for browser checks and reverse-engineering.
  Object.defineProperty(window, "xenon", {
    value: Object.freeze({ snapshot: () => game.snapshot() }),
  });
  updateInterface();
  requestAnimationFrame(animate);
} catch (error) {
  $("overlay-title").textContent = "UNABLE TO START";
  $("load-error").hidden = false;
  $("load-error").textContent = bundlePath
    ? `${error.message}. Keep the game asset bundle beside index.html and serve the folder over HTTP.`
    : `${error.message}. Run npm start from this folder, then open the printed local URL. Keep the original game data files in place.`;
  launch.hidden = true;
  console.error(error);
}

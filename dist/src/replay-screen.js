import { loadAssets } from "./assets.js";
import { Renderer } from "./renderer.js";
import { GameReplay, parseRecording } from "./replay.js";

const canvas = document.getElementById("game");
const fileInput = document.getElementById("recording");
const play = document.getElementById("play");
const restart = document.getElementById("restart");
const status = document.getElementById("replay-status");
const errorMessage = document.getElementById("replay-error");
let assets, renderer, replay;
let playing = false;
let previousTime;
let accumulator = 0;

function draw() {
  if (replay.shopScreen) renderer.drawShop(replay.shopScreen);
  else renderer.draw(replay.game);
}

function update() {
  play.disabled = !replay || replay.done || !errorMessage.hidden;
  restart.disabled = !replay;
  play.textContent = playing ? "PAUSE" : "PLAY";
  if (!replay) return;
  const { tickRate } = replay.recording;
  const input = Object.entries(replay.input).filter(([name, pressed]) => name === "activate" || pressed)
    .map(([name, value]) => name === "activate" ? `SHOP BUTTON ${value}` : name.toUpperCase());
  status.textContent = `${replay.done ? "Finished" : playing ? "Playing" : "Paused"}: `
    + `tick ${replay.elapsedTicks} / ${replay.totalTicks} `
    + `(${(replay.elapsedTicks / tickRate).toFixed(2)} / ${(replay.totalTicks / tickRate).toFixed(2)} seconds)`
    + (input.length ? ` - ${input.join(" + ")}` : "");
}

function pause() {
  playing = false;
  previousTime = undefined;
  accumulator = 0;
  update();
}

function fail(error) {
  errorMessage.textContent = error.message;
  errorMessage.hidden = false;
  pause();
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  pause();
  fileInput.disabled = true;
  try {
    const candidate = new GameReplay(assets, parseRecording(await file.text()));
    replay = candidate;
    errorMessage.hidden = true;
    draw();
    update();
  } catch (error) {
    fail(error);
  } finally {
    fileInput.disabled = false;
  }
});

play.addEventListener("click", () => {
  if (playing) pause();
  else {
    playing = true;
    previousTime = undefined;
    accumulator = 0;
    update();
  }
});

restart.addEventListener("click", () => {
  pause();
  try {
    replay.reset();
    errorMessage.hidden = true;
    draw();
    update();
  } catch (error) {
    fail(error);
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
});

function animate(time) {
  const elapsed = previousTime === undefined ? 0 : Math.min(0.25, (time - previousTime) / 1000);
  previousTime = time;
  if (playing) {
    accumulator += elapsed * replay.recording.tickRate;
    try {
      while (accumulator >= 1 && !replay.done) {
        replay.advance();
        accumulator--;
      }
      draw();
      if (replay.done) pause();
      else update();
    } catch (error) {
      fail(error);
    }
  }
  requestAnimationFrame(animate);
}

try {
  assets = await loadAssets();
  renderer = new Renderer(canvas, assets);
  fileInput.disabled = false;
  status.textContent = "Choose an actions.jsonl recording, then press Play.";
  requestAnimationFrame(animate);
} catch (error) {
  fail(error);
  status.textContent = "Unable to load the local DOS game files.";
}

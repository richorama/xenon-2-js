import { TICK_RATE } from "./game.js";
import { HeadlessGame, validateAction, validateStep } from "./headless.js";

export function parseRecording(text) {
  const records = text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      throw new Error(`Invalid recording JSON on line ${index + 1}.`);
    }
  });
  const [header, ...actions] = records;
  if (!header || header.type !== "start") throw new Error("Recording must begin with a start record.");
  if ((header.format !== undefined || header.version !== undefined)
    && (header.format !== "xenon2-actions" || ![1, 2].includes(header.version))) {
    throw new Error("Unsupported recording format or version.");
  }
  const tickRate = header.tickRate ?? header.observation?.tickRate;
  if (tickRate !== TICK_RATE) throw new Error("Recording tick rate does not match this game version.");
  if (!Number.isInteger(header.stage) || header.stage < 1 || header.stage > 5
    || !Number.isInteger(header.seed) || header.seed < 0 || header.seed > 65535) {
    throw new Error("Recording has an invalid stage or seed.");
  }
  if (header.observation?.elapsedTicks !== 0) throw new Error("Recording must start at tick zero.");
  if (header.decisionTicks !== undefined) validateAction({}, header.decisionTicks);
  let totalTicks = 0;
  for (const [index, action] of actions.entries()) {
    if (!action || action.type !== "step") throw new Error(`Invalid action record ${index + 1}.`);
    (header.version === 2 ? validateStep : validateAction)(action.input, action.ticksRequested);
    if (!Number.isInteger(action.ticksAdvanced) || action.ticksAdvanced < 0
      || action.ticksAdvanced > action.ticksRequested) {
      throw new Error(`Invalid executed tick count in action ${index + 1}.`);
    }
    totalTicks += action.ticksAdvanced;
    if (action.observation?.elapsedTicks !== totalTicks) {
      throw new Error(`Recording timeline is inconsistent at action ${index + 1}.`);
    }
  }
  return { header, actions, tickRate, totalTicks };
}

function comparableState(observation, lifecycle) {
  const { elapsedTicks, status, stage, score, credits, camera, player } = observation;
  return [elapsedTicks, status, stage, score, credits, camera,
    player?.x, player?.y, player?.health, player?.lives, player?.diving,
    ...(lifecycle ? [player, observation.life, observation.continues, observation.continueTicks,
      observation.campaignRound, observation.shop] : [])];
}

export class GameReplay {
  constructor(assets, recording) {
    this.assets = assets;
    this.recording = recording;
    this.reset();
  }

  get game() { return this.session.game; }
  get shopScreen() { return this.session.shopScreen; }
  get elapsedTicks() { return this.session.elapsedTicks; }
  get totalTicks() { return this.recording.totalTicks; }
  get done() { return this.actionIndex === this.recording.actions.length; }

  reset() {
    const { stage, seed, observation } = this.recording.header;
    this.session = new HeadlessGame(this.assets, { stage, seed, lifecycle: this.recording.header.version === 2 });
    this.actionIndex = 0;
    this.actionTick = 0;
    this.input = {};
    this.checkState(observation);
    this.finishActions();
  }

  checkState(expected) {
    const lifecycle = this.recording.header.version === 2;
    if (JSON.stringify(comparableState(this.session.observe(), lifecycle)) !== JSON.stringify(comparableState(expected, lifecycle))) {
      throw new Error(`Replay diverged at tick ${this.elapsedTicks}. Use the same game code and assets as the recording.`);
    }
  }

  finishActions() {
    while (!this.done) {
      const action = this.recording.actions[this.actionIndex];
      if (this.actionTick !== action.ticksAdvanced) break;
      this.checkState(action.observation);
      this.actionIndex++;
      this.actionTick = 0;
    }
  }

  advance() {
    if (this.done) return false;
    const action = this.recording.actions[this.actionIndex];
    this.input = { ...action.input };
    if (this.actionTick > 0) {
      if (Object.hasOwn(this.input, "dive")) this.input.dive = false;
      if (Object.hasOwn(this.input, "confirm")) this.input.confirm = false;
      delete this.input.activate;
    }
    const status = this.game.status;
    const result = this.session.step(this.input, 1);
    this.actionTick++;
    if (result.ticksAdvanced !== 1 || this.game.status !== status && this.actionTick < action.ticksAdvanced) {
      throw new Error(`Replay ended an action unexpectedly at tick ${this.elapsedTicks}.`);
    }
    this.finishActions();
    return true;
  }
}

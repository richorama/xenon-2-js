import { Game, PLAY_HEIGHT, START_CAMERA, TICK_RATE } from "./game.js";
import { price, purchaseProblem, salePrice } from "./shop.js";
import { ShopScreen } from "./shop-screen.js";

export const MAX_ACTION_TICKS = 120;
export const DEFAULT_DECISION_TICKS = 4;
export function compareProgress(a, b) {
  for (const key of ["campaignRound", "stage", "progress"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  return 0;
}

const buttons = new Set(["left", "right", "up", "down", "fire", "dive"]);
const visible = (box) => box && box.w > 0 && box.h > 0
  && box.x < 320 && box.x + box.w > 0 && box.y < PLAY_HEIGHT && box.y + box.h > 0;

export function validateAction(input, ticks) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.entries(input).some(([key, value]) => !buttons.has(key) || typeof value !== "boolean")) {
    throw new Error("Input must contain only boolean left, right, up, down, fire and dive buttons.");
  }
  if (input.left && input.right || input.up && input.down) {
    throw new Error("Opposite directions cannot be pressed together.");
  }
  if (!Number.isInteger(ticks) || ticks < 1 || ticks > MAX_ACTION_TICKS) {
    throw new Error(`Action ticks must be an integer from 1 to ${MAX_ACTION_TICKS}.`);
  }
}

export function validateStep(input, ticks) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return validateAction(input, ticks);
  if (input && Object.hasOwn(input, "activate")) {
    validateAction({}, ticks);
    if (Object.keys(input).length !== 1 || !Number.isInteger(input.activate)
      || input.activate < 0 || input.activate > 21) {
      throw new Error("Shop activation must contain only an activate index from 0 to 21.");
    }
  } else if (input && Object.hasOwn(input, "confirm")) {
    validateAction({}, ticks);
    if (Object.keys(input).length !== 1 || typeof input.confirm !== "boolean") {
      throw new Error("Menu confirmation must contain only a boolean confirm.");
    }
  } else validateAction(input, ticks);
}

export function validateShopAction(action) {
  const fields = { buy: ["action", "id"], sell: ["action", "slot"], more: ["action"], exit: ["action"] };
  const expected = action && typeof action === "object" && !Array.isArray(action)
    && Object.hasOwn(fields, action.action) && fields[action.action];
  if (!expected || Object.keys(action).length !== expected.length
    || expected.some((key) => !Object.hasOwn(action, key))
    || action.action === "buy" && (!Number.isInteger(action.id) || action.id < 2 || action.id > 25)
    || action.action === "sell" && (!Number.isInteger(action.slot) || action.slot < 0 || action.slot > 6)) {
    throw new Error("Shop action must be buy with an item id, sell with a mount slot, more, or exit.");
  }
}

export function performShopAction(run, action) {
  validateShopAction(action);
  const before = run.observe().observation;
  if (before.status !== "shop" || !before.shop?.legalActions.some((legal) =>
    Object.keys(legal).every((key) => legal[key] === action[key]))) {
    throw new Error("Shop action is not currently available; simulation was not advanced.");
  }
  let ticksAdvanced = 0;
  const step = (input) => { ticksAdvanced += run.step(input, 1).ticksAdvanced; };
  const settle = () => {
    for (let ticks = 0; ticks < 2000; ticks++) {
      const { observation } = run.observe();
      if (observation.status !== "shop" || !observation.shop.busy) return;
      step({});
    }
    throw new Error("Shop animation did not settle within 2000 ticks.");
  };
  if (action.action === "exit" || action.action === "more") {
    step({ activate: action.action === "exit" ? 20 : 19 });
  } else {
    const offer = before.shop.offers.find((item) =>
      action.action === "buy" ? item.id === action.id : item.slot === action.slot);
    // A low-level controller may already have selected and quoted this item.
    if (before.shop.quotedIndex !== offer.index) {
      step({ activate: offer.index });
      settle();
    }
    step({ activate: 21 });
  }
  settle();
  return { ticksAdvanced, ...run.observe() };
}

export class HeadlessGame {
  constructor(assets, { stage = 1, seed = 0x5845, lifecycle = true } = {}) {
    if (!Number.isInteger(stage) || stage < 1 || stage > 5) {
      throw new Error("Stage must be an integer from 1 to 5.");
    }
    if (!Number.isInteger(seed) || seed < 0 || seed > 65535) {
      throw new Error("Seed must be an integer from 0 to 65535.");
    }
    this.game = new Game(assets);
    this.game.start(stage);
    this.game.seed = seed;
    this.lifecycle = lifecycle;
    this.life = 0;
    this.elapsedTicks = 0;
    this.ids = new WeakMap();
    this.nextId = 1;
    this.energyLost = 0;
    this.game.onHealthLost = (amount) => { this.energyLost += amount; };
    this.pickupOutcomes = [];
    this.game.onPickupResolved = (pickup, collected) => {
      if (!this.ids.has(pickup)) return;
      this.pickupOutcomes.push({
        id: this.ids.get(pickup), kind: pickup.kind, collected,
        x: pickup.x, worldY: this.game.camera + pickup.y, elapsedTicks: this.elapsedTicks + 1,
        stage: this.game.stage, campaignRound: this.game.campaignRound, life: this.life,
      });
      if (this.pickupOutcomes.length > 32) this.pickupOutcomes.shift();
    };
    this.recordProgress();
  }

  recordProgress() {
    const { campaignRound, stage } = this.game;
    const progress = (START_CAMERA - this.game.camera) / START_CAMERA;
    const position = { campaignRound, stage, progress, elapsedTicks: this.elapsedTicks };
    if (!this.furthestProgress || compareProgress(position, this.furthestProgress) > 0) this.furthestProgress = position;
    this.maxProgressStallTicks = Math.max(this.maxProgressStallTicks ?? 0, this.elapsedTicks - this.furthestProgress.elapsedTicks);
  }

  get canStep() {
    return ["playing", "dying"].includes(this.game.status) || this.lifecycle
      && ["shop", "ending", "stage-loading", "turn-ready", "score-entry", "continue"].includes(this.game.status);
  }

  syncScreen() {
    const status = this.game.status;
    if (this.lifecycle && ["shop", "ending"].includes(status)) {
      if (this.screenStatus !== status) this.shopScreen = new ShopScreen(this.game);
      this.screenStatus = status;
    } else {
      this.shopScreen = undefined;
      this.screenStatus = undefined;
    }
  }

  step(input = {}, ticks = 1, afterTick = () => {}) {
    validateStep(input, ticks);
    const status = this.game.status;
    if (Object.hasOwn(input, "activate") && (!this.shopScreen || status !== "shop" || this.shopScreen.busy)) {
      throw new Error("Shop controls require an idle shop.");
    }
    if (Object.hasOwn(input, "confirm") && (!this.lifecycle
      || !["turn-ready", "continue", "score-entry"].includes(status))) {
      throw new Error("Confirm requires Get Ready, continue or high-score entry.");
    }
    if (this.lifecycle && !["playing", "dying"].includes(status) && [...buttons].some((button) => input[button])) {
      throw new Error("Flight controls require playing or dying.");
    }
    let ticksAdvanced = 0;
    while (ticksAdvanced < ticks && this.canStep) {
      const first = ticksAdvanced === 0;
      if (this.shopScreen) {
        if (first && Object.hasOwn(input, "activate")) this.shopScreen.activate(input.activate);
        this.shopScreen.update();
      } else if (first && input.confirm && ["turn-ready", "continue"].includes(status)) {
        this.game.continueRun();
      } else {
        // Dive and confirmation are presses, not held keys.
        this.game.update({ ...input, dive: Boolean(input.dive && first), confirm: Boolean(input.confirm && first) });
      }
      if (status === "dying" && this.game.status !== status) this.life++;
      this.syncScreen();
      this.game.sounds.length = 0;
      this.elapsedTicks++;
      this.recordProgress();
      ticksAdvanced++;
      afterTick(this.game);
      if (this.game.status !== status) break;
    }
    return { ticksAdvanced, observation: this.observe() };
  }

  observeShop() {
    const screen = this.shopScreen;
    if (this.game.status !== "shop" || !screen) return;
    const offers = screen.slots.flatMap(({ id, slot, power }, index) => {
      if (id < 2 || id > 25) return [];
      const item = screen.item(id);
      return [{
        index, id, name: item.name,
        ...(screen.phase === "sell"
          ? { slot, upgradeLevel: power, price: salePrice(item, { power }), problem: "" }
          : { price: price(item, this.game.stage), mounts: item.mounts, problem: purchaseProblem(this.game, item) }),
      }];
    });
    const canPage = screen.slots[19].id === 27;
    return {
      phase: screen.phase, busy: screen.busy, page: screen.page,
      budget: this.game.shopBudget, nextStage: this.game.shopStage,
      quotedIndex: screen.quote?.index ?? null, offers, canPage,
      legalActions: screen.busy ? [] : [
        ...offers.filter(({ problem }) => !problem).map(({ id, slot }) =>
          screen.phase === "sell" ? { action: "sell", slot } : { action: "buy", id }),
        ...(canPage ? [{ action: "more" }] : []), { action: "exit" },
      ],
    };
  }

  observeBoss() {
    const game = this.game, boss = game.boss;
    if (game.stage !== 1 || !boss || boss.dead || game.camera >= 0x280) return;
    const bounds = { x: 112, y: boss.motion.y, w: 96, h: Math.ceil(boss.definition.tiles.length / 6) * 16 };
    if (!visible(bounds)) return;
    const weakPoint = boss.phase ? { x: 152, y: boss.weakY, w: 16, h: 14 } : null;
    return {
      kind: "stage-one-boss", bounds,
      contactBounds: visible(boss.bodyBox) ? { ...boss.bodyBox } : null,
      weakPoint: visible(weakPoint) ? weakPoint : null,
    };
  }

  entity(actor, bounds, kind) {
    if (actor.dead || actor.hidden || actor.drawMode === "hidden" || !visible(bounds)) return;
    if (!this.ids.has(actor)) this.ids.set(actor, this.nextId++);
    return { id: this.ids.get(actor), kind, bounds: { ...bounds } };
  }

  observe() {
    const game = this.game;
    const boss = this.observeBoss();
    const enemies = [];
    for (const actor of new Set(game.targets)) {
      if (actor.dead || actor.hidden || actor.drawMode === "hidden") continue;
      const entity = this.entity(actor, game.targetBounds(actor),
        actor.definition?.kind ?? (actor.type === 0 ? "supply-pod" : actor.boss ? "boss" : actor.terrainWorm ? "worm" : "enemy"));
      if (entity) enemies.push(entity);
    }
    const bullets = [];
    for (const actor of game.bullets) {
      const bounds = actor.beamLength !== undefined
        ? { x: actor.x, y: actor.y, w: 12, h: actor.beamLength }
        : actor.foreground ? game.bounds(game.sprite(actor.frame), actor.x, actor.y)
        : { x: actor.x - 2, y: actor.y - 2, w: 4, h: 4 };
      const entity = this.entity(actor, bounds, "bullet");
      if (entity) bullets.push(entity);
    }
    const pickups = [];
    for (const actor of game.pickups) {
      if (actor.wallGunFlash || actor.dead) continue;
      const y = actor.wallHunterHatch ? actor.y - game.camera : actor.y;
      const entity = this.entity(actor, { x: actor.x - 8, y: y - 8, w: 16, h: 16 }, actor.kind);
      if (entity) pickups.push(entity);
    }
    const firstRow = Math.floor(game.camera / 16);
    const rowCount = Math.ceil((game.camera + PLAY_HEIGHT) / 16) - firstRow;
    const rows = Array.from({ length: rowCount }, (_, row) =>
      Array.from({ length: 20 }, (_, column) => {
        const tile = game.map[(firstRow + row) * 20 + column] >>> 6;
        return game.assets.terrainMasks[tile]?.some(Boolean) ? "1" : "0";
      }).join(""));
    const navigation = {
      cellSize: 8, x: 16, y: 16,
      rows: Array.from({ length: 21 }, (_, row) =>
        Array.from({ length: 37 }, (_, column) => {
          const x = 16 + column * 8, y = 16 + row * 8;
          return x > 302 || game.shipTouchesTerrain({ x, y }) ? "1" : "0";
        }).join("")),
    };
    return {
      version: this.lifecycle ? 2 : 1, tickRate: TICK_RATE, elapsedTicks: this.elapsedTicks,
      energyLost: this.energyLost,
      time: this.elapsedTicks / TICK_RATE, canStep: this.canStep,
      status: game.status, stage: game.stage, tick: game.tick,
      ...(boss ? { boss } : {}),
      ...(this.lifecycle ? {
        life: this.life, continues: game.continues, continueTicks: game.continueTicks,
        campaignRound: game.campaignRound, shop: this.observeShop() ?? null,
      } : {}),
      score: game.score, credits: game.credits, kills: game.kills, progress: game.progress, camera: game.camera,
      levelProgress: (START_CAMERA - game.camera) / START_CAMERA,
      furthestProgress: { ...this.furthestProgress },
      maxProgressStallTicks: this.maxProgressStallTicks,
      viewport: { width: 320, height: PLAY_HEIGHT },
      player: {
        x: game.player.x, y: game.player.y, health: game.player.health, lives: game.player.lives,
        power: game.player.power, dives: game.player.dives,
        diving: Boolean(game.divePhase), invulnerable: Boolean(game.invincible),
        maxHealth: 39, speedLevel: game.player.speed, banking: game.control.bank,
        autofireLevel: game.player.autofire, fireCooldown: game.fireCooldown,
        diveTicks: game.diveTime, nashwanTicks: game.player.nashwan,
        shadesTicks: game.player.shades, protection: game.player.protection,
        weapons: game.inventory.flatMap((weapon, slot) => weapon ? [{
          slot, id: weapon.id, upgradeLevel: weapon.power,
          name: game.campaign.shop?.find((item) => item.id === weapon.id)?.name ?? `Weapon ${weapon.id}`,
        }] : []),
        bounds: game.bounds(game.shipSprite(game.divePose), game.player.x, game.player.y),
      },
      enemies, bullets, pickups,
      pickupOutcomes: this.pickupOutcomes.map((entry) => ({ ...entry })),
      terrain: {
        cellSize: 16, x: 0, y: firstRow * 16 - game.camera, rows,
        navigation, recovering: Boolean(game.terrainRecovery), touching: game.shipTouchesTerrain(),
      },
    };
  }
}

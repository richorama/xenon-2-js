import { frameAt, PathMotion } from "./motion.js";
import { newInventory, upgradeTarget, grantReward, applyWeaponFirePeriod } from "./shop.js";
import { fireWeapons, moveLaserBeam, stepBomb, updateCannons, updateElectroBall, updateLaserAndDrone,
  updateLinkedMounts, updateMine, updateWeaponMounts } from "./weapons.js";
import { GroundGun, GroundPatrol, GroundHatch, GroundCreature } from "./ground.js";
import { BACKTRACK_PIXELS, movePlayer, playerDirections, scrollMap } from "./controls.js";
import { StageOneBoss, moveCredit, shotDirection } from "./boss.js";
import { StageTwoMiniboss } from "./miniboss.js";
import { StageTwoBoss } from "./stage-two-boss.js";
import { GroundArm, GroundSkater, GroundCrawler, GroundTurret } from "./stage-three-ground.js";
import { StageThreeMiniboss } from "./stage-three-miniboss.js";
import { StageThreeBoss } from "./stage-three-boss.js";
import { dispatchStageFourCorridor, GroundWallHunter, GroundWallRam, StageFourCorridorActor,
  StageFourCorridorPod } from "./stage-four-ground.js";
import { StageFourBoss } from "./stage-four-boss.js";
import { StageFourMiniboss } from "./stage-four-miniboss.js";
import { GroundBarrierPart, GroundStageFiveSprite, GroundStageFiveTurret,
  spawnStageFiveGround } from "./stage-five-ground.js";
import { StageFiveMiniboss, stepStageFiveBeam } from "./stage-five-miniboss.js";
import { StageFiveBoss } from "./stage-five-boss.js";
import { StageOneWorms } from "./stage-one-worms.js";
import { activateNashwan, suspendNashwan } from "./nashwan.js";
import { RunScreen, scoreRank } from "./run-screen.js";
import { ActorList, ActorPool } from "./actor-pool.js";

// CS:6010 divides the PIT interrupt by three; the page flip waits on that tick.
export const TICK_RATE = 1193182 / (0x5555 * 3);
export const START_CAMERA = 0x1200;
export const END_CAMERA = 0xe0;
export const PLAY_HEIGHT = 192;
const DEATH_TICKS = 16;
const CONTINUE_TICKS = 0x4f;
const GAME_OVER_TICKS = 30;
const RESPAWN_POSTURE = 8;
export const DIVE_TICKS = 0x88;
export const INVULNERABILITY_TICKS = 0xaa;
const TERRAIN_HISTORY = 17;
const DRONE_CAPACITY = 80;
const DRONE_DAMAGE = 0x5441; // The VGA callback reads DS:3da8, not the one-point word in its code segment.
const WEAPON_ACTOR_TYPES = {
  1: 0x94, 8: 0x44, 9: 0x38, 10: 0x98, 11: 0x4c, 13: 0x3c, 14: 0xc0,
  15: 0x34, 17: 0x90, 18: 0x20, 19: 0x2c, 20: 0xb0, 21: 0x9c, 23: 0xa0,
};

const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x
  && a.y < b.y + b.h && a.y + a.h > b.y;
const copyInventory = (inventory) => inventory.map((weapon) => weapon && { ...weapon });

function moveScreenActor(actor, dy) {
  actor.motion.y += dy;
  if (actor.yFixed !== undefined) actor.yFixed += dy * 65536;
  if (actor.box?.h > 0) actor.box = { ...actor.box, y: actor.box.y + dy };
}

export { frameAt } from "./motion.js";

export class Game {
  constructor(assets, run) {
    this.campaign = assets;
    this.highScores = assets.runScreenArt?.scores.map(({ score, initials }) => ({ score, initials }));
    this.reset(run);
  }

  get seed() { return this.run.seed; }
  set seed(value) { this.run.seed = value; }
  get campaignRound() { return this.run.round; }
  set campaignRound(value) { this.run.round = value; }
  get activeGame() { return this.run.active ?? this; }
  get playerCount() { return this.run.players?.length ?? 1; }
  get partner() { return this.run.players?.[2 - this.playerNumber]; }
  get droneShots() { return this.run.droneShots; }
  get invulnerabilityRing() {
    const ring = this.invulnerabilityActor;
    return ring && !ring.dead && !ring.hidden && this.invincible ? ring : undefined;
  }

  reset(run = { seed: 0x5845, round: 1, actorPool: new ActorPool(), droneShots: Array(DRONE_CAPACITY).fill(null) }) {
    this.run = run;
    run.formationClock ??= { tick: 0, ids: [0, 0], next: 1 };
    this.actorLists = new Map();
    let hudSlot;
    for (let i = 0; i < 4; i++) {
      hudSlot = run.actorPool.allocate(this.actorLists, ActorList.hud, 0xc4, undefined, hudSlot);
    }
    this.inventory = newInventory();
    this.addWeaponRecord(0, this.inventory[0]);
    this.playerNumber = 1;
    this.status = "ready";
    this.tick = 0;
    this.player = {
      x: 160, y: 174, health: 39, lives: 3, power: 1, bank: 0,
      speed: 0, autofire: 0, dives: 3, protection: false, nashwan: 0, shades: 0,
    };
    this.nashwan = undefined;
    this.score = 0;
    this.credits = 0;
    this.kills = 0;
    this.waves = 0;
    this.sounds = [];
    this.firePeriod = 8;
    this.continues = 2;
    this.continueTicks = 0;
    this.runScreen = undefined;
    this.scoreReturn = undefined;
    this.loadStage(1, false);
  }

  loadStage(number, allocateArena = true) {
    const assets = this.campaign.stages?.[number - 1] || (number === 1 && this.campaign);
    if (!assets) throw new Error(`Missing stage ${number}`);
    this.clearStageActorSlots();
    this.droneShots.fill(null);
    this.run.mineChargeCount = 0;
    this.assets = assets;
    this.stage = number;
    this.victoryRewarded = false;
    this.shopStage = undefined;
    this.shopVisited = false;
    this.camera = START_CAMERA;
    this.control = { camera: START_CAMERA, ceiling: START_CAMERA - 1,
      delta: 0, scroll: 1, bank: 0, reverseTicks: 0, scrollDirection: 1 };
    this.map = assets.map.slice();
    this.mapPatches = new Map();
    this.mapRevision = 0;
    this.ground = [];
    this.scenery = [];
    this.terrainWorms = assets.logic.terrainWorms
      ? new StageOneWorms(assets.logic.terrainWorms, assets.paths, assets.logic.sine) : undefined;
    this.boss = assets.logic.boss
      ? number === 5 ? new StageFiveBoss(assets.logic.boss)
        : number === 4 ? new StageFourBoss(assets.logic.boss, assets.logic.sine, (frame) => this.sprite(frame))
        : number === 3 ? new StageThreeBoss(assets.logic.boss, assets.paths, assets.logic.sine,
        (frame) => this.sprite(frame))
        : number === 2 ? new StageTwoBoss(assets.logic.boss, (frame) => this.sprite(frame))
        : new StageOneBoss(assets.logic.boss, assets.logic.sine, (frame) => this.sprite(frame))
      : undefined;
    this.miniboss = assets.logic.miniboss
      ? number === 5 ? new StageFiveMiniboss(assets.logic.miniboss)
        : number === 4 ? new StageFourMiniboss(assets.logic.miniboss, assets.logic.sine, (frame) => this.sprite(frame))
        : new (number === 3 ? StageThreeMiniboss : StageTwoMiniboss)(
          assets.logic.miniboss, assets.paths, assets.logic.sine,
          (frame) => this.sprite(frame)) : undefined;
    if (number === 1 && allocateArena) {
      this.boss?.allocateCore(this);
    } else if (number === 2) {
      // CS:8e01 reserves the core followed by the three eyes, even before either arena is reached.
      if (this.boss) this.addStageTwoBossActor(this.boss, 0x50);
      for (const eye of this.miniboss?.eyes || []) this.addStageTwoBossActor(eye, 0x54);
    }
    this.endCamera = this.miniboss?.definition.floor ?? (this.boss ? 0 : END_CAMERA);
    this.countedCredits = 0;
    this.foregroundEventLimit = this.backgroundEventLimit = 0x7fee;
    this.eventStreamsClosed = false;
    this.stageFiveTurretFlags = new Set();
    this.formationCredits = new Map();
    this.stageWaves = 0;
    this.adviceIndex = 0;
    this.enemies = [];
    this.shots = [];
    this.cannonPhases = new WeakMap();
    this.weaponAges = new WeakMap();
    this.weaponFire = new WeakMap();
    this.electroBall = undefined;
    this.mine = undefined;
    this.bullets = [];
    this.pickups = [];
    this.effects = [];
    this.fireCooldown = 0;
    this.fireHeld = false;
    this.rearFrame = 0;
    this.rearFiring = false;
    this.nashwanExpiryFrame = this.nashwanMeterTime = undefined;
    this.shadesMeterTime = undefined;
    this.resetInvulnerability();
    this.endWait = 0;
    this.deathAge = 0;
    this.player.x = 160;
    this.player.y = 174;
    this.resetDive();
    this.playerTrail = Array.from({ length: 3 }, () => ({ x: 160, y: 174 }));
    this.checkpoint = { camera: this.camera, x: this.player.x, worldY: this.camera + this.player.y,
      credits: this.credits, inventory: copyInventory(this.nashwan?.inventory || this.inventory) };
  }

  start(stage = 1, players = 1, loading = false) {
    this.reset();
    const partner = players === 2 ? new Game(this.campaign, this.run) : undefined;
    for (const seat of partner ? [this, partner] : [this]) {
      if (stage !== 1) seat.loadStage(stage);
      else seat.boss?.allocateCore(seat);
      seat.posture = seat.mountPosture = RESPAWN_POSTURE;
      seat.status = "playing";
    }
    if (partner) {
      partner.playerNumber = 2;
      partner.highScores = this.highScores;
      this.run.players = [this, partner];
      this.restoreCheckpoint();
    }
    if (partner || (loading && this.campaign.runScreenArt)) this.enterTurn(loading);
  }

  clearStageActorSlots(preserveArena = false) {
    for (const list of [ActorList.scenery, ActorList.transient, ActorList.main]) {
      this.run.actorPool.collect(this.actorLists, list, (actor, type) =>
        actor?.dead || (type !== 0x40 && (!preserveArena
          || (type !== 0x50 && type !== 0x54 && !actor?.stageOneBoss))));
    }
  }

  clearStageFourMain(mark = false) {
    // The miniboss marks the slots for their next update; the final core unlinks them immediately.
    if (mark) {
      for (const { actor } of this.actorLists.get(ActorList.main) || []) actor.dead = true;
    } else this.run.actorPool.collect(this.actorLists, ActorList.main, () => true);
    this.enemies = [];
    this.ground = [];
  }

  addWeaponRecord(slot, weapon) {
    const type = WEAPON_ACTOR_TYPES[weapon.id];
    if (!type) return;
    const pool = this.run.actorPool;
    const record = pool.allocate(this.actorLists, ActorList.mounts, type, { slot, weapon });
    if (record && weapon.id === 15 && slot >= 1 && slot <= 4) {
      // CS:3246 appends a separately allocated Cannon overlay to the transient list.
      record.actor.overlay = pool.allocate(this.actorLists, ActorList.transient, 0x40,
        { mount: record.actor }, null);
    }
    return record;
  }

  replaceWeapon(slot, weapon) {
    const records = this.actorLists.get(ActorList.mounts) || [];
    const previous = records.find(({ actor }) => actor.slot === slot && !actor.dead);
    if (previous) {
      previous.actor.dead = true;
      if (previous.actor.overlay) previous.actor.overlay.actor.dead = true;
    }
    this.inventory[slot] = weapon;
    if (weapon) this.addWeaponRecord(slot, weapon);
  }

  ensureStarterMount() {
    if (!this.inventory[0]) {
      this.replaceWeapon(0, { id: 1, power: 0 });
      applyWeaponFirePeriod(this, 1);
      return;
    }
    const starter = this.inventory[0];
    if (starter?.id === 1 && !this.actorLists.get(ActorList.mounts)
      .some(({ actor }) => actor.slot === 0 && !actor.dead)) this.addWeaponRecord(0, starter);
  }

  releaseWeaponRecords() {
    const pool = this.run.actorPool;
    for (const record of (this.actorLists.get(ActorList.mounts) || []).slice()) {
      if (record.actor.overlay) pool.release(this.actorLists, ActorList.transient, record.actor.overlay);
      pool.release(this.actorLists, ActorList.mounts, record);
    }
  }

  clearCheckpointActors(preserveArena = true) {
    this.nashwanExpiryFrame = this.nashwanMeterTime = undefined;
    this.shadesMeterTime = this.diveMeterTime = undefined;
    suspendNashwan(this);
    this.clearStageActorSlots(true);
    this.droneShots.fill(null);
    this.releaseWeaponRecords();
    if (!preserveArena) this.clearStageActorSlots();
  }

  rebuildWeaponRecords() {
    // CS:193c restores by calling the normal constructors, which choose the first free mount.
    const inventory = this.inventory;
    for (let slot = 1, next = 1; slot <= 4; slot++) {
      if (!inventory[slot]) continue;
      if (next !== slot) [inventory[next], inventory[slot]] = [inventory[slot], null];
      next++;
    }
    if (!inventory[5] && inventory[6]?.id === 23) {
      [inventory[5], inventory[6]] = [inventory[6], null];
    }
    for (const [slot, weapon] of this.inventory.entries()) if (weapon) this.addWeaponRecord(slot, weapon);
  }

  continueRun() {
    if (this.status === "turn-ready") {
      this.runScreen = undefined;
      this.status = "playing";
      return true;
    }
    if (this.status === "continue") {
      this.continues--;
      this.continueTicks = 0;
      this.runScreen = undefined;
      this.player.lives = 3;
      this.score = 0;
      this.resumeAfterDeath();
      return true;
    }
    if (this.status !== "shop") return false;
    this.adviceIndex = 3; // CS:4bc0 selects the second set of advice after leaving the shop.
    // CS:4b9b/35f2 restore a missing starter and save the real loadout before any Nashwan loan.
    this.ensureStarterMount();
    this.checkpoint.inventory = copyInventory(this.inventory);
    const stage = this.shopStage;
    if (stage !== this.stage) {
      this.completeStage(stage);
      return true;
    }
    this.shopStage = undefined;
    activateNashwan(this);
    this.fireHeld = false;
    this.fireCooldown = this.firePeriod;
    this.status = "playing";
    return true;
  }

  enterNextStage(stage) {
    // CS:1aaf clears both the live wallet and the saved credits on stage entry.
    const x = this.player.x;
    this.credits = 0;
    this.clearCheckpointActors(false);
    this.rebuildWeaponRecords();
    this.loadStage(stage);
    this.player.x = x;
    this.player.y = 176;
    this.resetDive();
    this.posture = this.mountPosture = RESPAWN_POSTURE;
    this.playerTrail = Array.from({ length: 3 }, () => ({ x, y: 176 }));
    this.control.ceiling = this.camera;
    Object.assign(this.checkpoint, { x, worldY: 176 });
    for (const weapon of this.inventory) if (weapon) applyWeaponFirePeriod(this, weapon.id);
    activateNashwan(this);
    this.fireCooldown = this.firePeriod;
    this.status = "playing";
  }

  finishVictory() {
    if (this.status !== "ending") return;
    this.completeStage(1);
  }

  completeStage(stage) {
    // A waiting winner may return here after the other player is eliminated and the ending plays.
    if (stage === 1 && !this.victoryRewarded) {
      // CS:40b3 retires the completed campaign's loadout and saves a fresh starter.
      suspendNashwan(this);
      this.releaseWeaponRecords();
      this.inventory = newInventory();
      this.rebuildWeaponRecords();
      applyWeaponFirePeriod(this, 1);
      this.syncPower();
      this.continues++;
      this.victoryRewarded = true;
    }
    const partner = this.partner;
    // CS:40cb waits for the other live player before loading the next stage.
    if (partner && partner.status !== "eliminated" && partner.status !== "stage-wait") {
      this.status = "stage-wait";
      this.clearCheckpointActors(false);
      partner.restoreCheckpoint();
      partner.enterTurn();
      return;
    }
    if (stage === 1) this.campaignRound = (this.campaignRound + 1) & 65535;
    this.enterNextStage(stage);
    let incoming = this;
    if (partner?.status === "stage-wait") {
      partner.enterNextStage(stage);
      incoming = partner;
    }
    if (partner || this.campaign.runScreenArt) incoming.enterTurn(true);
  }

  beginVictory() {
    if (this.partner?.status === "playing") {
      this.completeStage(1);
      return;
    }
    this.openShop(this.stage);
    this.shopStage = undefined;
    this.status = "ending";
  }

  enterTurn(loading = false) {
    this.run.active = this;
    this.runScreen = this.newRunScreen();
    if (loading && this.runScreen) {
      this.status = "stage-loading";
      this.runScreen.loadingFrame(this.stage);
    } else {
      this.status = "turn-ready";
      this.runScreen?.readyFrame(this.playerNumber);
    }
  }

  resumeAfterDeath() {
    const partner = this.partner;
    if (partner?.status === "playing") {
      this.status = "playing";
      this.clearCheckpointActors();
      partner.restoreCheckpoint();
      partner.enterTurn();
    } else {
      this.restoreCheckpoint();
      if (partner || this.campaign.runScreenArt) this.enterTurn();
    }
  }

  finishTurn() {
    const partner = this.partner;
    this.status = "eliminated";
    this.runScreen = undefined;
    this.run.active = partner;
    this.clearCheckpointActors(false);
    if (partner.status === "stage-wait") {
      if (partner.stage === 5) partner.beginVictory();
      else partner.completeStage(partner.stage + 1);
    } else {
      partner.restoreCheckpoint();
      partner.enterTurn();
    }
  }

  saveCheckpoint([camera, , , , x, worldY]) {
    // CS:35ce saves position and credits even when the equipment is on loan.
    Object.assign(this.checkpoint, { camera, x, worldY, credits: this.credits });
    this.saveCheckpointEquipment();
  }

  saveCheckpointEquipment() {
    if (!this.player.nashwan) this.checkpoint.inventory = copyInventory(this.inventory);
  }

  setCheckpointPosition(camera) {
    // Both arena constructors call CS:35eb directly, skipping the credit save.
    Object.assign(this.checkpoint, { camera, x: 160, worldY: 176 });
    this.saveCheckpointEquipment();
  }

  restoreCheckpoint() {
    const { camera, x, credits, inventory } = this.checkpoint;
    const dy = this.camera - camera;
    this.clearCheckpointActors();
    this.actorPaint = undefined;
    this.formationCredits.clear();
    this.inventory = copyInventory(inventory);
    this.rebuildWeaponRecords();
    for (const weapon of this.inventory) if (weapon) applyWeaponFirePeriod(this, weapon.id);
    this.syncPower();
    this.credits = credits;

    // CS:18f5/371a discard transient actors but keep the map and persistent controllers.
    this.enemies = [];
    this.ground = [];
    this.scenery = [];
    this.terrainWorms?.clearActors();
    this.bullets = [];
    this.shots = [];
    this.pickups = [];
    this.effects = [];
    this.countedCredits = 0;
    if (this.boss instanceof StageOneBoss) {
      this.boss.motion.y = this.boss.worldY - camera;
      for (const actor of this.boss.arms) moveScreenActor(actor, dy);
    } else if (this.boss instanceof StageTwoBoss) {
      this.boss.motion.y = this.boss.worldY - camera;
      this.boss.children = [];
    } else if (this.boss instanceof StageThreeBoss) {
      this.boss.parts = [];
      this.boss.present = false;
    }
    if (this.miniboss instanceof StageTwoMiniboss) {
      this.miniboss.waves = [];
      this.miniboss.corpses = [];
      this.miniboss.presence.fill(false);
    } else if (this.miniboss instanceof StageThreeMiniboss && !this.miniboss.dead) {
      this.miniboss.parts = [];
      this.miniboss.active = this.miniboss.present = false;
      this.miniboss.remaining = 2;
    }
    for (const boss of [this.boss, this.miniboss]) {
      if (!boss?.parts?.length || boss.dead) continue;
      if (boss instanceof StageFiveBoss || boss instanceof StageFiveMiniboss) boss.y += dy;
      for (const actor of boss.parts) moveScreenActor(actor, dy);
    }

    // CS:195b/3615 use different exclusive upper bounds for the re-entry scan.
    if (!this.eventStreamsClosed) {
      this.foregroundEventLimit = camera + 1;
      this.backgroundEventLimit = camera + PLAY_HEIGHT;
    }
    this.camera = this.control.camera = this.control.ceiling = camera;
    Object.assign(this.control, { delta: 0, scroll: 0, bank: 0, reverseTicks: 0 });
    Object.assign(this.player, { x, y: 176, bank: 0, health: 39, autofire: 0 });
    this.playerTrail = Array.from({ length: 3 }, () => ({ x, y: 176 }));
    this.electroBall = undefined;
    this.mine = undefined;
    this.fireHeld = this.rearFiring = false;
    this.fireCooldown = this.rearFrame = this.endWait = 0;
    this.resetInvulnerability();
    this.resetDive();
    this.posture = this.mountPosture = RESPAWN_POSTURE;
    activateNashwan(this);
    this.status = "playing";
  }

  openShop(stage) {
    this.nashwanExpiryFrame = this.nashwanMeterTime = undefined;
    this.shadesMeterTime = this.diveMeterTime = undefined;
    suspendNashwan(this);
    this.player.protection = false;
    const credits = this.assets.logic.shopCredits;
    const minimum = this.camera <= 0x1e0 ? credits.end : credits.mid;
    this.shopBudget = this.camera <= 0x1e0 ? credits.end - 400 : credits.mid;
    if (this.credits < minimum) this.credits = minimum + (this.randomWord() & 3) * 50;
    this.shopStage = stage;
    this.status = "shop";
  }

  checkShop() {
    const checkpoint = this.assets.logic.shopCheckpoint;
    if (!checkpoint || this.shopVisited || this.status !== "playing"
      || this.camera + this.player.y >= checkpoint.worldY) return;
    // CS:655b-658a tests the player's world Y, then snaps camera and reverse ceiling.
    this.shopVisited = true;
    this.camera = this.control.camera = this.control.ceiling = checkpoint.camera;
    this.control.delta = 0;
    this.openShop(this.stage);
  }

  syncPower() {
    this.player.power = (this.inventory[0]?.power || 0) + 1;
  }

  togglePause() {
    if (this.status === "playing") this.status = "paused";
    else if (this.status === "paused") this.status = "playing";
  }

  randomWord() {
    this.seed = (this.seed * 0x6255 + 0x3619) & 65535;
    return this.seed;
  }

  sprite(frame) {
    return this.assets.lookup[frame.bank].get(frame.offset);
  }

  bounds(sprite, x, y) {
    const [left, top, width, height] = sprite.box;
    return { x: x - sprite.originX + left, y: y - sprite.originY + top, w: width, h: height };
  }

  enemyFrame(enemy, part = 0) {
    const actor = part ? enemy.children[part - 1] : enemy;
    return actor.headingFrame || frameAt(actor.entryFrames || actor.parts[0].frames, actor.age);
  }

  pickupFrame(pickup) {
    if (pickup.frameOverride) return pickup.frameOverride;
    const frames = pickup.kind === "reward" ? this.assets.rewards[pickup.reward].frames
      : this.assets.logic.credits.frames[pickup.value === 100 ? 1 : 0];
    return frameAt(frames, pickup.age);
  }

  spawn(event, groupIds) {
    const [, type, count, path, spacing, fireRate, speed] = event;
    const parts = this.assets.logic.templates.get(type);
    if (!parts) throw new Error(`Unsupported enemy type ${type}`);
    const groupId = (part) => groupIds?.[Number(Boolean(part.flags & 255))];
    const formation = { remaining: count, escaped: false };
    const pool = this.stage <= 2 || this.stage === 4 ? this.run.actorPool : undefined;
    for (let i = 0; i < count; i++) {
      const motion = (delay = 0) => new PathMotion(this.assets.paths, path, this.assets.logic.sine, {
        delay: (spacing < 100 ? i * spacing : 0) + delay,
        offsetX: spacing >= 100 ? i * (spacing % 100) : 0,
        randomWord: () => this.randomWord(),
      });
      const enemy = {
        type, parts, formation, formationId: groupId(parts[0]), speed: type === 0 ? 3 : speed, age: 0,
        motion: motion(), health: type === 0 || (this.stage === 3 && type === 3)
          ? parts[0].health : (parts[0].health * this.campaignRound) & 65535,
        fireRate: fireRate & 255, fireCounter: this.randomWord() & 255, hit: 0, reward: speed,
      };
      let slot = pool?.allocate(this.actorLists, ActorList.main, parts[0].id, enemy);
      if (pool && !slot) continue;
      if (slot) {
        this.initializeForegroundSlot(slot);
        if ((this.stage === 1 && type !== 0) || (this.stage === 4 && parts.length > 1)) {
          slot.formationRoot = enemy;
        }
      }
      enemy.children = [];
      for (const part of parts.slice(1)) {
        const child = {
          type, parts: [part], formationId: groupId(part), foregroundRoot: enemy, motion: motion(part.score),
          age: 0, hit: 0, speed, fireRate: enemy.fireRate, fireCounter: this.randomWord() & 255,
        };
        slot = pool?.allocate(this.actorLists, ActorList.main, part.id, child, slot);
        if (pool && !slot) break;
        if (slot) this.initializeForegroundSlot(slot);
        enemy.children.push(child);
      }
      // CS:3360 clears the last pod's group after the common constructor registers it.
      if (this.stage === 4 && type === 0 && i === count - 1) enemy.formationId = undefined;
      this.enemies.push(enemy);
    }
    // CS:34e5 adds the event count to the last part's group, or uses the first vacant entry.
    const id = groupId(parts.at(-1)), groups = this.formationCredits;
    if (count && id) {
      if (groups.has(id)) groups.set(id, (groups.get(id) + count) & 65535);
      else if (groups.size < 8) {
        groups.set(id, count);
        const clock = this.run.formationClock;
        clock.next = (clock.next + 1) & 65535;
      }
    }
    this.waves++;
    this.stageWaves++;
  }

  retireFormationCredits() {
    if (!this.formationCredits.size) return;
    // CS:36d3 checks the linked list, including marked records that have yet to unlink.
    const ids = new Set(this.stage <= 2 || this.stage === 4
      ? this.actorLists.get(ActorList.main)?.map(({ actor }) => actor.formationId)
      : this.enemies.flatMap((actor) => [actor.formationId, ...actor.children.map((child) => child.formationId)]));
    for (const id of this.formationCredits.keys()) if (!ids.has(id)) this.formationCredits.delete(id);
  }

  initializeForegroundSlot({ address, actor }) {
    const pool = this.run.actorPool;
    pool.subpixels.delete(address);
    if (this.stage === 1 || this.stage === 4) pool.headings.set(address, 0);
    if (this.stage === 4) {
      pool.fireCounterLowBytes.set(address, actor.fireCounter);
      pool.fireCounterHighBytes.set(address, actor.fireRate);
      pool.contactFlags.set(address, actor.parts[0].flags & 255);
    }
    this.cacheForegroundContact(actor);
  }

  cacheForegroundContact(actor) {
    if ((this.stage === 1 || this.stage === 4) && actor.actorAddress !== undefined) {
      actor.contactBox = this.targetBounds(actor);
    }
  }

  updateForeground(enemy, aimOperand) {
    const root = enemy.foregroundRoot || enemy;
    const script = enemy.parts[0].update;
    const linkedAttachment = (this.stage === 1 || this.stage === 4)
      && script === 0x37ca && enemy.actorAddress !== undefined;
    if (enemy.dead || (root.dead && !linkedAttachment)) return aimOperand;
    enemy.age++;
    enemy.hit = Math.max(0, enemy.hit - 1);
    if (script === 0x37ca) {
      // CS:37ca copies the integer coordinates from the last occupant of the root slot.
      const source = linkedAttachment ? this.run.actorPool.recordsByAddress.get(root.actorAddress)?.actor : root;
      const { x, y } = source?.motion ?? source ?? root.motion;
      const sourceY = source instanceof GroundGun || source instanceof StageOneBoss
        || source instanceof GroundWallHunter ? source.worldY : y;
      enemy.motion.xFixed = (x ?? root.motion.x) * 65536 + (enemy.motion.xFixed & 65535);
      enemy.motion.yFixed = (sourceY ?? root.motion.y) * 65536 + (enemy.motion.yFixed & 65535);
      this.cacheForegroundContact(enemy);
      return aimOperand;
    }
    aimOperand = enemy.motion.step(enemy.speed, aimOperand);
    this.saveActorMotion(enemy, enemy.motion);
    const { x, y } = enemy.motion;
    if (!enemy.motion.active) {
      root.dead = true;
      for (const child of root.children) child.dead = true;
      root.formation.escaped = true;
      this.formationCredits.delete(root.formationId);
      return aimOperand;
    }
    this.cacheForegroundContact(enemy);
    const headings = this.assets.logic.headingFrames?.[script];
    if (!headings && script !== 0x480b && script !== 0x9a2b) return aimOperand;
    const sum = enemy.fireCounter + enemy.fireRate % 100;
    enemy.fireCounter = sum & 255;
    if (sum > 255) enemy.fireCounter = this.randomWord() & 63;
    if (this.stage === 4 && enemy.actorAddress !== undefined) {
      this.run.actorPool.fireCounterLowBytes.set(enemy.actorAddress, enemy.fireCounter);
    }
    if (sum > 255) {
      const direction = enemy.fireRate >= 100 ? shotDirection(this.player.x - x, this.player.y - y)
        : this.randomWord() & 7;
      const { frame, vectors } = this.assets.logic.foregroundShot;
      const [dx, dy] = vectors[direction];
      const bullet = { x, y, dx: dx * 6, dy: dy * 6, frame, fixed: true,
        direction, foreground: true, damage: 4 };
      if (this.stage <= 2 || (this.stage === 4 && enemy.actorAddress !== undefined)) this.addPooledHostileRound(bullet, 6);
      else this.bullets.unshift(bullet);
      aimOperand = y;
    }
    if (script === 0x9a2b && !enemy.entryFrames) {
      const side = x < 0
        ? (y < 0 ? (y < x ? 1 : 0) : (192 - y < x ? 3 : 0))
        : (y < 0 ? (y < 320 - x ? 1 : 2) : (y - 192 < x - 320 ? 2 : 3));
      enemy.entryFrames = this.assets.logic.entryFrames[side];
      enemy.age = 0;
      aimOperand = side * 2;
    }
    if (headings) {
      const direction = ((enemy.motion.heading >>> 16) + 16) >> 5 & 7;
      enemy.headingFrame = headings[direction];
      aimOperand = direction * 2;
    }
    return aimOperand;
  }

  addPooledHostileRound(bullet, speed) {
    const pool = this.run.actorPool;
    if (pool.allocate(this.actorLists, ActorList.transient, 0x14, bullet, undefined,
      this.stage === 1 || this.stage === 4)) {
      // CS:1ed3 writes the integer coordinates, leaving the low words intact.
      const [x, y] = pool.subpixels.get(bullet.actorAddress) || [0, 0];
      bullet.xFixed = bullet.x * 65536 + x;
      bullet.yFixed = bullet.y * 65536 + y;
      bullet.speed = speed;
      if (bullet.direction !== undefined) pool.headings.set(bullet.actorAddress, bullet.direction);
      if (this.stage === 1 || this.stage === 4) pool.movementBudgets.set(bullet.actorAddress, speed);
      bullet.foreground = true; // CS:1f4d uses the same sprite collision for all type-14 rounds.
      this.bullets.unshift(bullet);
    }
  }

  addPlayerRound(shot, type = 0x10) {
    if (this.stage === 2 || (this.stage === 4 && (shot.beam || shot.flame || shot.bomb || shot.mine || shot.homing))
      || ((this.stage === 1 || this.stage === 4) && (shot.point || shot.cannon))) {
      const pool = this.run.actorPool;
      const keepFormation = (this.stage === 1 || this.stage === 4) && shot.cannon;
      if (!pool.allocate(this.actorLists, ActorList.transient, type, shot, undefined, keepFormation)) return;
      if (type === 0x10) pool.headings.set(shot.actorAddress, shot.dx & 65535);
      if (shot.homing) pool.headings.set(shot.actorAddress, shot.direction);
      if (shot.flame) {
        const [, y] = pool.subpixels.get(shot.actorAddress) || [0, 0];
        pool.subpixels.set(shot.actorAddress, [shot.xFixed & 65535, y]);
        pool.headings.set(shot.actorAddress, (shot.dxFixed / 1024) & 65535);
      }
    }
    if (shot.flame || shot.mine || shot.homing) this.shots.unshift(shot);
    else this.shots.push(shot);
  }

  addDroneVolley(x, y, volley) {
    let round = 0;
    for (let slot = 0; slot < this.droneShots.length && round < volley.length; slot++) {
      if (this.droneShots[slot]) continue;
      const [offsetX, offsetY, dx, dy] = volley[round++];
      if (x + offsetX < 0) continue;
      this.droneShots[slot] = { x: x + offsetX, y: y + offsetY, dx, dy, damage: DRONE_DAMAGE, age: 0, point: true };
    }
  }

  updateDroneRounds() {
    for (const [slot, shot] of this.droneShots.entries()) {
      if (!shot) continue;
      shot.age++;
      shot.x += shot.dx;
      shot.y += shot.dy;
      if (shot.x >= 0 && shot.x < 316 && shot.y >= 0 && shot.y < 188) {
        this.hitPlayerRound(shot, { x: shot.x, y: shot.y, w: 1, h: 1 }, true);
        if (!shot.dead) continue;
      }
      this.droneShots[slot] = null;
    }
  }

  updatePlayerRound(shot, population) {
    if (shot.mine) {
      // Unlike other player rounds, the Mine animates before checking the death latch.
      shot.frame = frameAt(shot.frames, ++shot.age);
      if (this.status === "dying") shot.dead = true;
      else if (!this.fireHeld && !++shot.fuse) this.blastMine(shot);
      return;
    }
    if (this.status === "dying") { shot.dead = true; return; }
    shot.age++;
    if (shot.beam) {
      const bounds = moveLaserBeam(shot);
      if (!shot.dead && bounds.h) this.hitMainArea(shot, bounds);
      return;
    }
    if (shot.flame) {
      this.updateFlame(shot);
      return;
    }
    if (shot.homing) {
      this.stepHomingMissile(shot, population);
      return;
    }
    if (shot.frames) shot.frame = frameAt(shot.frames, shot.age);
    if (shot.bomb) {
      if (stepBomb(shot)) this.blastBomb(shot);
      return;
    }
    if (!shot.cannon) {
      shot.x += shot.dx;
      if (shot.x < 0 || shot.x >= 312) { shot.dead = true; return; }
    }
    shot.y += shot.dy;
    if (shot.y < 0 || (!shot.cannon && shot.y >= PLAY_HEIGHT)) { shot.dead = true; return; }

    const impact = shot.cannon ? this.bounds(this.sprite(shot.frame), shot.x, shot.y)
      : { x: shot.x, y: shot.y, w: 1, h: 1 };
    if (this.stage === 4 && shot.cannon) shot.contactBox = impact;
    this.hitPlayerRound(shot, impact);
  }

  updateFlame(shot) {
    if (shot.age >= shot.ttl) { shot.dead = true; return; }
    shot.frame = frameAt(shot.frames, shot.age);
    shot.xFixed += shot.dxFixed;
    shot.x = shot.xFixed >> 16;
    if (shot.actorAddress !== undefined) {
      this.run.actorPool.subpixels.get(shot.actorAddress)[0] = shot.xFixed & 65535;
    }
    if (shot.x < 0 || shot.x >= 320) { shot.dead = true; return; }
    shot.y -= 12;
    if (shot.y < 0) { shot.dead = true; return; }
    if (!shot.damaging) return;
    const bounds = this.bounds(this.sprite(shot.frame), shot.x, shot.y);
    if (shot.actorAddress !== undefined) this.hitPlayerRound(shot, bounds);
    else shot.dead = this.hitFirstInBox(shot, bounds);
  }

  hitPlayerRound(shot, impact, fromDrone = false) {
    // CS:39ee marks straight rounds before damage, while CS:28b8 leaves Cannon rounds active.
    const stageOneTarget = this.findStageOneTarget(impact);
    if (stageOneTarget) {
      if (!shot.cannon) shot.dead = true;
      if (!stageOneTarget.dead) this.hitWithWeapon(stageOneTarget, shot, impact, fromDrone);
      return;
    }
    for (const enemy of this.mainTargets) {
      const dead = enemy.dead || (this.stage !== 4 && enemy.foregroundRoot?.dead);
      if ((this.stage === 1 && enemy.actorAddress !== undefined)
        || enemy.kind === "egg" || (dead && enemy.actorAddress === undefined)) continue;
      const box = this.stage === 4 && enemy.actorAddress !== undefined ? this.stageFourTargetBounds(enemy)
        : this.targetBounds(enemy);
      if (!(box?.w > 0 && box.h > 0 && intersects(impact, box))) continue;
      if (!shot.cannon) shot.dead = true;
      // Marked records keep their collision box until the next main-list pass.
      if (!dead) this.hitWithWeapon(enemy, shot, impact, fromDrone);
      return;
    }
    const terrain = this.boss?.terrainTarget?.(impact, this.camera);
    if (terrain) {
      if (!shot.cannon) shot.dead = true;
      if (fromDrone && this.stage === 2) this.saveActorPaint();
      this.boss.destroyTerrain(terrain, this);
    }
  }

  saveActorMotion(actor, position) {
    if (actor.actorAddress !== undefined) {
      const pool = this.run.actorPool;
      pool.subpixels.set(actor.actorAddress, [position.xFixed & 65535, position.yFixed & 65535]);
      if (position.heading !== undefined) pool.headings.set(actor.actorAddress, position.heading >>> 16);
    }
  }

  addStageTwoBossActor(actor, type, list = ActorList.main) {
    const pool = this.run.actorPool;
    const record = pool.allocate(this.actorLists, list, type, actor);
    if (record && actor.kind === "egg") pool.hitBoxes.delete(record.address);
    else if (record) this.savePooledBounds(actor);
    return record;
  }

  savePooledBounds(actor) {
    if (actor.actorAddress !== undefined && actor.box) {
      this.run.actorPool.hitBoxes.set(actor.actorAddress, actor.box);
    }
  }

  updateGroundActor(actor, aimOperand) {
    if (actor.dead || actor.root) return aimOperand;
    if (actor instanceof GroundStageFiveSprite) {
      actor.step();
      return aimOperand;
    }
    const phase = actor.phase;
    const bullet = actor.update(this.camera, this.control.ceiling, () => this.randomWord(), this.player,
      this.tick, this.control.delta, this.map,
      (cell, tile) => this.patchGround({ cell }, [tile]));
    if (actor instanceof GroundPatrol) this.savePooledBounds(actor);
    if (actor instanceof GroundGun && actor.actorAddress !== undefined && !actor.dead) {
      if (this.stage === 4) this.run.actorPool.fireCounterLowBytes.set(actor.actorAddress, actor.fireCounter);
      const box = actor.bounds(this.camera);
      // Stage two's decoded box already includes the right/bottom endpoints.
      actor.contactBox = this.stage === 1 ? { ...box, w: box.w + 1, h: box.h + 1 } : box;
      if (this.stage === 1) {
        // The map writers leave the animation table address in BX unless they launch a round.
        const { anim, frameTicks } = actor.definition;
        aimOperand = bullet?.y ?? anim[actor.side] + Math.floor(phase / frameTicks) * (actor.type === 3 ? 4 : 8);
      } else if (this.stage === 4 && phase) {
        aimOperand = bullet?.y ?? actor.definition.anim[actor.side] + phase * 8;
      }
    }
    if (this.stage === 2 && actor.actorAddress !== undefined && actor.definition?.kind === "swarm" && !actor.dead) {
      this.contactStageTwoSwarm(actor);
    }
    if (actor.expired) {
      const sprite = this.sprite(actor.frame);
      this.explode(actor.motion.x - sprite.originX + Math.floor(sprite.width / 2),
        actor.motion.y - sprite.originY + Math.floor((sprite.height - 1) / 2));
    }
    if (!actor.dead && !actor.spriteActor && !(actor instanceof GroundTurret)
      && !((this.stage === 2 || this.stage === 4) && actor instanceof GroundGun && !phase)) {
      this.patchGround(actor, actor.patches);
    }
    if (!bullet) return aimOperand;
    const bullets = Array.isArray(bullet) ? bullet : [bullet];
    if (actor.actorAddress !== undefined && (this.stage <= 2 || this.stage === 4)) {
      if (actor instanceof GroundPatrol) {
        this.run.actorPool.move(this.actorLists, ActorList.main, ActorList.transient, actor);
      }
      let replacement;
      for (const [i, bullet] of bullets.entries()) {
        // CS:6e9d reads the patrol address again for each round, even if it now holds a projectile.
        const shot = replacement ? actor.makeRound(actor.definition.directions[0][i], 0, replacement.y) : bullet;
        this.addPooledHostileRound(shot, actor.definition.bulletSpeed);
        if (this.stage === 1) aimOperand = shot.y;
        if (this.stage === 1 && actor instanceof GroundPatrol && shot.actorAddress === actor.actorAddress) {
          replacement = shot;
        }
      }
    } else this.bullets.push(...bullets);
    return aimOperand;
  }

  damage(amount = 8) {
    if (this.invincible || this.divePhase || this.countedCredits || this.status !== "playing") return;
    if (this.player.protection) amount >>>= 1;
    const health = this.player.health;
    this.player.health = Math.max(0, health - amount);
    if (health > this.player.health) this.onHealthLost?.(health - this.player.health);
    this.sounds.push("hit");
    if (this.player.health === 0) this.killPlayer();
  }

  contactStageTwoShip(shades) {
    const { x, y } = this.player;
    const hull = shades ? { x: x - 64, y: y - 64, w: 129, h: 129 } : this.shipContactBox;
    // CS:4311 scans the cached main list before movement, mounts and transients.
    const record = (this.actorLists.get(ActorList.main) || []).find(({ type, actor }) => {
      if (actor.kind === "egg" || (type === 0xb8 && !actor.dead)) return false;
      const box = actor instanceof GroundGun ? actor.contactBox : this.targetBounds(actor);
      return box?.w > 0 && box.h > 0 && intersects(hull, box);
    });
    const enemy = record?.actor;
    const wall = !enemy && this.boss?.terrainTarget?.(hull, this.camera);
    if (!enemy && !wall) return false;
    const large = (enemy?.parts?.[0]?.flags & 255) || enemy?.definition?.large;
    if (!shades) {
      if (!this.invincible) this.shipHitFlash = true;
      this.damage(large ? 16 : 8);
    }
    if (this.status === "dying") return true;
    if (wall) this.boss.destroyTerrain(wall, this);
    else if (!enemy.dead && !enemy.foregroundRoot?.dead && (shades || (record.type !== 0x50 && record.type !== 0x54))) {
      this.hitWithWeapon(enemy, { shades, damage: 127 }, hull);
    }
    return true;
  }

  findStageOneTarget(bounds) {
    const overlaps = (box) => Boolean(box?.w && box.h && intersects(bounds, box));
    return this.terrainWorms?.findContact(this.actorLists, overlaps, (actor) =>
      overlaps(actor instanceof GroundPatrol || actor.stageOneBoss ? actor.box
        : actor === this.boss ? actor.bodyBox : actor.contactBox));
  }

  contactStageOneShip() {
    const enemy = this.findStageOneTarget(this.shipContactBox);
    if (!enemy) return false;
    const large = (enemy.parts?.[0]?.flags & 255) || enemy.definition?.large;
    this.damage(large ? 16 : 8);
    if (this.status === "playing") {
      this.shipHitFlash = !this.invincible;
      if (!enemy.dead && !enemy.boss) {
        this.hitWithWeapon(enemy, { damage: 127 }, this.shipContactBox);
      }
    }
    return true;
  }

  contactStageFourShip(shades) {
    const { x, y } = this.player;
    const hull = shades ? { x: x - 64, y: y - 64, w: 129, h: 129 } : this.shipContactBox;
    const record = this.actorLists.get(ActorList.main)?.find(({ actor }) => {
      const box = this.stageFourTargetBounds(actor);
      return box?.w > 0 && box.h > 0 && intersects(hull, box);
    });
    if (!record) return shades && this.hitFirstInBox({ shades, damage: 127 }, hull);
    if (!shades && !this.invincible) {
      this.shipHitFlash = true;
      // The burst gun doesn't write the size flag when it takes over a slot.
      this.damage(this.run.actorPool.contactFlags.get(record.address) ? 16 : 8);
    }
    const { actor, type } = record;
    if (this.status === "playing" && !actor.dead && (shades || (type !== 0x50 && type !== 0x54))) {
      this.hitWithWeapon(actor, { shades, damage: 127 }, hull);
    }
    return true;
  }

  contactStageTwoSwarm(actor) {
    const hull = this.shipContactBox;
    if (!hull || this.divePhase || this.status !== "playing") return;
    // CS:8641 passes the bottom of the swarm box and twice its direction index, not its position.
    const x = actor.box.y + actor.box.h - 1, y = actor.direction * 2;
    if (x < hull.x || x >= hull.x + hull.w || y < hull.y || y >= hull.y + hull.h) return;
    if (this.invincible) actor.expired = true;
    else {
      this.shipHitFlash = true;
      this.damage(actor.definition.contactDamage);
    }
    actor.dead = true;
  }

  killPlayer() {
    this.player.health = 0;
    this.shipHitFlash = false;
    this.diveTime = 0;
    this.diveMeterTime = undefined;
    this.sounds.push("death");
    this.deathAge = 0;
    this.status = "dying";
  }

  finishDeath() {
    this.player.health = 39;
    this.player.autofire = 0;
    if (--this.player.lives) {
      this.resumeAfterDeath();
      return;
    }
    const rank = this.highScores ? scoreRank(this.highScores, this.score) : -1;
    if (rank < 0) this.offerContinue();
    else {
      this.highScores.splice(rank, 0, { score: this.score >>> 0, initials: ":::" });
      this.highScores.pop();
      this.status = "score-entry";
      this.runScreen = this.newRunScreen();
      this.runScreen.openScores(this.highScores, rank);
    }
  }

  offerContinue() {
    if (this.continues) {
      this.continueTicks = CONTINUE_TICKS;
      this.status = "continue";
      this.runScreen = this.newRunScreen();
      this.runScreen?.continueFrame();
      this.runScreen?.continueFrame(this.continueTicks, this.continues);
    } else this.showGameOver();
  }

  openAttract() {
    if (this.status !== "ready") return;
    this.runScreen = this.newRunScreen();
    this.runScreen?.attractFrame(this.highScores);
  }

  openMenu() {
    if (this.status !== "ready" || !this.campaign.runScreenArt) return false;
    this.status = "menu";
    this.menuSelection = 0;
    this.menuRepeat = 0;
    this.runScreen = this.newRunScreen();
    this.runScreen.menuFrame();
    return true;
  }

  moveMenu(step) {
    this.menuSelection = (this.menuSelection + step + 3) % 3;
    this.menuRepeat = 8;
  }

  showScores() {
    if (!["ready", "menu"].includes(this.status) || !this.highScores) return false;
    this.scoreReturn = { status: this.status, screen: this.runScreen };
    this.status = "score-table";
    this.runScreen = this.newRunScreen();
    this.runScreen.openScores(this.highScores);
    return true;
  }

  closeScores() {
    if (this.status !== "score-table") return false;
    this.status = this.scoreReturn.status;
    this.runScreen = this.scoreReturn.screen;
    this.scoreReturn = undefined;
    return true;
  }

  newRunScreen() {
    const art = this.campaign.runScreenArt;
    return art && new RunScreen(art, art.frontPalette, () => this.randomWord());
  }

  showGameOver() {
    this.continueTicks = 0;
    this.status = this.partner && this.partner.status !== "eliminated" ? "turn-over" : "gameover";
    this.runScreen = this.newRunScreen();
    this.runScreen?.gameOverFrame();
    if (this.status === "turn-over" && !this.runScreen) this.finishTurn();
  }

  get animateRunScreen() {
    return ["menu", "score-entry", "score-table", "stage-loading", "turn-ready", "turn-over"].includes(this.status)
      || ["ready", "gameover"].includes(this.status) && Boolean(this.runScreen);
  }

  explode(x, y, large = false, pooled = this.stage === 2) {
    const effect = { x, y, age: 0, large };
    if (pooled) effect.frames = this.assets.logic.explosions[Number(large)];
    const record = this.addExplosion(effect, pooled);
    this.sounds.push(large ? "explosion-large" : "explosion");
    return record;
  }

  addExplosion(effect, pooled = this.stage === 2) {
    const record = pooled && this.run.actorPool.allocate(this.actorLists, ActorList.transient,
      0x0c, effect, undefined, this.stage === 1 || this.stage === 4);
    if (pooled && !record) return;
    this.effects.push(effect);
    return record;
  }

  addPickup(pickup, pooled = this.stage === 2 || (this.stage === 1 && pickup.state !== undefined)) {
    let slot;
    if (pooled) {
      const pool = this.run.actorPool;
      const type = pickup.kind === "reward" ? this.assets.rewards[pickup.reward].actor
        : pickup.value === 100 ? 0x18 : 0x60;
      // CS:15e4 appends its counted credits; CS:1e61 and CS:3aec insert at the head.
      slot = pool.allocate(this.actorLists, ActorList.transient, type, pickup,
        pickup.counted ? null : undefined, this.stage === 1 || this.stage === 4);
      if (!slot) return;
      // Pods and boss credits leave the direction word untouched; formation credits set it.
      pickup.direction ??= pool.headings.get(slot.address) ?? 0;
      pool.headings.set(slot.address, pickup.direction);
    } else pickup.direction ??= 0;
    this.pickups.push(pickup);
    if (pickup.counted) this.countedCredits++;
    return slot;
  }

  resolvePickup(pickup, advancesCountdown, collected = false) {
    if (advancesCountdown && this.countedCredits) this.countedCredits--;
    pickup.dead = true;
    this.onPickupResolved?.(pickup, collected);
  }

  updatePickup(pickup, hull) {
    if (pickup.dead) return;
    pickup.age++;
    if (pickup.state !== undefined) {
      moveCredit(pickup, this.assets.logic.credits);
      if (pickup.actorAddress !== undefined) this.run.actorPool.headings.set(pickup.actorAddress, pickup.direction);
      if (pickup.dead) {
        // CS:2909 decrements the global count even when an ordinary drop expires.
        this.resolvePickup(pickup, true);
        return;
      }
    } else pickup.y += 0.6;
    const { shipContactBox } = this;
    const contact = !this.divePhase && (pickup.state !== undefined
      ? shipContactBox && intersects(shipContactBox, this.bounds(this.sprite(this.pickupFrame(pickup)), pickup.x, pickup.y))
      : intersects(hull, { x: pickup.x - 7, y: pickup.y - 7, w: 14, h: 14 }));
    if (this.status !== "playing" || !contact) return;
    this.resolvePickup(pickup, pickup.state !== undefined && pickup.kind === "credit", true);
    if (pickup.state === undefined) this.score += 50;
    if (pickup.kind === "reward") grantReward(this, pickup.reward);
    else if (pickup.kind === "power") {
      const weapon = upgradeTarget(this.inventory);
      if (weapon) weapon.power++;
      this.syncPower();
    } else if (pickup.kind === "health") this.player.health = Math.min(39, this.player.health + 16);
    else this.credits += pickup.value || 25;
    this.sounds.push(pickup.kind === "credit" ? "credit" : pickup.kind === "health" ? "health" : "pickup");
  }

  updateEnemyRound(bullet, hull) {
    if (bullet.dead) return;
    if (bullet.beamLength !== undefined) {
      const bounds = stepStageFiveBeam(bullet, this.control.delta);
      if (!bullet.dead && this.status === "playing" && !this.divePhase && intersects(hull, bounds)) {
        bullet.dead = true;
        this.damage(bullet.damage);
      }
      return;
    }
    if (bullet.frames) bullet.frame = frameAt(bullet.frames, bullet.age = (bullet.age || 0) + 1);
    if (bullet.fixed) {
      bullet.xFixed = (bullet.xFixed ?? bullet.x * 65536) + bullet.dx * 65536;
      bullet.yFixed = (bullet.yFixed ?? bullet.y * 65536)
        + (bullet.dy + this.control.delta) * 65536;
      this.saveActorMotion(bullet, bullet);
      bullet.x = Math.floor(bullet.xFixed / 65536);
      bullet.y = Math.floor(bullet.yFixed / 65536);
      if (bullet.x < 0 || bullet.x >= 320 || bullet.y < 0 || bullet.y >= PLAY_HEIGHT) {
        bullet.dead = true;
        return;
      }
    } else {
      bullet.x += bullet.dx;
      bullet.y += bullet.dy + this.control.delta;
    }
    const bounds = bullet.foreground && this.bounds(this.sprite(bullet.frame), bullet.x, bullet.y);
    if (this.stage === 4 && bounds && bullet.actorAddress !== undefined) bullet.contactBox = bounds;
    const contact = !this.divePhase && (bullet.foreground
      ? this.shipContactBox && intersects(this.shipContactBox, bounds)
      : intersects(hull, { x: bullet.x - 2, y: bullet.y - 2, w: 4, h: 4 }));
    if (this.status === "playing" && contact) {
      bullet.dead = true;
      this.damage(bullet.damage || 4);
      // CS:1faa selects the flash after damage, even on the first death frame.
      if (bullet.foreground && !this.invincible) this.shipHitFlash = true;
    }
    if (!bullet.dead && bullet.corridor && (bullet.x < 128 || bullet.x >= 192)) {
      const d = bullet.corridor, side = bullet.x < 128 ? 0 : 1;
      bullet.direction = side ? 5 : 3;
      [bullet.dx, bullet.dy] = d.vectors[bullet.direction].map((value) => value * d.bulletSpeed);
      bullet.frame = d.bulletFrames[side];
      bullet.frames = undefined;
    }
  }

  updateTransientActor(slot, hull, population) {
    const { actor, type } = slot;
    if (actor.dead) this.run.actorPool.release(this.actorLists, ActorList.transient, slot);
    // Some reward IDs reuse numeric types assigned to player weapons.
    else if (actor.kind === "reward") this.updatePickup(actor, hull);
    else if (actor instanceof StageFourCorridorPod) actor.step(this, slot);
    else if (type === 0x14) this.updateEnemyRound(actor, hull);
    else if (type === 0x0c) {
      if (actor.disabledTurret) actor.disabledTurret.stepTurretBody(actor);
      else actor.dead = ++actor.age >= actor.frames.length;
    }
    else if (actor.kind === "terrain-worm-corpse") this.terrainWorms.updateCorpse(actor);
    else if (actor.kind === "invulnerability-ring") this.updateInvulnerability(actor);
    else if (type === 0x10 || type === 0x24 || type === 0x28 || type === 0x30
      || type === 0x38 || type === 0x3c || type === 0x48 || type === 0xb4) this.updatePlayerRound(actor, population);
    else if (actor.miniboss instanceof StageTwoMiniboss) actor.miniboss.updateCorpse(actor);
    else if (actor instanceof GroundPatrol) this.updateGroundActor(actor);
    else if (type !== 0x40) this.updatePickup(actor, hull);
  }

  updateStageFourMainActor(slot, aimOperand) {
    const { actor } = slot;
    if (actor.dead) this.run.actorPool.release(this.actorLists, ActorList.main, slot);
    else if (actor.finalBoss instanceof StageFourBoss) aimOperand = actor.finalBoss.updatePart(actor, this, aimOperand);
    else if (actor.miniboss instanceof StageFourMiniboss) aimOperand = actor.miniboss.updatePart(actor, this, aimOperand);
    else if (actor instanceof StageFourCorridorActor) aimOperand = actor.step(this, aimOperand);
    else if (actor.ground) aimOperand = this.updateGroundActor(actor, aimOperand);
    else aimOperand = this.updateForeground(actor, aimOperand);
    return aimOperand;
  }

  stageFourMainNeighbor(actor, offset) {
    const main = this.actorLists.get(ActorList.main);
    const index = main?.findIndex(({ actor: candidate }) => candidate === actor) ?? -1;
    return index < 0 ? undefined : main[index + offset];
  }

  stageFourArenaPrevious(actor) {
    const slot = this.stageFourMainNeighbor(actor, -1);
    if (!slot) return { xFixed: 0, yFixed: 0, heading: 0, turn: 0, acceleration: 0, length: 0 };
    const { actor: previous, address } = slot;
    const position = previous.motion ?? previous;
    const pool = this.run.actorPool;
    const [x, y] = pool.subpixels.get(address) ?? [0, 0];
    return {
      xFixed: (position.x ?? 0) * 65536 + ((position.xFixed ?? previous.xFixed ?? x) & 65535),
      yFixed: (previous.worldY ?? position.y ?? 0) * 65536 + ((position.yFixed ?? previous.yFixed ?? y) & 65535),
      heading: ((pool.headings.get(address) ?? 0) << 16) | ((position.heading ?? previous.heading ?? 0) & 65535),
      turn: position.turn ?? previous.turn ?? 0,
      acceleration: position.acceleration ?? previous.acceleration ?? 0,
      length: previous.length ?? previous.speed ?? pool.movementBudgets.get(address) ?? 0,
    };
  }

  updateStageFourScenery(randomWord) {
    const pool = this.run.actorPool;
    for (const [, slot] of pool.walk(this.actorLists, ActorList.scenery)) {
      const ram = slot.actor;
      if (ram.dead) {
        pool.release(this.actorLists, ActorList.scenery, slot);
        continue;
      }
      const waiting = !ram.length;
      ram.update(this.control.delta, randomWord);
      pool.fireCounterLowBytes.set(slot.address, ram.counter);
      if (ram.dead) continue;
      if (waiting || ram.length === 6) pool.headings.set(slot.address, ram.speed & 65535);
      if (this.status === "playing" && !this.divePhase && !this.invincible
        && this.shipContactBox && intersects(this.shipContactBox, ram.bounds())) {
        this.damage(ram.definition.contactDamage);
        this.shipHitFlash = true;
      }
    }
  }

  destroy(enemy, recycled) {
    enemy = enemy.foregroundRoot || enemy;
    if (enemy.dead && !recycled) return;
    if (enemy.terrainWorm) {
      this.terrainWorms.destroy(this, enemy);
      return;
    }
    if (enemy instanceof GroundWallHunter) {
      enemy.destroy(this, recycled);
      return;
    }
    if (enemy instanceof GroundTurret || enemy instanceof GroundBarrierPart || enemy instanceof GroundStageFiveTurret) {
      enemy.destroy(this);
      return;
    }
    if (enemy.chain) {
      for (const part of [...enemy.chain.slice(1), enemy.chain[0]]) {
        const sprite = this.sprite(part.frame);
        part.dead = true;
        this.explode(part.motion.x - sprite.originX + Math.floor(sprite.width / 2),
          part.motion.y - sprite.originY + Math.floor((sprite.height - 1) / 2));
      }
      this.score += enemy.definition.score;
      this.kills++;
      return;
    }
    if (enemy.miniboss) {
      enemy.miniboss.destroy(enemy, this);
      return;
    }
    if (enemy.finalBoss) {
      enemy.finalBoss.destroy(enemy, this);
      return;
    }
    if (enemy.bossOwner) {
      this.score += 30;
      this.kills++;
      const sprite = this.sprite(enemy.frame);
      this.explode(enemy.motion.x - sprite.originX + Math.floor(sprite.width / 2),
        enemy.motion.y - sprite.originY + Math.floor((sprite.height - 1) / 2));
      enemy.dead = true;
      return;
    }
    if (enemy === this.boss) {
      const stageTwo = enemy instanceof StageTwoBoss;
      const stageOne = enemy instanceof StageOneBoss;
      const deathY = stageTwo ? enemy.worldY - this.camera : 0;
      enemy.dead = true;
      this.kills++;
      if (!stageOne && !stageTwo) this.bullets = [];
      this.enemies = [];
      if (stageOne || stageTwo) {
        this.ground = this.ground.filter((actor) => actor instanceof GroundPatrol
          && actor.actorAddress !== undefined && actor.firing && !actor.dead);
        if (stageOne) this.terrainWorms?.clearActors();
        else {
          enemy.children = [];
          if (this.miniboss) this.miniboss.waves = [];
        }
      } else {
        this.ground = [];
        this.scenery = [];
      }
      for (let pair = 0; pair < (stageTwo ? 10 : 9); pair++) {
        for (const value of [50, 100]) {
          this.addPickup({ kind: "credit", counted: true, value, age: 0, state: 7,
            x: this.randomWord() % 300 + 10, y: this.randomWord() % 180 + 6 });
        }
      }
      for (let i = 0; i < (stageTwo ? 30 : 20); i++) {
        this.explode((stageTwo ? 80 : 0) + this.randomWord() % (stageTwo ? 160 : 320),
          deathY + this.randomWord() % (stageTwo ? 112 : 192), true, stageOne || stageTwo);
      }
      if (stageOne || stageTwo) this.run.actorPool.collect(this.actorLists, ActorList.main, () => true);
      return;
    }
    if (enemy.ground) {
      this.score += enemy.definition.score ?? 100;
      this.kills++;
      const stageOnePooled = this.stage === 1 && enemy.actorAddress !== undefined
        && (enemy instanceof GroundGun || enemy instanceof GroundPatrol);
      if (enemy.spriteActor) {
        const sprite = this.sprite(recycled ? this.pickupFrame(recycled) : enemy.frame);
        const { x, y } = recycled ?? enemy.motion;
        const corridor = enemy instanceof StageFourCorridorActor;
        const record = this.explode(x - sprite.originX + Math.floor(sprite.width / 2),
          y - sprite.originY + Math.floor((sprite.height - 1) / 2),
          enemy.definition.large, stageOnePooled || this.stage === 2 || corridor);
        if (stageOnePooled && record?.address === enemy.actorAddress) record.actor.dead = true;
        if (corridor && enemy.actorAddress !== undefined) {
          const records = this.run.actorPool.recordsByAddress;
          if (this.formationCredits.delete(enemy.formationId)) {
            const source = records.get(enemy.actorAddress).actor;
            this.addPickup({ x: source.x ?? x, y: source.y ?? y, kind: "credit", value: 50, age: 0,
              state: 7, direction: this.randomWord() }, true);
          }
          // CS:3b4d marks the source address after the blast and any credit have taken their slots.
          records.get(enemy.actorAddress).actor.dead = true;
        }
      } else {
        const offset = enemy.definition.explosion || 16;
        const x = (recycled?.x ?? enemy.x) + offset;
        const y = (recycled?.y ?? enemy.worldY) - this.camera + offset;
        let tiles = enemy.definition.death[enemy.side];
        if (stageOnePooled) {
          const record = this.explode(x, y, true, true);
          if (record?.address === enemy.actorAddress) {
            // CS:3bb4 reads the new animation cursor instead of the overwritten tile pointer.
            tiles = record.actor.frames.slice(1, 3)
              .flatMap(({ offset, bank, duration }) => [(offset + 8) | bank, duration]);
            record.actor.dead = true;
          }
          this.patchGround(enemy, tiles);
        } else {
          const pooled = this.stage === 4 && enemy instanceof GroundGun && enemy.actorAddress !== undefined;
          if (pooled) {
            const record = this.explode(x, y, true, true);
            const selfReuse = record?.address === enemy.actorAddress;
            // CS:c70f chooses the tiles from the type still in the gun's address after allocation.
            if (recycled || selfReuse) tiles = enemy.definition.death[0];
            if (selfReuse) record.actor.dead = true;
          }
          this.patchGround(enemy, tiles);
          if (!pooled) this.explode(x, y, true);
        }
      }
      if (recycled) recycled.dead = true;
      enemy.dead = true;
      return;
    }
    if (enemy.type === 0) {
      const { x, y } = enemy.motion;
      const drop = this.addPickup({ x, y, kind: "reward", reward: enemy.reward, age: 0, state: 7 },
        this.stage <= 2 || (this.stage === 4 && enemy.actorAddress !== undefined));
      if ((this.stage === 1 || this.stage === 4) && drop && drop.address === enemy.actorAddress) drop.actor.dead = true;
      enemy.dead = true;
      return;
    }
    this.destroyFormation(enemy);
  }

  destroyFormation(enemy, frame = this.enemyFrame(enemy), { x, y } = enemy.motion) {
    this.score += enemy.parts[0].score;
    this.kills++;
    const sprite = this.sprite(frame);
    const large = Boolean(enemy.parts[0].flags & 255);
    const pooled = enemy.actorAddress !== undefined && (this.stage === 1 || this.stage === 4);
    const blast = this.addExplosion({
      x: x - sprite.originX + Math.floor(sprite.width / 2),
      y: y - sprite.originY + Math.floor((sprite.height - 1) / 2),
      large, frames: this.assets.logic.explosions[Number(large)], age: 0,
    }, pooled || this.stage === 2);
    let replacement = pooled && blast?.address === enemy.actorAddress ? blast : undefined;
    this.sounds.push(large ? "explosion-large" : "explosion");
    if (enemy.formation) {
      enemy.formation.remaining--;
      const { formationId } = enemy;
      let award = !enemy.formation.remaining && !enemy.formation.escaped;
      if (formationId !== undefined) {
        // CS:3ae3 counts only registered groups; past capacity or after Z, there is no entry.
        const remaining = this.formationCredits.get(formationId);
        award = remaining === 1;
        if (award) this.formationCredits.delete(formationId);
        else if (remaining !== undefined) this.formationCredits.set(formationId, (remaining - 1) & 65535);
      }
      if (award) {
        const direction = this.randomWord();
        // The drop reads the dying address after blast allocation, when it may hold the blast's coordinates.
        const drop = this.addPickup({ x: replacement?.actor.x ?? x, y: replacement?.actor.y ?? y,
          kind: "credit", value: large ? 100 : 50, age: 0, state: 7,
          direction: pooled ? direction : direction & 7 }, pooled || this.stage <= 2);
        if (pooled && drop?.address === enemy.actorAddress) replacement = drop;
      }
      enemy.dead = true;
      for (const child of enemy.children || []) child.dead = true;
    }
    if (replacement) replacement.actor.dead = true;
  }

  resetDive() {
    this.diveTime = this.divePhase = this.diveStep = this.divePose = this.terrainRecovery = this.posture = 0;
    this.mountPosture = 0;
    this.mountShipSprite = undefined;
    this.diveMeterTime = undefined;
    this.diveMasked = false;
    this.shipContactBox = undefined;
    this.shipHitFlash = false;
    this.maneuverJetBits = 0;
    this.shipHistory = Array(TERRAIN_HISTORY).fill({ camera: this.camera, x: this.player.x, y: this.player.y });
  }

  // CS:1e29 tests the alignment-specific hull against the OR of the tile's four planes.
  shipTouchesTerrain(player = this.player) {
    const left = player.x - 14, top = player.y + this.camera - 14;
    const column = left >> 4;
    const mask = this.assets.logic.terrainHull[left & 15];
    for (let line = 0; line < 25; line++) {
      const worldY = top + line;
      const row = worldY >> 4;
      if (row < 0 || row >= this.map.length / 20) continue;
      for (let word = 0; word < 3; word++) {
        const bits = mask[line * 3 + word];
        if (!bits || column + word < 0 || column + word >= 20) continue;
        const tile = this.map[row * 20 + column + word] >>> 6;
        if (bits & this.assets.terrainMasks[tile]?.[worldY & 15]) return true;
      }
    }
    return false;
  }

  moveShip(input) {
    const { player, control } = this;
    const scroll = control.scrollDirection ?? 1;
    if (this.terrainRecovery < 0 && !this.shipTouchesTerrain()) this.terrainRecovery = 0;
    if (this.terrainRecovery) {
      const directions = playerDirections(player, input);
      if (this.terrainRecovery === -TERRAIN_HISTORY) {
        if (!this.countedCredits) this.killPlayer();
        return { ...directions, scroll };
      }
      // CS:43d7 replays an older world position and scrolls the excess past the screen limits.
      const sample = this.shipHistory[1];
      const y = sample.camera + sample.y - this.camera;
      player.x = sample.x;
      player.y = Math.max(16, Math.min(176, y));
      this.shipHistory.shift();
      this.shipHistory.push(this.shipHistory.at(-1));
      this.terrainRecovery = this.terrainRecovery - 1 || -1;
      return { ...directions, scroll: scroll - (y - player.y) };
    }
    const directions = movePlayer(player, input, control);
    this.shipHistory.pop();
    this.shipHistory.unshift({ camera: this.camera, x: player.x, y: player.y });
    if (!this.divePhase && this.shipTouchesTerrain()) {
      // CS:4462 arms an unconditional one-sample rewind, even if terrain moves away.
      this.terrainRecovery = 1;
      control.bank = player.bank = 0;
      control.ceiling = Math.max(control.ceiling, this.camera + BACKTRACK_PIXELS);
    }
    return directions;
  }

  shipSprite(pose = 0) {
    const { diveFrames, playerBank } = this.assets.logic;
    return this.sprite(pose ? diveFrames[pose] : playerBank[this.control.bank + 6]);
  }

  resetInvulnerability() {
    this.invincible = 0;
    this.invulnerabilityActor = this.invulnerabilityMeterTime = undefined;
  }

  newInvulnerabilityRing() {
    return { kind: "invulnerability-ring", x: this.player.x, y: this.player.y,
      frame: this.assets.logic.invulnerabilityRing[0],
      age: 0, born: this.tick };
  }

  grantInvulnerability() {
    if (!this.invincible) {
      // CS:2b80 installs a new callback even though the pickup also has type 0x5c.
      const ring = this.newInvulnerabilityRing();
      if (this.stage === 2 && !this.run.actorPool.allocate(this.actorLists, ActorList.transient, 0x5c, ring)) return;
      this.invulnerabilityActor = ring;
    }
    this.invincible = (this.invincible + INVULNERABILITY_TICKS) & 65535;
  }

  updateInvulnerability(ring) {
    if (!this.invincible) {
      ring.dead = true;
      return;
    }
    ring.frame = frameAt(this.assets.logic.invulnerabilityRing, ++ring.age);
    ring.x = this.player.x;
    ring.y = this.player.y;
    ring.hidden = this.posture === 16;
    if (ring.hidden) return;
    if (!this.posture) {
      this.invulnerabilityMeterTime = --this.invincible;
      if (!this.invincible) ring.dead = true;
      return;
    }
    const ship = this.status === "dying" ? this.sprite(frameAt(this.assets.logic.playerDeath, this.deathAge))
      : this.shipSprite(this.divePose);
    const sprite = this.sprite(ring.frame);
    const shipX = (ship.width >> 1) - ship.originX;
    const shipY = ((ship.height - 1) >> 1) - ship.originY;
    const ringX = (sprite.width >> 1) - sprite.originX;
    const ringY = ((sprite.height - 1) >> 1) - sprite.originY;
    ring.x += shipX + this.posture * (ringX - shipX);
    ring.y += shipY + this.posture * (ringY - shipY);
  }

  // CS:44b4 selects a pose before advancing the phase read by later actors.
  advanceDivePose() {
    this.divePose = this.divePhase;
    this.diveMasked = this.divePhase === 4 && !this.diveStep;
    if (this.divePhase) this.divePhase += this.diveStep;
    if (this.divePhase === 4) this.diveStep = 0;
    if (this.divePose && !this.divePhase) {
      this.diveStep = 0;
      this.terrainRecovery = -15;
    }
  }

  // CS:4675 advances posture and the meters even during ship death.
  updatePostureAndMeters() {
    if (this.status === "dying" || this.divePhase) this.posture = Math.min(16, this.posture + 1);
    else this.posture = Math.max(0, this.posture - 1);
    this.shadesMeterTime = this.player.shades ? --this.player.shades : undefined;
    this.diveMeterTime = this.diveTime ? --this.diveTime : undefined;
    if (this.diveMeterTime === 0) {
      this.diveStep = -1;
      this.sounds.push("dive");
    }
  }

  requestDive() {
    if (this.divePhase) this.diveTime = 1;
    else if (this.player.dives) {
      this.player.dives--;
      this.divePhase = this.diveStep = 1;
      this.diveTime = DIVE_TICKS;
      this.sounds.push("dive");
    }
  }

  dispatchCameraEvents() {
    // CS:3615 only scans background once foreground has reached a new low.
    if (this.eventStreamsClosed || this.camera >= this.foregroundEventLimit) return;
    const pool = this.run.actorPool;
    const groupIds = this.run.formationClock.ids;
    for (const event of this.assets.events) {
      if (event[0] < this.camera || event[0] >= this.foregroundEventLimit) continue;
      this.saveActorPaint();
      this.spawn(event, groupIds);
    }
    this.foregroundEventLimit = this.camera;
    for (const event of this.assets.background || []) {
      if (event[0] < this.camera || event[0] >= this.backgroundEventLimit) continue;
      this.saveActorPaint();
      if (!event[1]) {
        this.saveCheckpoint(event);
        continue;
      }
      if (event[1] === this.boss?.definition.eventType) {
        if (this.boss instanceof StageFiveBoss || this.boss instanceof StageFourBoss) this.boss.spawn(this);
        else this.boss.spawn(this.camera);
        continue;
      }
      if (event[1] === this.miniboss?.definition.eventType) {
        if (this.miniboss instanceof StageFourMiniboss) this.miniboss.spawn(this);
        else this.miniboss.spawn(this.camera, event);
        continue;
      }
      const definition = this.assets.groundLogic?.get(event[1]);
      if (!definition) continue;
      if (["barrier", "swivel-turret", "ring-turret", "ring-wave", "wall-patrol"].includes(definition.kind)) {
        spawnStageFiveGround(event, definition, this);
        continue;
      }
      if (definition.kind === "wall-ram") {
        const ram = new GroundWallRam(event, definition, this.camera);
        const slot = pool.allocate(this.actorLists, ActorList.scenery, ram.side ? 0x110 : 0x10c, ram);
        if (slot) {
          pool.fireCounterLowBytes.set(slot.address, 0);
          pool.fireCounterHighBytes.set(slot.address, 0);
          this.scenery.unshift(ram);
        }
        continue;
      }
      if (definition.kind === "hatch") {
        const hatch = new GroundHatch(event, definition);
        const type = hatch.type === 2 ? (hatch.side ? 0xf0 : 0xf4) : hatch.type === 4 ? 0xfc : 0xf8;
        if (!pool.allocate(this.actorLists, ActorList.scenery, type, hatch)) continue;
        this.scenery.unshift(hatch);
        if (hatch.patches) this.patchGround(hatch, hatch.patches);
        continue;
      }
      const Constructor = { arm: GroundArm, skater: GroundSkater, "wall-crawler": GroundCrawler,
        "terrain-turret": GroundTurret, "wall-hunter": GroundWallHunter }[definition.kind];
      if (Constructor) {
        const actor = new Constructor(event, definition, this.camera, (frame) => this.sprite(frame));
        if (actor instanceof GroundWallHunter) {
          const slot = pool.allocate(this.actorLists, ActorList.main, actor.side ? 0xe4 : 0xe0, actor);
          if (!slot) continue;
          pool.fireCounterLowBytes.set(slot.address, 0);
          pool.fireCounterHighBytes.set(slot.address, definition.fireCounterHighByte);
          pool.contactFlags.set(slot.address, 255);
        }
        this.ground.push(...(actor.chain || [actor]));
        if (actor.patches) this.patchGround(actor, actor.patches);
        continue;
      }
      const gun = definition.kind === "patrol"
        ? new GroundPatrol(event, definition, this.camera, (frame) => this.sprite(frame))
        : new GroundGun(event, this.assets.groundLogic);
      if (this.stage === 2) {
        const type = (gun.spriteActor ? 0x100 : 0xe8) + (gun.side ? 0 : 4);
        if (!this.addStageTwoBossActor(gun, type)) continue;
      } else if (this.terrainWorms) {
        const type = gun instanceof GroundPatrol ? 0xd0 + 4 * gun.side
          : [0xe8, 0xe0, 0xd8][gun.type - 1] + (gun.side ? 0 : 4);
        if (!pool.allocate(this.actorLists, ActorList.main, type, gun)) continue;
      } else if (this.stage === 4) {
        const slot = pool.allocate(this.actorLists, ActorList.main, gun.side ? 0xd0 : 0xd4, gun);
        if (!slot) continue;
        pool.fireCounterLowBytes.set(slot.address, 0);
        pool.fireCounterHighBytes.set(slot.address, 0);
      }
      if (this.stage === 5) this.ground.unshift(gun);
      else this.ground.push(gun);
      if (!gun.spriteActor) this.patchGround(gun, gun.patches);
    }
    this.backgroundEventLimit = Math.min(this.backgroundEventLimit, this.camera);
  }

  update(input = {}) {
    if (this.status === "ready") {
      this.runScreen?.attractFrame(this.highScores);
      return;
    }
    if (this.status === "menu") {
      this.runScreen.menuFrame(this.menuSelection, input.music ?? true);
      if ((input.up || input.down) && --this.menuRepeat <= 0) this.moveMenu(input.up ? -1 : 1);
      return;
    }
    if (this.status === "stage-loading") {
      this.enterTurn();
      return;
    }
    if (this.status === "turn-ready") {
      this.runScreen?.readyFrame(this.playerNumber);
      return;
    }
    if (this.status === "turn-over" || this.status === "gameover") {
      if (!this.runScreen) return;
      if (this.runScreen.age < GAME_OVER_TICKS) this.runScreen.gameOverFrame();
      else if (this.status === "turn-over") this.finishTurn();
      else {
        // CS:3f97 returns to attract mode when neither seat remains alive.
        this.status = "ready";
        this.openAttract();
      }
      return;
    }
    if (this.status === "score-entry" || this.status === "score-table") {
      if (this.runScreen.updateScores(input) && !this.closeScores()) this.offerContinue();
      return;
    }
    if (this.status === "continue") {
      if (!--this.continueTicks) this.showGameOver();
      else this.runScreen?.continueFrame(this.continueTicks, this.continues);
      return;
    }
    const wasDying = this.status === "dying";
    if (!wasDying && this.status !== "playing") return;
    this.shipHitFlash = false;
    this.actorPaint = undefined;
    this.nashwanExpiryFrame = this.nashwanMeterTime = undefined;
    this.invulnerabilityMeterTime = undefined;
    const pool = this.run.actorPool;
    // CS:373d counts the linked main list before the stage-four corridor spawns or the HUD updates.
    let population = this.stage === 4 ? this.stageFourHomingPopulation() : 0;
    this.tick++;
    const formationClock = this.run.formationClock;
    if (!(++formationClock.tick & 3)) {
      formationClock.ids = [formationClock.next, (formationClock.next + 1) & 65535];
      formationClock.next = (formationClock.next + 2) & 65535;
    }
    const player = this.player;
    this.mountPosture = this.posture;
    const shipExposed = !this.divePhase;
    // CS:4311 refreshes the sprite box before steering; CS:42ae reuses it on the last ascent tick.
    if (!wasDying && shipExposed) {
      this.shipContactBox = this.bounds(this.shipSprite(this.divePose), player.x, player.y);
    }
    if (this.rearFiring) {
      this.rearFrame = (this.rearFrame + 1) % this.assets.logic.rearAttachment.length;
      if (!this.rearFrame) this.rearFiring = false;
    }
    const shades = player.shades > 0;
    const earlyContact = !wasDying && shipExposed && (this.stage === 2 ? this.contactStageTwoShip(shades)
      : this.stage === 4 ? this.contactStageFourShip(shades) : !shades && this.contactStageOneShip());
    if (this.stage !== 2 && this.stage !== 4 && shades && !wasDying && shipExposed) {
      // CS:4356 replaces ship contact with one 127-damage search over inclusive edges.
      this.hitFirstInBox({ shades: true, damage: 127 }, { x: player.x - 64, y: player.y - 64, w: 129, h: 129 });
    }
    const dying = this.status === "dying";
    const previousX = player.x, previousY = player.y;
    this.playerTrail.shift();
    this.playerTrail.push({ x: player.x, y: player.y });
    this.control.camera = this.camera;
    if (!this.eventStreamsClosed) this.terrainWorms?.dispatch(this, this.camera);
    let directions;
    if (dying) {
      this.control.delta = this.control.scroll = 0;
      directions = playerDirections(player, input);
      input = {};
    } else {
      directions = this.moveShip(input);
      scrollMap(this.control, directions.scroll, directions.down, this.endCamera);
    }
    this.camera = this.control.camera;
    if (this.assets.logic.corridor) dispatchStageFourCorridor(this);
    if (this.boss instanceof StageThreeBoss) this.boss.update(this);
    // CS:373d counts main-list roots before CS:7f32 dispatches arena waves.
    if (this.stage === 2) population = (this.actorLists.get(ActorList.main) || [])
      .filter(({ actor, type }) => type !== 0x50 && type !== 0x54 && !actor.foregroundRoot).length;
    if (this.miniboss instanceof StageTwoMiniboss) this.miniboss.dispatch(this);
    else if (this.miniboss instanceof StageThreeMiniboss) this.miniboss.update(this);
    if (!dying) this.advanceDivePose();
    this.maneuverJetBits = this.divePhase ? 0 : (directions.up ? 1 : 0) | (directions.down ? 2 : 0);
    this.mountShipSprite = dying ? this.sprite(frameAt(this.assets.logic.playerDeath, this.deathAge))
      : this.shipSprite(this.divePose);
    const fire = input.fire && (!this.fireHeld
      || (this.fireCooldown -= player.autofire + 1) <= 0);
    if (!input.fire || !this.fireHeld) this.fireCooldown = this.firePeriod;
    else if (fire) this.fireCooldown += this.firePeriod;
    this.fireHeld = Boolean(input.fire);
    const linkedMounts = this.stage <= 2 || this.stage === 4;
    if (!linkedMounts) {
      pool.collect(this.actorLists, ActorList.mounts);
      updateWeaponMounts(this, fire, input.fire);
      updateMine(this, input.fire, directions || {}, previousX, previousY);
      if (fire) fireWeapons(this);
      updateCannons(this, fire);
      updateLaserAndDrone(this, fire, input.fire);
    }
    const hull = { x: player.x - 6, y: player.y - 21, w: 12, h: 17 };
    // The last stage-one maneuver jet (CS:4759) leaves its unsigned bank index in BX.
    let aimOperand = this.stage === 1 ? Math.abs(this.control.bank) * 2 : 0;
    const randomWord = () => this.randomWord();
    if (this.terrainWorms) aimOperand = this.terrainWorms.update(this, this.control.delta, aimOperand, (list, record, operand) => {
      const { actor } = record;
      if (list === ActorList.transient) this.updateTransientActor(record, hull);
      else if (actor.dead) pool.release(this.actorLists, list, record);
      else if (actor === this.boss) {
        return actor.updateCore(this.camera, this.control, this.tick, () => actor.activate(this), operand);
      } else if (actor.stageOneBoss) {
        const { bullet, aimOperand: nextOperand } = actor.stageOneBoss.updateArm(actor, this.camera, randomWord, player, pool, operand);
        this.saveActorMotion(actor, actor);
        pool.movementBudgets.set(actor.actorAddress, actor.speed);
        if (bullet) this.addPooledHostileRound(bullet, 4);
        return nextOperand;
      } else if (actor instanceof GroundGun || actor instanceof GroundPatrol) {
        return this.updateGroundActor(actor, operand);
      } else if (actor.parts) {
        return this.updateForeground(actor, operand);
      }
      return operand;
    });
    if (this.stage === 2) {
      const patchGround = (cell, tile) => this.patchGround({ cell }, [tile]);
      const addActor = (actor, type) => this.addStageTwoBossActor(actor, type);
      for (const [list, slot] of pool.walk(this.actorLists, ActorList.main, ActorList.transient)) {
        if (list === ActorList.transient) {
          this.updateTransientActor(slot, hull, population);
          continue;
        }
        const { actor, type } = slot;
        if (actor.dead || actor.foregroundRoot?.dead) pool.release(this.actorLists, ActorList.main, slot);
        else if (type === 0x50) {
          if (actor === this.boss) actor.updateCore(this.camera, this.control, randomWord, player,
            this.tick, population, (round) => this.addPooledHostileRound(round), addActor);
        } else if (type === 0x54) {
          if (actor.miniboss === this.miniboss) this.miniboss.updateEye(actor, this);
        } else if (actor.wave) actor.miniboss.updateWave(actor, this);
        else if (type === 0x10c) this.boss.updateEgg(actor, this.camera, this.control.delta, randomWord, addActor);
        else if (type === 0x110) {
          const rounds = this.boss.updateCrawler(actor, this.camera, this.control, randomWord,
            player, this.tick, patchGround);
          this.savePooledBounds(actor);
          for (const round of rounds) this.addPooledHostileRound(round);
        } else if (actor.ground) this.updateGroundActor(actor);
        else aimOperand = this.updateForeground(actor, aimOperand);
      }
      if (this.boss?.children) this.boss.children = this.boss.children.filter((actor) => !actor.dead);
    }
    if (this.stage === 4) {
      for (const [list, slot] of pool.walk(this.actorLists, ActorList.main, ActorList.transient)) {
        if (list === ActorList.main) aimOperand = this.updateStageFourMainActor(slot, aimOperand);
        else this.updateTransientActor(slot, hull, population);
      }
    }
    if (linkedMounts) {
      updateLinkedMounts(this, fire, input.fire, directions || {}, previousX, previousY);
    }
    for (const gun of this.stage === 5 ? this.ground.slice() : this.ground) {
      if (gun.actorAddress === undefined) this.updateGroundActor(gun);
    }
    if (this.miniboss instanceof StageFiveMiniboss) this.miniboss.update(this);
    if (this.boss instanceof StageFiveBoss) this.boss.update(this);
    for (let index = this.enemies.length - 1; index >= 0; index--) {
      const enemy = this.enemies[index];
      if (enemy.actorAddress !== undefined) continue;
      aimOperand = this.updateForeground(enemy, aimOperand);
      for (const child of enemy.children) aimOperand = this.updateForeground(child, aimOperand);
    }
    if (!linkedMounts) {
      updateElectroBall(this, input.fire, player.x - previousX, player.y - previousY);
    }
    for (const shot of this.shots) {
      if (shot.actorAddress !== undefined || shot.dead) continue;
      if (shot.mine) {
        shot.frame = frameAt(shot.frames, ++shot.age);
        if (this.status === "dying") shot.dead = true;
        else if (!input.fire && !++shot.fuse) this.blastMine(shot);
        continue;
      }
      if (this.status === "dying") { shot.dead = true; continue; }
      shot.age = (shot.age || 0) + 1;
      if (shot.bomb) {
        shot.frame = frameAt(shot.frames, shot.age);
        if (stepBomb(shot)) this.blastBomb(shot);
        continue;
      }
      if (shot.flame) {
        this.updateFlame(shot);
        continue;
      }
      if (shot.homing) {
        this.stepHomingMissile(shot);
        continue;
      }
      const beamBox = shot.beam ? moveLaserBeam(shot) : undefined;
      if (shot.dead) continue;
      if (!shot.beam) {
        shot.x += shot.dx || 0;
        shot.y += shot.dy ?? -6;
      }
      if (shot.frames) shot.frame = frameAt(shot.frames, shot.age);
      if ((shot.cannon && shot.y < 0) || (shot.point
        && (shot.x < 0 || shot.x >= 312 || shot.y < 0 || shot.y >= PLAY_HEIGHT))) {
        shot.dead = true;
        continue;
      }
      if (shot.age >= (shot.ttl || 120)) {
        shot.dead = true;
        continue;
      }
      const shotBox = beamBox || (shot.frame ? this.bounds(this.sprite(shot.frame), shot.x, shot.y)
        : { x: shot.x - 1, y: shot.y - 4, w: 3, h: 8 });
      if (!shotBox.h) continue;
      const impact = shot.point ? { x: shot.x, y: shot.y, w: 1, h: 1 } : shotBox;
      if (this.terrainWorms && (shot.point || shot.cannon)) {
        this.hitPlayerRound(shot, impact);
        continue;
      }
      let hitTarget = false;
      for (const enemy of this.stage === 4 ? this.mainTargets : this.targets) {
        if (enemy.dead || (enemy.terrainWorm && enemy.hidden) || shot.hits?.has(enemy)) continue;
        const bounds = this.targetBounds(enemy);
        if (shot.point ? shot.x < bounds.x || shot.x >= bounds.x + bounds.w
          || shot.y < bounds.y || shot.y >= bounds.y + bounds.h
          : !intersects(shotBox, bounds)) continue;
        hitTarget = true;
        if (!shot.cannon) {
          shot.hits ||= new Set();
          shot.hits.add(enemy);
        }
        shot.dead = !shot.piercing;
        this.hitWithWeapon(enemy, shot, shotBox);
        if (shot.dead || shot.cannon) break;
      }
      if (!shot.dead && !(shot.cannon && hitTarget)) {
        const terrain = this.boss?.terrainTarget?.(impact, this.camera);
        if (terrain) {
          this.boss.destroyTerrain(terrain, this);
          shot.dead = !shot.piercing;
        }
      }
    }
    const alternate = this.stage === 4 ? ActorList.main : undefined;
    for (const [list, slot] of pool.walk(this.actorLists, ActorList.transient, alternate)) {
      if (list === ActorList.main) aimOperand = this.updateStageFourMainActor(slot, aimOperand);
      else this.updateTransientActor(slot, hull, population);
    }
    for (const bullet of this.bullets) {
      if (bullet.actorAddress === undefined) this.updateEnemyRound(bullet, hull);
    }
    let hullContact = false;
    for (const enemy of this.targets) {
      if (this.status !== "playing" || !shipExposed || shades || earlyContact) break;
      if ((this.stage <= 2 || this.stage === 4) && enemy.actorAddress !== undefined) continue;
      if (enemy.dead || enemy.terrainWorm) continue;
      if (!intersects(hull, enemy === this.boss ? enemy.bodyBox : this.targetBounds(enemy))) continue;
      hullContact = true;
      const protectedAtContact = this.invincible;
      this.damage(enemy.definition?.contactDamage);
      if (enemy.definition?.kind === "swarm") {
        if (protectedAtContact && this.status === "playing") {
          const sprite = this.sprite(enemy.frame);
          this.explode(enemy.motion.x - sprite.originX + Math.floor(sprite.width / 2),
            enemy.motion.y - sprite.originY + Math.floor((sprite.height - 1) / 2));
        }
        enemy.dead = true;
      }
      if (this.status !== "playing") break;
      if (enemy.type === 0 && !enemy.ground) this.destroy(enemy);
      else if (!enemy.ground && enemy.parts) this.hitWithWeapon(enemy, { damage: 127 }, hull);
      else if (enemy.definition?.kind === "hatchling") this.destroy(enemy);
      else if ((enemy.wave || enemy.bossOwner || enemy instanceof GroundStageFiveSprite
        || enemy.miniboss instanceof StageFiveMiniboss
        || (enemy.finalBoss instanceof StageFiveBoss && !enemy.indestructible && enemy.definition.kind !== "core")
        || ["arm", "skater", "wall-crawler", "terrain-turret", "wall-hunter"].includes(enemy.definition?.kind))) {
        enemy.health -= 127;
        if (enemy.health <= 0) this.destroy(enemy);
      }
      break;
    }
    if (this.stage !== 2 && this.status === "playing" && !earlyContact && !hullContact && shipExposed && !shades) {
      const terrain = this.boss?.terrainTarget?.(hull, this.camera);
      if (terrain) {
        this.damage();
        if (this.status === "playing") this.boss.destroyTerrain(terrain, this);
      }
    }
    for (const pickup of this.pickups) {
      if (pickup.actorAddress === undefined) this.updatePickup(pickup, hull);
    }
    if (this.miniboss instanceof StageTwoMiniboss) {
      this.miniboss.waves = this.miniboss.waves.filter((actor) => !actor.dead);
      this.miniboss.corpses = this.miniboss.corpses.filter((actor) => !actor.dead);
    }
    for (const effect of this.effects) if (effect.actorAddress === undefined) effect.age++;
    // CS:36a9 updates map-only actors after the main actors and pickups.
    if (this.stage === 4) this.updateStageFourScenery(randomWord);
    else {
      pool.collect(this.actorLists, ActorList.scenery);
      for (const hatch of this.scenery) {
        if (hatch.dead) continue;
        const spawned = hatch.update(this.camera, this.control.ceiling, this.tick, randomWord);
        if (hatch.patches) this.patchGround(hatch, hatch.patches);
        for (const spawn of spawned) {
          const creature = new GroundCreature(spawn, (frame) => this.sprite(frame));
          const type = spawn.definition.kind === "swarm" ? 0x108 : spawn.definition.large ? 0xe0 : 0xe4;
          if (!pool.allocate(this.actorLists, ActorList.main, type, creature)) continue;
          creature.actorPhase = creature.actorAddress & 15;
          this.ground.unshift(creature);
        }
      }
    }
    if (this.invincible && this.invulnerabilityActor?.actorAddress === undefined
      && this.invulnerabilityActor?.born !== this.tick) {
      this.invulnerabilityActor ??= this.newInvulnerabilityRing();
      this.updateInvulnerability(this.invulnerabilityActor);
    }
    this.updatePostureAndMeters();
    // CS:46e4 expires the loan after it has painted, but before the Drone pass.
    if (player.nashwan) {
      this.nashwanMeterTime = --player.nashwan;
      if (!player.nashwan && this.nashwan) {
        this.nashwanExpiryFrame = { inventory: this.inventory };
        if (linkedMounts) {
          this.nashwanExpiryFrame.mounts = this.actorLists.get(ActorList.mounts)?.slice();
          this.nashwanExpiryFrame.transient = this.actorLists.get(ActorList.transient)?.slice();
        }
        suspendNashwan(this);
      }
    }
    this.retireFormationCredits();
    // CS:0a95 steps the separate Drone table after the actor passes, even during ship death.
    this.updateDroneRounds();
    // CS:3615 dispatches foreground, then background events after painting and Drone damage.
    this.dispatchCameraEvents();
    this.scenery = this.scenery.filter((hatch) => !hatch.dead);
    this.enemies = this.enemies.filter((enemy) => !enemy.dead);
    this.ground = this.ground.filter((enemy) => !enemy.dead);
    this.shots = this.shots.filter((shot) => !shot.dead && shot.y > -40 && shot.y < 230
      && shot.x > -40 && shot.x < 360);
    this.bullets = this.bullets.filter((bullet) => !bullet.dead && (bullet.beamLength !== undefined
      || bullet instanceof StageFourCorridorPod
      || (bullet.x > -10 && bullet.x < 330 && bullet.y > -10 && bullet.y < 205)));
    // CS:1022 can recycle a drop without running its countdown callback.
    this.pickups = this.pickups.filter((pickup) => !pickup.dead
      && (pickup.state !== undefined || (pickup.y < 210 && pickup.age < 700)));
    this.effects = this.effects.filter((effect) => !effect.dead && effect.age < (effect.frames?.length ?? 28));
    if (this.status === "dying") {
      if (wasDying && ++this.deathAge === DEATH_TICKS) this.finishDeath();
      return;
    }
    if (input.dive) this.requestDive();
    this.checkShop();
    if (this.miniboss?.shopPending && !this.countedCredits && this.status === "playing") {
      this.miniboss.shopPending = false;
      this.openShop(this.stage);
    }
    if (this.boss?.dead && !this.boss.rewardsPending && !this.countedCredits && this.status === "playing") {
      if (this.stage < (this.campaign.stages?.length || 1)) this.openShop(this.stage + 1);
      else if (this.boss instanceof StageFiveBoss) this.beginVictory();
      else this.status = "complete";
    } else if (!this.boss && this.endCamera <= END_CAMERA && (!this.miniboss?.definition.floor || this.miniboss.dead)
      && this.camera === this.endCamera) {
      this.endWait++;
      if ((!this.enemies.length || this.endWait > 550) && this.status === "playing") {
        const moreStages = this.stage < (this.campaign.stages?.length || 1);
        if (moreStages) this.openShop(this.stage + 1);
        else this.status = "complete";
      }
    }
  }

  stageFourHomingPopulation() {
    const main = this.actorLists.get(ActorList.main) || [];
    const actors = main.map(({ actor }) => actor);
    let count = 0;
    for (let index = 0; index < main.length;) {
      const { actor, type } = main[index];
      if (actor.dead || (type !== 0x50 && type !== 0x54)) count++;
      const next = this.stageFourCompositeSuccessor(actors, index);
      if (next <= index) break;
      index = next;
    }
    return count;
  }

  stageFourCompositeSuccessor(targets, index) {
    const actor = targets[index];
    if (actor.dead || !(actor.parts?.[0].flags & 0xff00)) return index + 1;
    const root = targets.indexOf(actor.foregroundRoot ?? actor);
    if (root < 0) return index + 1;
    // CS:1689 follows the raw root's link; a live root skips its attached records.
    let next = root + 1;
    while (!targets[next]?.dead && targets[next]?.foregroundRoot === actor
      && (targets[next].parts[0].flags & 0xff00)) next++;
    return next;
  }

  homingTargetBox(shot, population) {
    const visible = (box) => box?.w > 0 && box.h > 0 && box.x + box.w > 0 && box.x < 320
      && box.y + box.h > 0 && box.y < PLAY_HEIGHT;
    if (shot.actorAddress !== undefined) {
      const main = this.actorLists.get(ActorList.main) || [];
      // CS:2031 reads the saved slot directly; a firing patrol keeps its last bounds.
      const { targetAddress } = shot;
      const mainLock = targetAddress === undefined ? undefined : main.find(({ address }) => address === targetAddress);
      const locked = mainLock ?? (targetAddress === undefined ? undefined
        : this.actorLists.get(ActorList.transient)?.find(({ address }) => address === targetAddress));
      // CS:8b37 disables egg bounds, even if an existing lock points to the reused slot.
      if (locked && locked.type >= 0xc8 && locked.actor.kind !== "egg"
        && !locked.actor.dead && (this.stage === 4 || !locked.actor.foregroundRoot?.dead)) {
        const { actor } = locked;
        // CS:8136 leaves a drifting wave corpse's old slot bounds untouched.
        const box = this.stage === 4 ? this.stageFourTargetBounds(actor)
          : actor.miniboss && actor.part !== undefined && !actor.wave
          ? this.run.actorPool.hitBoxes.get(targetAddress)
          : mainLock || actor instanceof GroundPatrol ? this.targetBounds(actor) : undefined;
        if (box && visible(box)) return box;
      }

      // CS:108f draws from the pre-update population and searches the current list up to five times.
      const index = this.randomWord() % Math.max(1, population);
      if (this.stage === 4) {
        const actors = main.map(({ actor }) => actor);
        let remaining = index;
        for (let pass = 0; pass < 5; pass++) {
          for (let i = 0; i < main.length;) {
            const { type, actor, address } = main[i];
            const box = this.stageFourTargetBounds(actor);
            const eligible = (type !== 0xb8 || actor.dead) && visible(box);
            const next = this.stageFourCompositeSuccessor(actors, i);
            // An attachment can point back to itself when its root no longer skips it.
            if (eligible && (remaining-- === 0 || next === i)) {
              shot.targetAddress = address;
              return box;
            }
            if (next <= i) return;
            i = next;
          }
        }
        return;
      }
      const candidates = [];
      for (const { type, actor, address } of main) {
        if ((type === 0xb8 && !actor.dead) || actor.kind === "egg") continue;
        const box = this.targetBounds(actor);
        if (visible(box)) candidates.push({ address, box });
      }
      if (index >= candidates.length * 5) return;
      const { address, box } = candidates[index % candidates.length];
      shot.targetAddress = address;
      return box;
    }

    const targets = this.targets.filter((enemy) => !enemy.dead && (!enemy.ground || enemy.spriteActor
      || enemy.boss || enemy.bossOwner));
    const box = shot.target && targets.includes(shot.target) && this.targetBounds(shot.target);
    if (box && visible(box) && !shot.target.boss && !(shot.target.parts?.[0]?.id < 0xc8)) return box;
    const index = this.randomWord() % Math.max(1, targets.filter((enemy) => !enemy.boss).length);
    const eligible = targets.filter((enemy) => visible(this.targetBounds(enemy)));
    shot.target = index < eligible.length * 5 ? eligible[index % eligible.length] : undefined;
    if (shot.target) return this.targetBounds(shot.target);
  }

  // CS:1ff3: coast, pause, then track a selected target in 45-degree steps.
  stepHomingMissile(shot, population) {
    const { launch, flight, vectors, blast, damage } = this.assets.logic.homingMissile;
    const opening = launch[shot.direction];
    shot.frame = shot.launch && shot.age < opening.duration ? opening
      : frameAt(flight[shot.direction], shot.launch ? shot.age - opening.duration : shot.age);
    let move;
    if (shot.phase > 0) move = --shot.phase >= 8;
    else {
      const box = this.homingTargetBox(shot, population);
      if (!box) {
        const pooled = shot.actorAddress !== undefined;
        const effect = { x: shot.x, y: shot.y, frames: blast, age: pooled ? 0 : -1 };
        this.addExplosion(effect, pooled);
        // CS:20f3 marks the missile's slot, even if the burst now occupies it.
        if (shot.actorAddress !== undefined && effect.actorAddress === shot.actorAddress) effect.dead = true;
        this.sounds.push("explosion");
        shot.dead = true;
        return;
      }
      if (!shot.phase || !++shot.phase) {
        const desired = shotDirection(box.x + 2 - shot.x, box.y + 2 - shot.y);
        const difference = (desired - shot.direction) & 7;
        if (difference) {
          shot.direction = (shot.direction + (difference < 4 ? 1 : -1)) & 7;
          if (shot.actorAddress !== undefined) this.run.actorPool.headings.set(shot.actorAddress, shot.direction);
          shot.phase = -3;
          shot.launch = false;
          shot.age = 0;
          shot.frame = flight[shot.direction][0];
        }
      }
      move = true;
    }
    if (move) {
      const { direction } = shot;
      const x = shot.x + vectors[direction][0];
      if (x < 0 || x >= 320) { shot.dead = true; return; }
      shot.x = x;
      const y = shot.y + vectors[direction][1];
      if (y < 0 || y >= PLAY_HEIGHT) { shot.dead = true; return; }
      shot.y = y;
    }
    const point = { x: shot.x, y: shot.y, w: 1, h: 1 };
    shot.point = true;
    shot.damage = damage;
    if (shot.actorAddress !== undefined) {
      this.hitPlayerRound(shot, point);
      return;
    }
    shot.dead = this.hitFirstInBox(shot, point);
    if (shot.dead) return;
    const terrain = this.boss?.terrainTarget?.(point, this.camera);
    if (terrain) {
      this.boss.destroyTerrain(terrain, this);
      shot.dead = true;
    }
  }

  blastBomb(shot) {
    const pooled = shot.actorAddress !== undefined;
    const { x, y } = shot;
    for (let i = 0; i < 4; i++) {
      this.addExplosion({ x: x - 20 + this.randomWord() % 40,
        y: y - 20 + this.randomWord() % 40, frames: this.assets.logic.bomb.blast, age: pooled ? 0 : -1 }, pooled);
    }
    // CS:262d marks the raw source slot, then uses its current position for the damage box.
    const source = pooled ? this.run.actorPool.recordsByAddress.get(shot.actorAddress).actor : shot;
    source.dead = true;
    this.sounds.push("explosion-large");
    const box = { x: source.x - 32, y: source.y - 32, w: 64, h: 64 };
    if (pooled) this.hitMainArea(shot, box);
    else this.hitBlastArea(shot, box);
  }

  blastMine(shot) {
    const pooled = shot.actorAddress !== undefined;
    const { x, y, power } = shot;
    const { blast, damage } = this.assets.logic.mine;
    const spread = power ? 20 : 16, offset = power ? 18 : 8;
    for (let i = 0; i < 4; i++) {
      this.addExplosion({ x: x - offset + this.randomWord() % spread,
        y: y - offset + this.randomWord() % spread, frames: blast[power], age: pooled ? 0 : -1 }, pooled);
    }
    this.sounds.push("explosion-large");
    shot.damage = damage + power * 2;
    const inset = power ? 24 : 16, size = power ? 48 : 33;
    const records = this.run.actorPool.recordsByAddress;
    const source = pooled ? records.get(shot.actorAddress).actor : shot;
    const box = { x: source.x - inset, y: source.y - inset, w: size, h: size };
    if (pooled) {
      this.hitMainArea(shot, box);
      // CS:2755 marks the source address after damage callbacks may have reused it again.
      records.get(shot.actorAddress).actor.dead = true;
      this.run.mineChargeCount--;
    } else {
      this.hitBlastArea(shot, box);
      shot.dead = true;
    }
  }

  hitBlastArea(shot, box) {
    for (const enemy of this.targets) {
      if (enemy.dead) continue;
      const bounds = this.targetBounds(enemy);
      if (bounds.w <= 0 || bounds.h <= 0 || !intersects(box, bounds)) continue;
      this.hitWithWeapon(enemy, shot, box);
      if (enemy.dead) return;
    }
    const terrain = this.boss?.terrainTarget?.(box, this.camera);
    if (terrain) this.boss.destroyTerrain(terrain, this);
  }

  hitMainArea(shot, box) {
    const stageFour = this.stage === 4;
    if (stageFour && !this.hitStageFourLinkedArea(shot, box)) return;
    const targets = stageFour ? this.targets.filter((actor) => actor.actorAddress === undefined) : this.mainTargets;
    for (let index = 0; index < targets.length;) {
      const enemy = targets[index++];
      if (enemy.kind === "egg") continue;
      const bounds = this.targetBounds(enemy);
      if (!(bounds?.w > 0 && bounds.h > 0 && intersects(box, bounds))) continue;
      const next = targets[index];
      if (!enemy.dead && !enemy.foregroundRoot?.dead) this.hitWithWeapon(enemy, shot, box);
      if (next?.dead || next?.foregroundRoot?.dead || this.countedCredits) return;
    }
    const terrain = this.boss?.terrainTarget?.(box, this.camera);
    if (terrain) this.boss.destroyTerrain(terrain, this);
  }

  hitStageFourLinkedArea(shot, box) {
    const pool = this.run.actorPool, lists = this.actorLists, records = pool.recordsByAddress;
    const main = lists.get(ActorList.main) || [];
    const inherited = this.stageFourRewardDamageTargets(main);
    let address = main[0]?.address;
    for (let slot = records.get(address); slot?.list !== undefined; slot = records.get(address)) {
      const { actor } = slot;
      const bounds = this.stageFourTargetBounds(actor) ?? slot.retainedContactBox;
      const next = pool.nextAddress(lists, slot);
      address = next;
      if (!(bounds?.w > 0 && bounds.h > 0 && intersects(box, bounds))) continue;

      const root = actor.foregroundRoot ?? actor;
      address = this.stageFourDamageSuccessor(slot, next);
      const health = root.health;
      if (!actor.dead) {
        if (slot.list === ActorList.main) this.hitWithWeapon(actor, shot, box);
        else if (actor.kind === "reward") {
          this.damageStageFourRecycledReward(inherited.get(slot.address), actor, shot.damage || 1);
        }
      }

      // CS:1c4f tests the current type at the saved address, not the old occupant.
      const successor = records.get(address);
      if ((successor?.list !== undefined && successor.actor.dead) || this.countedCredits) return false;
      if (address === slot.address && root.health === health) address = next;
    }
    return true;
  }

  stageFourDamageSuccessor({ actor }, next) {
    if (actor.dead || !(actor.parts?.[0].flags & 0xff00)) return next;
    const pool = this.run.actorPool, records = pool.recordsByAddress;
    // CS:1689 reads the root's raw link, even when it moved lists or was freed.
    const root = actor.foregroundRoot ?? actor;
    let address = pool.nextAddress(this.actorLists, records.get(root.actorAddress));
    for (let child = records.get(address)?.actor;
      !child?.dead && child?.foregroundRoot === actor && (child.parts[0].flags & 0xff00);
      child = records.get(address)?.actor) {
      address = pool.nextAddress(this.actorLists, records.get(address));
    }
    return address;
  }

  targetBounds(enemy) {
    if (enemy.ground) return enemy.bounds(this.camera);
    return this.bounds(this.sprite(this.enemyFrame(enemy)), enemy.motion.x, enemy.motion.y);
  }

  stageFourTargetBounds(actor) {
    return actor.contactBox ?? actor.box;
  }

  hitFirstInBox(shot, bounds) {
    const stageOneTarget = shot.shades && this.findStageOneTarget(bounds);
    if (stageOneTarget) {
      if (!stageOneTarget.dead) this.hitWithWeapon(stageOneTarget, shot, bounds);
      return true;
    }
    for (const enemy of this.targets) {
      if (enemy.dead || (shot.shades && (this.stage === 1 || this.stage === 4)
        && enemy.actorAddress !== undefined)) continue;
      const box = this.targetBounds(enemy);
      if (box.w <= 0 || box.h <= 0 || !intersects(bounds, box)) continue;
      this.hitWithWeapon(enemy, shot, bounds);
      return true;
    }
    const terrain = this.boss?.terrainTarget?.(bounds, this.camera);
    if (!terrain) return false;
    this.boss.destroyTerrain(terrain, this);
    return true;
  }

  hitWithWeapon(enemy, shot, bounds, fromDrone = false) {
    if ((this.stage === 1 && enemy.stageOneBoss) || (enemy.finalBoss instanceof StageFourBoss && enemy.index >= 3)) {
      // CS:3a99 marks the source record without changing the arm or beam.
      if (shot.actorAddress !== undefined) shot.dead = true;
      return;
    }
    if (enemy.indestructible) return;
    if (enemy.acceptsHit && !enemy.acceptsHit(shot, bounds)) {
      if (enemy.miniboss instanceof StageFourMiniboss && shot.actorAddress !== undefined) shot.dead = true;
      return;
    }
    if ((this.stage === 1 || this.stage === 4) && enemy.foregroundRoot?.dead) {
      const root = enemy.foregroundRoot;
      const slot = this.run.actorPool.recordsByAddress.get(root.actorAddress);
      const replacement = slot?.actor;
      if (!replacement || replacement === root || slot.formationRoot !== root
        || (replacement.dead && slot.type !== 0x14)) return;
      const frame = replacement.kind === "reward" || replacement.kind === "credit" ? this.pickupFrame(replacement)
        : slot.type === 0x14 || slot.type === 0x30 ? replacement.frame
          : slot.type === 0x0c ? frameAt(replacement.frames, replacement.age) : undefined;
      if (frame) {
        if (fromDrone) this.saveActorPaint();
        this.damageRecycledFormationSlot(root, replacement, frame, shot.damage || 1, fromDrone);
      }
      return;
    }
    enemy = enemy.foregroundRoot || enemy;
    const stageFourPooled = this.stage === 4 && enemy.actorAddress !== undefined;
    if (fromDrone && (this.stage <= 2 || stageFourPooled)) this.saveActorPaint();
    if (((this.stage === 1 || stageFourPooled) && enemy.parts) || enemy instanceof StageOneBoss) {
      this.flashStageOneActor(enemy, fromDrone);
      for (const child of enemy.children || []) this.flashStageOneActor(child, fromDrone);
    } else if (stageFourPooled && (enemy instanceof GroundGun || enemy.finalBoss instanceof StageFourBoss)) {
      this.flashStageOneActor(enemy, fromDrone);
    } else if (stageFourPooled && enemy.miniboss instanceof StageFourMiniboss) {
      if (enemy.index === 4 || enemy.index === 5) {
        enemy.miniboss.damageCore(enemy, shot.damage || 1, this, fromDrone);
        return;
      }
      this.flashStageOneActor(enemy, fromDrone);
    } else if (this.stage === 2 && fromDrone && enemy instanceof GroundGun) {
      enemy.droneFlashTick = this.tick + 1;
    }
    enemy.hit = 3;
    if (enemy.finalBoss instanceof StageFiveBoss) enemy.finalBoss.damage(enemy, shot.damage || 1);
    else enemy.health -= shot.damage || 1;
    if (enemy.health <= 0) this.destroy(enemy);
  }

  damageRecycledFormationSlot(root, replacement, frame, damage, fromDrone) {
    // CS:3a39 follows the raw root pointer; these constructors leave its health and attachment link intact.
    root.health -= damage;
    if (root.health <= 0) {
      this.destroyFormation(root, frame, replacement);
      replacement.dead = true;
      replacement.markedFlashTick = undefined;
    } else {
      this.flashStageOneActor(replacement, fromDrone);
      // CS:3a39 can install a paint callback even on a type-4 round still in the transient list.
      if (replacement.dead && !fromDrone) replacement.markedFlashTick = this.tick;
      for (const child of root.children) this.flashStageOneActor(child, fromDrone);
    }
  }

  stageFourRewardDamageTargets(main) {
    return new Map(main.filter(({ actor }) => !actor.dead
      && (actor instanceof GroundGun || actor instanceof GroundWallHunter || actor instanceof StageFourCorridorActor
        || (actor.type !== 0 && !actor.foregroundRoot && actor.parts)))
      .map(({ address, actor }) => [address, actor]));
  }

  damageStageFourRecycledReward(previous, reward, damage) {
    if (!previous) return;
    if (previous.parts) {
      this.damageRecycledFormationSlot(previous, reward, this.pickupFrame(reward), damage, false);
      return;
    }
    previous.health -= damage;
    if (previous.health <= 0) this.destroy(previous, reward);
    else if (previous instanceof GroundGun) {
      // CS:c746 replaces the reward's sprite draw with one tile flash, then a no-op.
      reward.wallGunFlash = { tick: this.tick, tiles: previous.definition.initial[0] };
    } else {
      if (previous instanceof GroundWallHunter) {
        // CS:c555/c575 read the reward ID where the hatch index used to be.
        const [x, worldY] = previous.definition.rewardHatches[reward.reward];
        reward.wallHunterHatch = { x, worldY, width: 1, tiles: previous.definition.hatch[1] };
      }
      this.flashStageOneActor(reward, false);
    }
  }

  flashStageOneActor(actor, fromDrone) {
    // CS:3d65 runs the Drone pass after painting, so its flash belongs to the next tick.
    if (fromDrone) actor.droneFlashTick = this.tick + 1;
    else actor.flashTick = this.tick;
  }

  saveActorPaint() {
    if (this.actorPaint?.tick === this.tick && this.actorPaint.map === this.map) return;
    // Drone hits and camera events can change tiles and recycle slots after the paint pass.
    const paint = this.actorPaint = {
      tick: this.tick, camera: this.camera, map: this.map,
      mapRevision: this.mapRevision, mapPatches: new Map(this.mapPatches),
    };
    if (this.stage > 2) {
      paint.ground = this.ground.slice();
      paint.scenery = this.stage === 4 ? this.scenery.map((actor) => Object.assign(
        Object.create(Object.getPrototypeOf(actor)), actor)) : this.scenery.slice();
      paint.enemies = this.enemies.slice();
      paint.bossParts = this.boss?.parts;
      paint.minibossParts = this.miniboss?.parts;
      if (this.stage !== 4) return;
    }
    const snapshot = (records = []) => records.map(({ type, address, actor }) => ({
      type, address, actor: Object.assign(Object.create(Object.getPrototypeOf(actor)), actor),
    }));
    const records = this.actorLists.get(ActorList.main) || [];
    const main = snapshot(records);
    const copies = new Map(records.map(({ actor }, index) => [actor, main[index].actor]));
    for (const { actor } of main) {
      if (copies.has(actor.foregroundRoot)) actor.foregroundRoot = copies.get(actor.foregroundRoot);
      if (this.stage === 4 && actor.motion) {
        actor.motion = Object.assign(Object.create(Object.getPrototypeOf(actor.motion)), actor.motion);
      }
    }
    paint.main = main;
    paint.transient = snapshot(this.nashwanExpiryFrame?.transient ?? this.actorLists.get(ActorList.transient));
  }

  get targets() {
    const foreground = this.enemies.flatMap((enemy) => enemy.dead ? []
      : enemy.children?.length ? [enemy, ...enemy.children] : enemy);
    const ground = this.stage <= 2 ? this.ground.filter((actor) => !(actor instanceof GroundPatrol)
      || actor.actorAddress === undefined || !actor.firing) : this.ground;
    return [...(this.terrainWorms?.targets || []), ...foreground, ...ground, ...(this.boss?.targets || []),
      ...(this.miniboss?.targets || [])];
  }

  get mainTargets() {
    const targets = this.targets;
    if (this.stage !== 2 && this.stage !== 4) return targets;
    return [...(this.actorLists.get(ActorList.main) || []).map(({ actor }) => actor),
      ...targets.filter((actor) => actor.actorAddress === undefined)];
  }

  clearScreen() {
    // CS:2ad0 dispatches 127 damage, including wall guns and supply pods, not bosses.
    const hit = (enemy) => {
      if (enemy.dead || enemy.indestructible || enemy.boss || enemy.foregroundRoot
        || [0x50, 0x54].includes(enemy.parts?.[0].id)) return;
      if (this.stage === 1 && enemy.parts) {
        this.hitWithWeapon(enemy, { damage: 127 });
        return;
      }
      enemy.health -= 127;
      enemy.hit = 3;
      if (enemy.health <= 0) this.destroy(enemy);
    };
    if (this.stage === 1) {
      const { main, transient } = ActorList;
      const inherited = new Map((this.actorLists.get(main) || [])
        .filter(({ actor }) => !actor.dead && (actor instanceof GroundGun || actor instanceof GroundPatrol
          || (actor.type !== 0 && !actor.foregroundRoot && actor.parts)))
        .map(({ address, actor }) => [address, actor]));
      for (const [list, { address, actor }] of this.run.actorPool.walk(this.actorLists, main, transient)) {
        if (list === main) {
          // CS:69c8 marks the worm's path driver without a corpse or score.
          if (actor.wormSlot !== undefined && actor instanceof PathMotion) actor.dead = true;
          else if (actor.health !== undefined) hit(actor);
        } else if (list === transient && actor.kind === "reward" && !actor.dead) {
          // A pod can replace the saved successor but leave its damage callback and health in the slot.
          const previous = inherited.get(address);
          if (previous?.ground) {
            previous.health -= 127;
            this.destroy(previous, actor);
          } else if (previous) {
            this.damageRecycledFormationSlot(previous, actor, this.pickupFrame(actor), 127, false);
          }
        }
      }
      for (const actor of this.targets) if (actor.actorAddress === undefined) hit(actor);
    } else if (this.stage === 4) {
      this.clearStageFourLinkedActors();
      for (const actor of this.targets) if (actor.actorAddress === undefined) hit(actor);
    } else for (const actor of this.mainTargets) hit(actor);
    this.formationCredits.clear();
    for (const enemy of this.enemies) if (enemy.formation) enemy.formation.escaped = true;
    for (const bullet of this.bullets) {
      if (this.stage !== 4 || bullet.actorAddress === undefined) bullet.dead = true;
    }
    this.bullets = this.bullets.filter((bullet) => !bullet.dead);
  }

  clearStageFourLinkedActors() {
    const pool = this.run.actorPool, lists = this.actorLists, records = pool.recordsByAddress;
    const main = lists.get(ActorList.main) || [];
    const inherited = this.stageFourRewardDamageTargets(main);
    const attack = { damage: 127 };
    let address = main[0]?.address;
    for (let slot = records.get(address); slot?.list !== undefined; slot = records.get(address)) {
      const { actor, type } = slot;
      const next = pool.nextAddress(lists, slot);
      address = this.stageFourDamageSuccessor(slot, next);
      const root = actor.foregroundRoot ?? actor;
      const health = root.health;
      if (!actor.dead) {
        if (slot.list === ActorList.main && type !== 0x50 && type !== 0x54) {
          this.hitWithWeapon(actor, attack);
        } else if (actor.kind === "reward") {
          this.damageStageFourRecycledReward(inherited.get(slot.address), actor, attack.damage);
        }
      }
      if (address === slot.address && !actor.dead && root.health === health) address = next;
    }
    for (const slot of lists.get(ActorList.transient) || []) {
      if (slot.type === 0x14) slot.actor.dead = true;
    }
  }

  patchGround(gun, tiles) {
    const width = gun.patchWidth || 2;
    for (const [i, tile] of tiles.entries()) {
      const cell = gun.cell + (i % width) + Math.floor(i / width) * 20;
      if (cell < 0 || cell >= this.map.length || this.map[cell] === tile) continue;
      this.map[cell] = tile;
      this.mapPatches.set(cell, tile);
      this.mapRevision++;
    }
  }

  get progress() {
    return (START_CAMERA - this.camera) / (START_CAMERA - this.endCamera);
  }

  snapshot() {
    return {
      status: this.status, tick: this.tick, score: this.score, credits: this.credits,
      continues: this.continues, continueTicks: this.continueTicks,
      health: this.player.health, lives: this.player.lives, power: this.player.power,
      x: this.player.x, y: this.player.y, progress: this.progress,
      enemies: this.enemies.length, shots: this.shots.length + this.droneShots.filter(Boolean).length, waves: this.waves,
      stage: this.stage, stageWaves: this.stageWaves, campaignRound: this.campaignRound, dives: this.player.dives,
      divePhase: this.divePhase, divePose: this.divePose, diveTime: this.diveTime,
      inventory: this.inventory.map((weapon) => weapon && { ...weapon }),
      camera: this.camera, reverseLimit: this.control.ceiling, ground: this.ground.length,
      scenery: this.scenery.length,
      ...(this.playerCount === 2 ? { playerNumber: this.playerNumber,
        players: this.run.players.map(({ player, score, continues, status }) => ({
          lives: player.lives, score, continues, status,
        })) } : {}),
    };
  }
}

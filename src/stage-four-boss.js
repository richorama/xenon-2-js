import { ActorList } from "./actor-pool.js";
import { shotDirection } from "./boss.js";
import { followArc, sweepArc } from "./motion.js";

const disabledBox = () => ({ x: 1000, y: 0, w: 0, h: 0 });

// CS:bc00 builds a core, two turrets and a sixteen-part sweeping beam.
export class StageFourBoss {
  constructor(definition, sine, sprite) {
    this.definition = definition;
    this.sine = sine;
    this.sprite = sprite;
    this.parts = [];
    this.turrets = 0;
  }

  get phase() { return this.parts[0]?.phase ?? 0; }
  get targets() { return this.dead ? [] : this.parts; }

  spawn(game) {
    if (this.parts.length) return;
    const { camera, actorLists, run: { actorPool: pool } } = game;
    this.parts = this.definition.parts.map((part, index) => {
      const actor = {
        index, definition: { contactDamage: 16 },
        motion: { x: part.x, y: part.y - camera }, health: part.health,
        finalBoss: this, boss: true, ground: true, indestructible: index >= 3,
        counter: 0, direction: 0, phase: 0, box: disabledBox(),
        heading: 0, turn: 0, acceleration: 0, length: 3,
        bounds: () => actor.box,
      };
      const slot = pool.allocate(actorLists, ActorList.main, 0x50, actor, null);
      if (!slot) {
        actor.dead = true;
        return actor;
      }
      const [x, y] = pool.subpixels.get(slot.address) ?? [0, 0];
      actor.xFixed = actor.motion.x * 65536 + x;
      actor.yFixed = actor.motion.y * 65536 + y;
      actor.counter = pool.fireCounterLowBytes.get(slot.address) ?? 0;
      pool.headings.set(slot.address, 0);
      pool.contactFlags.set(slot.address, 255);
      return actor;
    });
    this.turrets = 2;
  }

  updatePart(actor, game, aimOperand) {
    const d = this.definition;
    const { index, motion } = actor;
    actor.hit = 0;
    if (!index) {
      game.control.ceiling = Math.max(16, game.control.ceiling);
      this.scrollY = game.control.delta + d.bob[game.tick & 15];
      motion.y += this.scrollY;
      actor.box = this.turrets ? disabledBox() : { x: 148, y: motion.y + 32, w: 25, h: 9 };
      if (actor.phase || this.fire(actor, d.beamRate, game)) {
        actor.phase = (actor.phase + 1) & 127;
        if (actor.phase === 1 || actor.phase === 120) game.sounds.push("fire");
      }
      return (game.tick & 15) * 2;
    }

    const pool = game.run.actorPool;
    if (index < 3) {
      this.stepTurretBody(actor);
      if (actor.indestructible) return aimOperand;
      const direction = shotDirection(game.player.x - motion.x - 16, game.player.y - motion.y - 16);
      actor.direction = d.aim[index - 1][direction];
      pool.headings.set(actor.actorAddress, actor.direction);
      if (!this.fire(actor, d.turretRate, game)) return direction;
      const [x, y] = d.muzzles[actor.direction];
      const [dx, dy] = d.vectors[actor.direction];
      const frames = d.bullets[actor.direction];
      game.addPooledHostileRound({ x: motion.x + 16 + x, y: motion.y + 16 + y,
        dx: dx * d.turretSpeed, dy: dy * d.turretSpeed, direction: actor.direction,
        frame: frames[0], frames, fixed: true, damage: 4 }, d.turretSpeed);
      return actor.direction * 2;
    }

    if (index === 3) {
      Object.assign(actor, sweepArc(game.tick, 32));
      actor.length = Math.min(this.phase, 128 - this.phase, 8);
      motion.y += this.scrollY ?? 0;
      actor.yFixed = motion.y * 65536 + (actor.yFixed & 65535);
    } else {
      const previous = game.stageFourArenaPrevious(actor);
      aimOperand = followArc(actor, previous, this.sine, d.motionCode, aimOperand);
    }
    actor.frame = d.beamFrames[Number(index === this.parts.length - 1)];
    game.saveActorMotion(actor, actor);
    this.beamBounds(actor);
    return aimOperand;
  }

  stepTurretBody(actor) {
    const position = actor.motion ?? actor;
    position.y = (position.y + (this.scrollY ?? 0)) << 16 >> 16;
    actor.box = { x: position.x + 6, y: position.y + 6, w: 21, h: 21 };
  }

  fire(actor, rate, game) {
    const next = actor.counter + rate;
    const firing = next >= 256;
    actor.counter = firing ? game.randomWord() & 63 : next;
    game.run.actorPool.fireCounterLowBytes.set(actor.actorAddress, actor.counter);
    return firing;
  }

  beamBounds(actor) {
    const sprite = this.sprite(actor.frame);
    const [x, y, w, h] = sprite.box;
    actor.box = actor.length ? { x: actor.motion.x - sprite.originX + x,
      y: actor.motion.y - sprite.originY + y, w, h } : disabledBox();
  }

  tileRegion(actor) {
    const { x, y } = actor.motion;
    if (!actor.index) return { x: x - 48, y, width: 6, tiles: this.definition.body[Number(actor.phase !== 0)] };
    const side = actor.index - 1;
    return { x, y, width: 2, tiles: this.definition.turretTiles[side][actor.indestructible ? 0 : actor.direction + 1] };
  }

  destroy(actor, game) {
    if (actor.index) {
      if (actor.indestructible) return;
      this.turrets--;
      // CS:b930 subtracts camera Y even though the actor is already screen-relative.
      const blast = game.explode(actor.motion.x + 16, actor.motion.y - game.camera + 32, true, true);
      actor.indestructible = true;
      game.run.actorPool.headings.set(actor.actorAddress, 0xffff);
      // CS:b95d can replace the blast's animator with the disabled turret update.
      if (blast?.address === actor.actorAddress) blast.actor.disabledTurret = this;
      return;
    }
    this.dead = true;
    game.kills++;
    game.clearStageFourMain();
    for (let pair = 0; pair < 10; pair++) for (const value of [50, 100]) {
      game.addPickup({ kind: "credit", counted: true, value, age: 0, state: 7,
        x: game.randomWord() % 300 + 10, y: game.randomWord() % 180 + 6 }, true);
    }
    // CS:b91c reads the old core address after allocating the credits.
    const occupant = game.run.actorPool.recordsByAddress.get(actor.actorAddress)?.actor;
    const deathY = occupant?.y ?? occupant?.motion?.y ?? actor.motion.y;
    for (let i = 0; i < 20; i++) {
      game.explode(112 + game.randomWord() % 96, deathY + game.randomWord() % 80, true, true);
    }
  }
}

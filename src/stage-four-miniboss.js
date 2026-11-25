import { ActorList } from "./actor-pool.js";
import { shotDirection } from "./boss.js";
import { followArc, frameAt, sweepArc } from "./motion.js";

const directionTo = (actor, player) => shotDirection(player.x - actor.motion.x, player.y - actor.motion.y);
const aimed = (actor, player) => Math.min(6, Math.max(2, directionTo(actor, player)));

// CS:c12c: two articulated chains and four fixed guns guard the stage-four core.
export class StageFourMiniboss {
  constructor(definition, sine, sprite) {
    this.definition = definition;
    this.sine = sine;
    this.sprite = sprite;
    this.parts = [];
    this.remaining = 5;
    this.extension = 0;
  }

  get targets() { return this.dead ? [] : this.parts.filter((actor) => !actor.dead); }

  spawn(game) {
    if (this.parts.length) return;
    const { camera, actorLists, run: { actorPool: pool } } = game;
    game.setCheckpointPosition(this.definition.reverseLimit);
    this.parts = this.definition.parts.map((part, index) => {
      const actor = {
        index, definition: part, motion: { x: part.x, y: part.y - camera }, health: part.health,
        heading: part.heading * 65536, length: 3, turn: 0, acceleration: 0, counter: 0,
        miniboss: this, boss: true, ground: true,
        get indestructible() { return index === 4 || index === 5 ? this.miniboss.remaining !== 0 : index < 15; },
        bounds: () => actor.box,
      };
      this.setFrames(actor, part.frames);
      this.bounds(actor);
      const slot = pool.allocate(actorLists, ActorList.main, 0x54, actor, null);
      if (!slot) {
        actor.dead = true;
        return actor;
      }
      const [x, y] = pool.subpixels.get(slot.address) ?? [0, 0];
      actor.xFixed = actor.motion.x * 65536 + x;
      actor.yFixed = actor.motion.y * 65536 + y;
      actor.counter = pool.fireCounterLowBytes.get(slot.address) ?? 0;
      pool.headings.set(slot.address, part.heading);
      pool.contactFlags.set(slot.address, part.contactDamage === 16 ? 255 : 0);
      return actor;
    });
    for (const actor of this.parts.slice(16)) {
      actor.acceptsHit = (shot, box) => {
        const top = shot.point ? shot.y : box?.y ?? shot.y;
        const bottom = shot.point ? shot.y : box ? box.y + box.h - 1 : shot.y;
        return top > actor.box.y && bottom < actor.box.y + actor.box.h - 1;
      };
    }
  }

  setFrames(actor, frames) {
    actor.frames = frames;
    actor.frameIndex = 0;
    actor.frame = frames[0];
    actor.frameTicks = actor.frame.duration;
  }

  animate(actor) {
    if (!actor.frameTicks || --actor.frameTicks) return;
    actor.frameIndex = (actor.frameIndex + 1) % actor.frames.length;
    actor.frame = actor.frames[actor.frameIndex];
    actor.frameTicks = actor.frame.duration;
  }

  bounds(actor, extra = 0) {
    const sprite = this.sprite(actor.frame);
    const [x, y, w, h] = sprite.box;
    actor.box = { x: actor.motion.x - sprite.originX + x,
      y: actor.motion.y - sprite.originY + y - extra, w, h: h + extra * 2 };
  }

  moveBase(actor, delta) {
    actor.motion.y += delta;
    actor.yFixed = actor.motion.y * 65536 + (actor.yFixed & 65535);
  }

  fire(actor, speed, direction, game, muzzle = [0, 0], frames = this.definition.bullet) {
    const [dx, dy] = this.definition.vectors[direction];
    game.addPooledHostileRound({ x: actor.motion.x + muzzle[0], y: actor.motion.y + muzzle[1],
      dx: dx * speed, dy: dy * speed, direction, frame: frames[0],
      frames: frames.length > 1 ? frames : undefined, fixed: true, damage: 4 }, speed);
  }

  firing(actor, rate, game) {
    const next = actor.counter + rate;
    const firing = next >= 256;
    actor.counter = firing ? game.randomWord() & 63 : next;
    game.run.actorPool.fireCounterLowBytes.set(actor.actorAddress, actor.counter);
    return firing;
  }

  updatePart(actor, game, aimOperand) {
    const d = this.definition, { player, control, tick } = game;
    const { index } = actor;
    actor.hit = 0;
    if (!index) {
      this.moveBase(actor, control.delta);
      if (!this.extension) {
        const aim = aimed(actor, player) * 32;
        actor.heading = (aim - 64) * 65536;
        actor.turn = 0;
        if ((game.randomWord() & 255) < d.extendChance) {
          this.extendSpeed = 2;
          let heading = (aim - 96) & 255;
          actor.turn = ((game.randomWord() & 31) + 32) * 1024;
          if (heading < 32 || heading >= 160) {
            heading = (heading + 64) & 255;
            actor.turn = ~actor.turn;
          }
          actor.heading = heading * 65536;
        }
      }
      if (this.extension || this.extendSpeed > 0) {
        this.extension += this.extendSpeed;
        if (this.extension >= 24) this.extendSpeed = -2;
        actor.length = this.extension + 4;
      }
    } else if (index < 5 || (index > 6 && index < 16)) {
      const previous = game.stageFourArenaPrevious(actor);
      aimOperand = followArc(actor, previous, this.sine, d.motionCode, aimOperand);
      if (index === 4) {
        control.ceiling = Math.max(d.reverseLimit, control.ceiling);
        const direction = aimed(actor, player);
        actor.heading = direction * 65536 + (actor.heading & 65535);
        actor.frame = d.coreFrames[direction];
        aimOperand = direction * 2;
      } else if (index === 15) {
        this.animate(actor);
        if (this.firing(actor, d.ringRate, game)) {
          for (let dir = 7; dir >= 0; dir--) this.fire(actor, d.ringSpeed, dir, game);
          aimOperand = actor.motion.y;
        }
      }
    } else if (index === 5) {
      this.animate(actor);
      const previous = game.stageFourArenaPrevious(actor);
      actor.motion.x = previous.xFixed >> 16;
      actor.motion.y = previous.yFixed >> 16;
      actor.xFixed = actor.motion.x * 65536 + (actor.xFixed & 65535);
      actor.yFixed = actor.motion.y * 65536 + (actor.yFixed & 65535);
      const direction = previous.heading >>> 16;
      if (d.gunFrames[direction]) {
        if (actor.heading !== direction * 65536) {
          actor.heading = direction * 65536;
          this.setFrames(actor, d.gunFrames[direction]);
          aimOperand = d.gunFramePointers[direction];
        }
        if (this.firing(actor, d.gunRate, game)) {
          this.fire(actor, d.gunSpeed, direction, game, d.muzzles[direction]);
          aimOperand = actor.motion.y + d.muzzles[direction][1];
        }
      }
    } else if (index === 6) {
      this.moveBase(actor, control.delta);
      Object.assign(actor, sweepArc(tick, 160), { length: 12 });
    } else {
      this.moveBase(actor, control.delta);
      this.animate(actor);
      const dx = player.x - actor.motion.x, dy = player.y - actor.motion.y;
      const direction = shotDirection(dx, dy);
      aimOperand = dy ? Math.max(Math.abs(dx), Math.abs(dy)) : 0;
      if (actor.heading !== direction * 65536) {
        actor.heading = direction * 65536;
        this.setFrames(actor, d.turretFrames[direction]);
        aimOperand = d.turretFramePointers[direction];
      }
      if (this.firing(actor, d.turretRate, game)) {
        this.fire(actor, d.turretSpeed, direction, game, undefined, d.turretBullet);
        aimOperand = actor.motion.y;
      }
    }
    if (index < 4) {
      const pose = (((actor.heading >>> 16) + 16) >>> 5) & 3;
      actor.frame = d.segmentFrames[pose];
      aimOperand = pose * 2;
    }
    game.saveActorMotion(actor, actor);
    this.bounds(actor, index >= 16 ? 8 : 0);
    return aimOperand;
  }

  damageCore(actor, damage, game, fromDrone) {
    // CS:bd43 backs up one link for gun hits. CS:bd46 flashes the hit record and its live successor.
    const gun = actor.index === 5;
    const target = gun ? game.stageFourMainNeighbor(actor, -1)?.actor : actor;
    const next = gun ? actor : game.stageFourMainNeighbor(actor, 1)?.actor;
    const health = (target?.health ?? 0) & 65535;
    if (target) target.health = (health - damage) << 16 >> 16;
    if (damage >= health) {
      this.destroy(this.parts[4], game);
      return;
    }
    for (const part of [target, next]) {
      if (!part) continue;
      part.hit = 3;
      game.flashStageOneActor(part, fromDrone);
    }
  }

  destroy(actor, game) {
    const pool = game.run.actorPool, records = pool.recordsByAddress;
    const explode = ({ address, actor: part }) => {
      const { x, y } = part.motion ?? part;
      const frame = part.kind === "credit" || part.kind === "reward" ? game.pickupFrame(part)
        : part.parts ? game.enemyFrame(part) : part.frame ?? (part.frames && frameAt(part.frames, part.age));
      if (frame) {
        const sprite = this.sprite(frame);
        game.explode(x - sprite.originX + Math.floor(sprite.width / 2),
          (part.worldY ?? y) - sprite.originY + Math.floor((sprite.height - 1) / 2),
          Boolean(pool.contactFlags.get(address)), true);
      }
      records.get(address).actor.dead = true;
    };
    if (actor.index === 15) {
      this.remaining--;
      game.control.scrollDirection = -1;
      // CS:bcc8 saves the raw previous address before the blast allocator can reclaim it.
      let slot = records.get(actor.actorAddress);
      for (let i = 0; i < 10 && slot?.list !== undefined; i++) {
        const previous = pool.previousAddress(game.actorLists, slot);
        explode(slot);
        game.score += 100;
        slot = records.get(previous);
      }
    } else if (actor.index >= 16) {
      explode(records.get(actor.actorAddress));
      this.remaining--;
      game.score += 300;
    } else {
      game.clearStageFourMain(true);
      for (let i = 0; i < 40; i++) game.explode(game.randomWord() % 320, game.randomWord() % 192, true, true);
      for (let pair = 0; pair < 5; pair++) for (const value of [50, 100]) {
        game.addPickup({ kind: "credit", counted: true, value, age: 0, state: 7,
          x: game.randomWord() % 300 + 10, y: game.randomWord() % 180 + 6 }, true);
      }
      for (let cell = 0x1658 / 2; cell < 0x1658 / 2 + 320; cell++) game.patchGround({ cell }, [0]);
      game.score += 2000;
      game.endCamera = 0;
      game.camera = game.control.camera = game.control.ceiling = this.definition.resumeCamera;
      game.control.scrollDirection = 1;
      game.control.reverseTicks = 0;
      this.dead = this.shopPending = true;
    }
    game.kills++;
  }
}

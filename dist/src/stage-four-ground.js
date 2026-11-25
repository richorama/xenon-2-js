import { ActorList } from "./actor-pool.js";
import { PathMotion } from "./motion.js";

class CorridorSprite {
  constructor(frames) {
    this.setFrames(frames);
  }

  setFrames(frames) {
    this.frames = frames;
    this.frameIndex = 0;
    this.frame = frames[0];
    this.frameTicks = this.frame.duration;
  }

  animate(loop = true) {
    if (this.frameTicks && !--this.frameTicks) {
      if (!loop && this.frameIndex === this.frames.length - 1) return;
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      this.frame = this.frames[this.frameIndex];
      this.frameTicks = this.frame.duration;
    }
  }
}

function corridorShot(game, x, y, direction, speed, frame) {
  const [dx, dy] = game.assets.logic.corridor.vectors[direction];
  game.addPooledHostileRound({ x, y, dx: dx * speed, dy: dy * speed, direction, frame,
    fixed: true, damage: 4 }, speed);
}

export class StageFourCorridorActor extends CorridorSprite {
  constructor(definition, motion, frames = definition.frames) {
    super(frames);
    this.definition = definition;
    this.motion = motion;
    this.health = definition.health;
    this.ground = this.spriteActor = this.vgaFlash = true;
    this.box = { x: 1000, y: 0, w: 0, h: 0 };
  }

  bounds() { return this.box; }

  updateBounds(game) {
    this.box = game.bounds(game.sprite(this.frame), this.motion.x, this.motion.y);
  }

  step(game, aimOperand) {
    this.hit = 0;
    this.animate();
    const d = this.definition, corridor = game.assets.logic.corridor;
    const { motion } = this;
    motion.y += game.control.delta + d.speed;
    if (motion.y >= 200) {
      this.dead = true;
      return aimOperand;
    }
    const { x, y } = motion;
    const fire = (key, rate) => {
      const sum = this[key] + rate;
      const firing = sum >= 256;
      this[key] = firing ? game.randomWord() & 63 : sum;
      const pool = game.run.actorPool;
      (key === "fireCounter" ? pool.fireCounterLowBytes : pool.fireCounterHighBytes)
        .set(this.actorAddress, this[key]);
      return firing;
    };
    if (d.launcher) {
      this.phase = (this.phase + 1) % 12;
      if (this.phase === 8 && fire("fireCounter", d.fireRate)) {
        const pod = new StageFourCorridorPod(corridor.pods[this.side], y - 30);
        if (game.run.actorPool.allocate(game.actorLists, ActorList.transient, pod.definition.type, pod)) {
          game.bullets.unshift(pod);
        }
        aimOperand = pod.definition.aimOperand;
      }
      const shoot = fire("shotCounter", corridor.launcherShotRate);
      if (shoot) {
        corridorShot(game, x + (this.side ? -16 : 20), y, 4, corridor.launcherShotSpeed, corridor.shotFrames[2]);
        aimOperand = y;
      }
    } else if (fire("fireCounter", d.fireRate)) {
      corridorShot(game, x + (this.side ? -26 : 26), y + 26, this.side ? 13 : 10,
        corridor.shotSpeed, corridor.shotFrames[this.side]);
      aimOperand = y + 26;
    }
    this.updateBounds(game);
    return aimOperand;
  }
}

class CorridorDrone extends StageFourCorridorActor {
  constructor(game, x, y, { path, heading }) {
    const { paths, logic } = game.assets;
    const motion = new PathMotion(paths, path, logic.sine, { randomWord: () => game.randomWord() });
    Object.assign(motion, { xFixed: x * 65536, yFixed: y * 65536, heading: heading * 65536 });
    super(logic.corridor.drone, motion, logic.corridor.drone.frames[heading >>> 5]);
  }

  allocate(game) {
    const pool = game.run.actorPool;
    const slot = pool.allocate(game.actorLists, ActorList.main, this.definition.type, this);
    if (!slot) return;
    // CS:b751 preserves the coordinate fractions but clears both fire-counter bytes.
    const [x, y] = pool.subpixels.get(slot.address) ?? [0, 0];
    this.motion.xFixed += x;
    this.motion.yFixed += y;
    pool.headings.set(slot.address, this.motion.heading >>> 16);
    pool.fireCounterLowBytes.set(slot.address, 0);
    pool.fireCounterHighBytes.set(slot.address, 0);
    pool.contactFlags.set(slot.address, 0);
    const clock = game.run.formationClock;
    this.formationId = clock.next;
    clock.next = (clock.next + 1) & 65535;
    if (game.formationCredits.size < 8) game.formationCredits.set(this.formationId, 1);
    game.ground.unshift(this);
  }

  step(game) {
    this.hit = 0;
    this.animate();
    const { motion } = this;
    const direction = () => ((motion.heading >>> 16) + 16) >>> 5 & 7;
    const previous = direction();
    motion.step(this.definition.speed);
    if (!motion.active) {
      game.formationCredits.delete(this.formationId);
      // CS:b819 rebuilds the callback and chooses a new route when CS:49b5 marks the drone.
      const path = 73 + Number(motion.x >= 160) * 2 + ((game.randomWord() & 4) >>> 2);
      const base = game.assets.paths.offsets[path - 1];
      Object.assign(motion, { active: true, base, cursor: base + 6, remaining: 0 });
    } else this.updateBounds(game);
    const current = direction();
    if (current !== previous) {
      this.setFrames(this.definition.frames[current]);
      this.updateBounds(game);
    }
    game.saveActorMotion(this, motion);
    return current === previous ? current * 2 : this.definition.aimOperands[current];
  }
}

export class StageFourCorridorPod extends CorridorSprite {
  constructor(definition, y) {
    super(definition.frames);
    Object.assign(this, { definition, x: definition.x, y });
  }

  step(game, slot) {
    if (!this.exploding) this.y += game.control.delta;
    this.animate(!this.exploding);
    if (!this.frameTicks) {
      if (this.exploding) {
        this.dead = true;
        return;
      }
      const sprite = game.sprite(this.frame);
      this.x += (sprite.width >> 1) - sprite.originX;
      this.y += ((sprite.height - 1) >> 1) - sprite.originY;
      this.exploding = true;
      slot.type = 0x0c;
      this.setFrames(game.assets.logic.explosions[0]);
    } else if (!this.exploding && this.frameIndex === 5) {
      new CorridorDrone(game, this.x + this.definition.offsetX, this.y, this.definition).allocate(game);
    }
  }
}

// CS:b555 runs before main-list updates, unlike camera events that run after paint.
export function dispatchStageFourCorridor(game) {
  const d = game.assets.logic.corridor, { camera, control, tick } = game;
  if (camera <= d.reverseLimit) control.ceiling = Math.min(d.reverseLimit, control.ceiling);
  if (tick & 15 || camera < d.lastCamera || camera > d.firstCamera) return;
  const index = (game.randomWord() & 1) + ((tick & 32) >>> 4);
  const ship = new StageFourCorridorActor(d.ships[index], { x: d.ships[index].x, y: -32 });
  const pool = game.run.actorPool;
  const slot = pool.allocate(game.actorLists, ActorList.main, ship.definition.type, ship);
  if (!slot) return;
  pool.contactFlags.set(slot.address, 255);
  ship.side = index >>> 1;
  ship.fireCounter = game.randomWord() & 255;
  pool.fireCounterLowBytes.set(slot.address, ship.fireCounter);
  ship.phase = 0;
  ship.shotCounter = ship.definition.launcher ? pool.fireCounterHighBytes.get(slot.address) ?? 0 : 0;
  game.ground.unshift(ship);
}

// CS:c368/c3ea: the wall hunter resets to its hatch after a pass or a kill.
export class GroundWallHunter {
  constructor(event, definition, camera, sprite) {
    this.definition = definition;
    this.sprite = sprite;
    this.side = Number(Boolean(event[6]));
    this.hatchX = event[4] - 8;
    this.hatchY = event[5] - 8;
    this.baseX = this.hatchX + (this.side ? 0 : 16);
    this.baseY = this.hatchY + 28;
    this.ground = this.spriteActor = true;
    this.motion = {};
    this.reset(camera);
  }

  reset(camera) {
    this.motion.x = this.baseX;
    this.worldY = this.baseY;
    this.motion.y = this.worldY - camera;
    this.phase = this.hit = this.frameIndex = this.frameTicks = 0;
    this.health = this.definition.health;
    this.frames = this.definition.frames[this.side];
    this.frame = this.frames[0];
    this.box = { x: 1000, y: 0, w: 0, h: 0 };
  }

  bounds() { return this.box; }

  update(camera, ceiling, randomWord, player) {
    this.hit = 0;
    this.motion.y = this.worldY - camera;
    if (this.worldY > ceiling + 208) {
      this.dead = true;
      return;
    }

    if (this.frameTicks && !--this.frameTicks) {
      this.frame = this.frames[++this.frameIndex];
      this.frameTicks = this.frame.duration;
    }
    if (!this.phase) {
      if ((randomWord() & 255) < this.definition.chance) {
        this.phase = this.frameTicks = 1;
      }
      return;
    }

    const speed = this.definition.speed;
    this.motion.x += this.side ? -speed : speed;
    if (this.phase === 1) {
      if (!this.frameTicks) {
        this.phase = 2;
        this.vertical = player.y < this.motion.y ? -speed : speed;
      }
    } else {
      if (this.motion.x >= 40 && this.motion.x <= 280) this.worldY += this.vertical;
      if (this.motion.x < -32 || this.motion.x >= 352) {
        this.reset(camera);
        return;
      }
    }
    this.motion.y = this.worldY - camera;
    const sprite = this.sprite(this.frame);
    const [x, y, w, h] = sprite.box;
    this.box = { x: this.motion.x - sprite.originX + x, y: this.motion.y - sprite.originY + y, w, h };
  }

  drawHatch(camera) {
    if (this.phase >= 2 || this.motion.y > 220) return;
    return { x: this.hatchX, y: this.hatchY - camera, width: 1, tiles: this.definition.hatch[this.side] };
  }

  destroy(game, recycled) {
    const records = game.run?.actorPool.recordsByAddress;
    const source = () => records?.get(this.actorAddress)?.actor ?? this;
    const x = recycled?.x ?? this.motion.x;
    const y = (recycled?.y ?? this.worldY) - game.camera;
    const sprite = this.sprite(recycled ? game.pickupFrame(recycled) : this.frame);
    game.explode(x - sprite.originX + Math.floor(sprite.width / 2),
      y - sprite.originY + Math.floor((sprite.height - 1) / 2), true, true);
    game.score += this.definition.score;
    game.kills++;
    const current = source();
    game.addPickup({ kind: "credit", value: 100, age: 0, state: 7, direction: game.randomWord(),
      x: current.x ?? current.motion.x, y: (current.worldY ?? current.y) - game.camera }, true);
    this.reset(game.camera);
    const replacement = source();
    if (replacement !== this) {
      // CS:c489 resets the current occupant's pose, not its type or update callback.
      Object.assign(replacement, { x: this.baseX, y: this.baseY, state: 0,
        frameOverride: this.definition.frames[1][0], contactBox: this.box });
    }
  }
}

// CS:c1f3/c230: map-only rams extend six tiles, then retract behind the terrain.
export class GroundWallRam {
  constructor(event, definition, camera) {
    this.definition = definition;
    this.side = Number(Boolean(event[6]));
    this.x = event[4] - 8;
    this.y = event[5] - 8 - camera;
    this.length = this.speed = this.counter = this.frameIndex = 0;
    this.frames = definition.frames[this.side];
    this.frame = this.frames[0];
    this.frameTicks = this.frame.duration;
  }

  update(delta, randomWord) {
    this.y += delta;
    if (this.y > 392) {
      this.dead = true;
      return;
    }
    if (!--this.frameTicks) {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      this.frame = this.frames[this.frameIndex];
      this.frameTicks = this.frame.duration;
    }
    if (!this.length) {
      this.speed = 1;
      this.counter += this.definition.fireRate;
      if (this.counter < 256) return;
      this.counter = randomWord() & 63;
    }
    this.length += this.speed;
    if (this.length === 6) this.speed = -1;
  }

  get tipX() { return this.x + (this.side ? 15 - this.length * 16 : this.length * 16); }

  bounds() {
    const x = this.x - (this.side ? this.length * 16 : 0);
    return { x, y: this.y + 8, w: this.length * 16 + 17, h: 17 };
  }

  get extension() {
    if (!this.length) return;
    const { x } = this.bounds();
    return { x: this.side ? x + 16 : x, y: this.y, width: this.length,
      tiles: this.definition.tiles[this.length - 1] };
  }
}

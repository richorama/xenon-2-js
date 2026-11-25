import { shotDirection } from "./boss.js";
import { PathMotion } from "./motion.js";

const cellAt = (x, y) => Math.floor(y / 16) * 20 + Math.floor(x / 16);

// CS:dd7f appends three linked map actors per barrier; only the outer posts take damage.
export class GroundBarrierPart {
  constructor(x, worldY, definition, index, parts) {
    this.x = x;
    this.worldY = worldY;
    this.motion = { x, y: 0 };
    this.definition = definition;
    this.index = index;
    this.parts = parts;
    this.cell = cellAt(x, worldY);
    this.phase = this.hit = 0;
    this.health = definition.health;
    this.ground = true;
    this.indestructible = index === 1;
    this.dead = false;
  }

  bounds(camera) {
    const y = this.worldY - camera;
    return this.indestructible
      ? { x: this.x, y: y + 2, w: 33, h: 13 }
      : { x: this.x + 3, y: y + 3, w: 11, h: 11 };
  }

  update(camera) {
    this.motion.y = this.worldY - camera;
    this.hit = Math.max(0, this.hit - 1);
    this.phase = (this.phase + 1) & 3;
    this.patches = this.definition.frames[this.index][this.phase];
  }

  flashRegion(camera) {
    return { x: this.x, y: this.worldY - camera, width: 1, tiles: this.definition.flash[this.index] };
  }

  destroy(game) {
    game.patchGround({ cell: this.parts[0].cell, patchWidth: 4 }, this.definition.death);
    for (const part of this.parts) part.dead = true;
    game.explode(this.x + 8, this.worldY - game.camera + 8);
    game.score += 200;
    game.kills++;
  }
}

// CS:df97/e138 share the 2x2 terrain footprint, but different activation and fire cycles.
export class GroundStageFiveTurret {
  constructor(event, definition) {
    const [, type, , flag, x, y, direction] = event;
    this.definition = definition;
    this.flag = type === 9 ? flag : undefined;
    this.swivel = definition.kind === "swivel-turret";
    this.x = x - 8;
    this.worldY = y - 8;
    this.motion = { x: this.x, y: 0 };
    this.cell = cellAt(this.x, this.worldY);
    this.direction = this.swivel ? direction : 0;
    this.phase = this.fireCounter = this.hit = 0;
    this.health = definition.health;
    this.ground = true;
    this.dead = false;
  }

  place(game) {
    for (const [offset, original, active, below] of this.definition.neighbors) {
      const cell = this.cell + offset;
      if (game.map[cell] === original) game.patchGround({ cell, patchWidth: 1 }, [active, below]);
    }
    if (this.swivel) game.patchGround(this, this.definition.frames[this.direction]);
    else {
      const [top, , bottom] = this.definition.frames[0];
      game.patchGround({ cell: this.cell, patchWidth: 1 }, [top, bottom]);
    }
  }

  bounds(camera) {
    return { x: this.x + 4, y: this.worldY - camera + 4, w: 25, h: 25 };
  }

  update(camera, ceiling, randomWord, player, tick) {
    this.motion.y = this.worldY - camera;
    this.hit = Math.max(0, this.hit - 1);
    if (this.worldY > ceiling + 208) {
      this.dead = true;
      return;
    }
    const d = this.definition;
    const { x, y } = this.motion;
    let armed = true;
    if (this.swivel) {
      if (!this.phase && y < -16) armed = false;
      else if (this.phase < 8) {
        this.phase++;
        this.direction = (this.direction + 1) & 7;
        armed = false;
      } else {
        const turn = (shotDirection(player.x - x - 16, player.y - y - 16) - this.direction) & 7;
        if (turn) this.direction = (this.direction + (turn < 4 ? 1 : -1)) & 7;
      }
    } else this.phase = (this.phase + 1) & 15;
    this.patches = d.frames[this.swivel ? this.direction : this.phase >>> 1];
    if (!armed) return;
    const sum = this.fireCounter + d.fireRate;
    this.fireCounter = sum & 255;
    if (sum <= 255) return;
    this.fireCounter = randomWord() & 63;
    const bullet = (direction, offsetX, offsetY, frame, frames) => {
      const [dx, dy] = d.vectors[direction];
      return { x: x + 16 + offsetX, y: y + 16 + offsetY, dx: dx * d.bulletSpeed,
        dy: dy * d.bulletSpeed, frame, frames, damage: 4, fixed: true };
    };
    if (!this.swivel) return Array.from({ length: 8 }, (_, i) =>
      bullet(7 - i, 0, 0, d.projectiles[0], d.projectiles));
    const [offsetX, offsetY] = d.muzzle[this.direction];
    const frame = d.projectiles[(this.direction & 3) + (tick & 1 ? 0 : 4)];
    return bullet(this.direction, offsetX, offsetY, frame);
  }

  flashRegion(camera) {
    return { x: this.x, y: this.worldY - camera, width: 2, tiles: this.definition.frames[0] };
  }

  destroy(game) {
    if (this.flag !== undefined) game.stageFiveTurretFlags.add(this.flag);
    for (const [offset, original, active, , destroyed] of this.definition.neighbors) {
      const cell = this.cell + offset;
      if (game.map[cell] === active) {
        game.patchGround({ cell }, [original]);
        game.patchGround({ cell: cell + 20 }, [destroyed]);
      }
    }
    game.patchGround(this, [0, 0, 0, 0]);
    this.dead = true;
    game.explode(this.x + 16, this.worldY - game.camera + 16, true);
    game.score += this.definition.score;
    game.kills++;
  }
}

export class GroundStageFiveSprite {
  constructor(definition, game) {
    this.definition = definition;
    this.game = game;
    this.health = definition.health;
    this.hit = 0;
    this.dead = false;
    this.ground = this.spriteActor = this.whiteFlash = true;
    this.box = { x: 1000, y: 0, w: 0, h: 0 };
  }

  bounds() {
    return this.box;
  }

  updateBounds() {
    this.box = this.game.bounds(this.game.sprite(this.frame), this.motion.x, this.motion.y);
    this.hit = Math.max(0, this.hit - 1);
  }

  animate() {
    if (--this.frameTicks === 0) {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      this.frame = this.frames[this.frameIndex];
      this.frameTicks = this.frame.duration;
    }
  }

  setFrames(frames) {
    this.frames = frames;
    this.frameIndex = 0;
    this.frame = frames[0];
    this.frameTicks = this.frame.duration;
  }
}

// CS:d0f1/d1b9: ten ships staggered on a world-space path; sprite changes only on heading changes.
class GroundStageFiveWave extends GroundStageFiveSprite {
  constructor(event, definition, game, index) {
    super(definition, game);
    this.motion = new PathMotion(game.assets.paths, definition.firstPath + event[3],
      game.assets.logic.sine, { delay: definition.delay * index });
    this.motion.yFixed -= game.camera * 65536;
    this.frame = definition.initial;
    this.fireCounter = (9 - index) * 25;
  }

  step() {
    const { game, motion, definition: d } = this;
    motion.yFixed += game.control.delta * 65536;
    if (motion.y >= 400) {
      this.dead = true;
      return;
    }
    const direction = () => ((motion.heading >>> 16) + 16) >>> 5 & 7;
    const previous = direction();
    motion.step(d.speed);
    const current = direction();
    if (current !== previous) this.frame = d.frames[current];
    this.updateBounds();
    this.dead = !motion.active;
    this.fireCounter += d.fireRate;
    if (this.fireCounter < 256) return;
    this.fireCounter = 0;
    for (const [dx, dy] of d.vectors.slice(0, 8)) {
      game.bullets.push({ x: motion.x, y: motion.y, dx: dx * d.bulletSpeed,
        dy: dy * d.bulletSpeed, frame: d.bulletFrame, damage: 4, fixed: true });
    }
  }
}

class GroundStageFivePatrol extends GroundStageFiveSprite {
  constructor(event, definition, game) {
    super(definition, game);
    this.side = event[6] ? 1 : 0;
    this.motion = { x: event[4] - 8 + this.side * 16, y: event[5] - 8 - game.camera };
    this.travel = 1;
    this.fireCounter = 0;
    this.setFrames(definition.frames[this.side][0]);
  }

  step() {
    const { game, motion, definition: d } = this;
    motion.y += game.control.delta;
    if (motion.y >= 400) {
      this.dead = true;
      return;
    }
    this.animate();
    motion.y += this.travel;
    const worldY = motion.y + game.camera;
    if (this.travel > 0 ? worldY >= 0xf20 : worldY <= 0xe30) {
      this.travel = -this.travel;
      this.setFrames(d.frames[this.side][this.travel < 0 ? 1 : 0]);
    }
    this.updateBounds();
    this.fireCounter += d.fireRate;
    if (this.fireCounter >= 256) {
      this.fireCounter = game.randomWord() & 63;
      spawnStageFiveHoming(game, motion.x + (this.side ? -32 : 32), motion.y, this.side ? 6 : 2);
    }
  }
}

class GroundStageFiveHoming extends GroundStageFiveSprite {
  constructor(x, y, direction, definition, game) {
    super(definition, game);
    this.motion = { x, y };
    this.direction = direction;
    this.age = game.randomWord() & 31;
    this.setFrames(definition.frames[direction]);
  }

  step() {
    const { game, motion, definition: d } = this;
    this.animate();
    if (++this.age >= d.lifetime) {
      const sprite = game.sprite(this.frame);
      this.dead = true;
      game.explode(motion.x - sprite.originX + Math.floor(sprite.width / 2),
        motion.y - sprite.originY + Math.floor((sprite.height - 1) / 2));
      return;
    }
    if (!(this.age & 7)) {
      const turn = (shotDirection(game.player.x - motion.x, game.player.y - motion.y) - this.direction) & 7;
      if (turn) {
        this.direction = (this.direction + (turn < 4 || (turn === 4 && (motion.x & 1)) ? 1 : -1)) & 7;
        this.setFrames(d.frames[this.direction]);
      }
    }
    const [dx, dy] = d.vectors[this.direction];
    motion.x += dx;
    motion.y += dy + game.control.delta;
    this.updateBounds();
  }
}

export function spawnStageFiveHoming(game, x, y, direction) {
  const definition = game.assets.groundLogic.get(8).homing;
  game.ground.unshift(new GroundStageFiveHoming(x, y, direction, definition, game));
}

export function spawnStageFiveGround(event, definition, game) {
  if (definition.kind === "ring-wave") {
    for (let i = 0; i < 10; i++) game.ground.push(new GroundStageFiveWave(event, definition, game, i));
  } else if (definition.kind === "wall-patrol") {
    game.ground.unshift(new GroundStageFivePatrol(event, definition, game));
  } else if (definition.kind === "barrier") {
    const x = event[4] - 8, y = event[5] - 8;
    const parts = [];
    for (const [i, offset] of [0, 16, 48].entries()) {
      parts.push(new GroundBarrierPart(x + offset, y, definition, i, parts));
    }
    game.patchGround({ cell: parts[0].cell, patchWidth: 4 }, definition.initial);
    game.ground.push(...parts);
  } else if (event[1] !== 9 || !game.stageFiveTurretFlags.has(event[3])) {
    const turret = new GroundStageFiveTurret(event, definition);
    turret.place(game);
    game.ground.unshift(turret);
  }
}

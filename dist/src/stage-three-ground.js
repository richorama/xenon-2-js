import { shotDirection } from "./boss.js";

class GroundSprite {
  constructor(definition, sprite, x, y, frames) {
    this.definition = definition;
    this.sprite = sprite;
    this.motion = { x, y };
    this.ground = this.spriteActor = true;
    this.dead = false;
    this.health = definition.health;
    this.hit = 0;
    this.setFrames(frames);
    this.updateBounds();
  }

  setFrames(frames) {
    this.frames = frames;
    this.frameIndex = 0;
    this.frame = frames[0];
    this.frameTicks = this.frame.duration;
  }

  animate() {
    if (this.frameTicks > 0 && !--this.frameTicks) {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      this.frame = this.frames[this.frameIndex];
      this.frameTicks = this.frame.duration;
    }
  }

  updateBounds() {
    const sprite = this.sprite(this.frame);
    const [x, y, w, h] = sprite.box;
    this.box = { x: this.motion.x - sprite.originX + x,
      y: this.motion.y - sprite.originY + y, w, h };
  }

  bounds() {
    return this.hidden ? { x: 1000, y: 0, w: 0, h: 0 } : this.box;
  }
}

function bullet(definition, x, y, direction, frames, speed = definition.bulletSpeed) {
  const [dx, dy] = definition.vectors[direction];
  return { x, y, direction, dx: dx * speed, dy: dy * speed,
    frame: frames[0], frames, fixed: true, damage: 4 };
}

// CS:a1d2/a5a4/a613/a656: eight parts share the base's health, not eight health pools.
export class GroundArm extends GroundSprite {
  constructor(event, definition, camera, sprite) {
    const side = event[6] ? 1 : 0;
    super(definition, sprite, event[4] - 8 + side * 32, event[5] - camera,
      [{ ...definition.body[side], duration: 0 }]);
    this.side = side;
    this.length = this.extension = this.wait = 0;
    this.baseX = this.motion.x;
    this.chain = [this];
    for (let i = 1; i < 8; i++) {
      const part = new GroundSprite(definition, sprite, this.baseX, this.motion.y,
        i === 7 ? definition.tips[side] : this.frames);
      part.root = this;
      part.chain = this.chain;
      Object.defineProperty(part, "health", {
        get: () => this.health, set: (value) => { this.health = value; },
      });
      Object.defineProperty(part, "hit", {
        get: () => this.hit, set: (value) => { this.hit = value; },
      });
      this.chain.push(part);
    }
    this.updateParts();
  }

  updateParts() {
    for (const [i, part] of this.chain.entries()) {
      part.motion.x = this.baseX + i * (this.side ? -1 : 1) * this.length;
      part.motion.y = this.motion.y;
      if (i) part.hidden = i < 7 && !this.extension;
      part.updateBounds();
    }
  }

  update(camera, ceiling, randomWord, player, tick, delta) {
    this.motion.y += delta;
    if (this.motion.y >= 232) {
      for (const part of this.chain) part.dead = true;
      return;
    }
    if (!this.extension) {
      if (this.wait < 0) this.wait++;
      else if (Math.abs(this.motion.y - player.y) <= 32) {
        this.extension = 2;
        this.wait = (randomWord() & 6) + 10;
      }
    }
    this.hidden = !this.extension;
    if (this.extension) {
      this.length += this.extension;
      if (!this.length) { this.extension = 0; this.wait = -5; }
      else if (this.length === this.wait) this.extension = -this.extension;
    }
    const tip = this.chain[7];
    tip.animate();
    if ((this.extension === 2 && this.length === 2)
      || (this.wait > 0 && this.length === this.wait)) tip.frameTicks = 1;
    this.updateParts();
    this.hit = 0;
  }
}

// CS:a33f/a689: horizontal skater with a held attack animation and corridor shot.
export class GroundSkater extends GroundSprite {
  constructor(event, definition, camera, sprite) {
    const x = event[4] - 8, side = x > 160 ? 1 : 0;
    super(definition, sprite, x, event[5] + 8 - camera, definition.frames[side]);
    this.dx = side ? -2 : 2;
    this.attack = 0;
  }

  update(camera, ceiling, randomWord, player, tick, delta) {
    this.motion.y += delta;
    if (this.motion.y > ceiling + 208 - camera) { this.dead = true; return; }
    this.animate();
    this.hit = 0;
    const p = this.motion, d = this.definition;
    if (!this.attack) {
      p.x += this.dx;
      if (p.x <= -32 || p.x >= 352) {
        const left = p.x <= -32;
        p.x = left ? 0 : 320;
        this.dx = -this.dx;
        this.setFrames(d.frames[left ? 0 : 1]);
      } else if (p.x === 136 || p.x === 184) {
        this.attack = 1;
        this.setFrames(d.attacking[p.x === 136 ? 0 : 1]);
      }
    } else if (!this.frameTicks) {
      this.attack = 0;
      const left = p.x <= 160;
      p.x = left ? 104 : 216;
      this.dx = -this.dx;
      this.setFrames(d.frames[left ? 1 : 0]);
    } else if (++this.attack === 11) {
      const left = p.x - 5 <= 160;
      const shot = bullet(d, p.x + (left ? -5 : 5), p.y + 4,
        p.x < 160 ? 3 : 5, [d.bulletFrames[left ? 0 : 1]]);
      shot.corridor = d;
      this.updateBounds();
      return shot;
    }
    this.updateBounds();
  }
}

// CS:9db3/a469: follow nonzero terrain, including concave and convex corners.
export class GroundCrawler extends GroundSprite {
  constructor(event, definition, camera, sprite) {
    const direction = event[3], route = definition.routes[direction];
    super(definition, sprite, event[4] - 8 + route[0],
      event[5] - 8 - camera + route[1], definition.frames[direction]);
    this.direction = direction;
    this.fireCounter = 0;
  }

  update(camera, ceiling, randomWord, player, tick, delta, map) {
    this.animate();
    this.motion.y += delta;
    if (this.motion.y > ceiling + 208 - camera) { this.dead = true; return; }
    this.hit = 0;
    const d = this.definition, p = this.motion;
    const [, , dx, dy, neighbour, turnX, turnY, turn] = d.routes[this.direction];
    p.x += dx;
    p.y += dy;
    const coordinate = dx ? p.x : p.y + camera;
    // CS:a4ba retains the zero horizontal-step flags, so both vertical signs use zero.
    if ((coordinate & 15) === (dx < 0 ? 15 : 0)) {
      const cell = Math.floor((p.y + camera) / 16) * 20 + Math.floor(p.x / 16);
      let turning = p.x <= 0 || p.x >= 320;
      if (!turning) {
        if (map[cell]) { p.x -= dx; p.y -= dy; turning = true; }
        else turning = !map[cell + neighbour / 2];
      }
      if (turning) {
        p.x += turnX;
        p.y += turnY;
        this.direction = turn;
        this.setFrames(d.frames[turn]);
      }
    }
    this.updateBounds();
    const sum = this.fireCounter + d.fireRate;
    this.fireCounter = sum & 255;
    if (sum > 255) {
      this.fireCounter = randomWord() & 63;
      return bullet(d, p.x, p.y, shotDirection(player.x - p.x, player.y - p.y), [d.bulletFrame]);
    }
  }
}

// CS:a3bf/a7df/a9cf: the lower gun's death exposes a separately damageable core.
export class GroundTurret {
  constructor(event, definition, camera = 0) {
    this.definition = definition;
    this.x = event[4] - 8;
    this.worldY = event[5] - 8;
    this.cell = Math.floor(this.worldY / 16) * 20 + Math.floor(this.x / 16);
    this.motion = { x: this.x, y: this.worldY - camera };
    this.ground = true;
    this.dead = false;
    this.core = this.phase = this.fireCounter = this.hit = 0;
    this.health = definition.health[0];
    this.patches = definition.initial;
    this.patchWidth = 4;
    this.box = { x: 1000, y: 0, w: 0, h: 0 };
  }

  bounds() { return this.box; }

  update(camera, ceiling, randomWord, player, tick, delta, map, patch) {
    this.motion.y = this.worldY - camera;
    this.hit = 0;
    if (this.worldY > ceiling + 208) { this.dead = true; return; }
    const d = this.definition, y = this.motion.y;
    this.box = { x: this.x + 16, y: y + (this.core ? 4 : 64),
      w: 32, h: this.core ? 24 : 27 };
    let phase = this.phase;
    // Both DOS branches test flags from the bounds addition, not the phase MOV.
    if (this.box.y + this.box.h - 1 === 0) {
      if (this.core) {
        const sum = this.fireCounter + d.coreFireRate;
        this.fireCounter = sum & 255;
        if (sum <= 255) return;
        this.fireCounter = randomWord() & 63;
      } else if ((randomWord() & 255) >= d.idleChance) return;
      phase = 0;
    }
    const tiles = (this.core ? d.coreFrames : d.frames)[Math.floor(phase / 2)];
    const offset = this.core ? 1 : 81;
    tiles.forEach((tile, i) => patch(this.cell + offset + i % 2 + Math.floor(i / 2) * 20, tile));
    this.phase++;
    if (this.core) {
      if (this.phase === 10) this.phase = 0;
      else if (this.phase === 4) return d.coreBullets.map((frames, i) =>
        bullet(d, this.x + 32, y + 24, 7 - i, frames, d.coreBulletSpeed));
      return;
    }
    if (this.phase === 18) this.phase = 0;
    else if (this.phase === 12) {
      if ((randomWord() & 255) < d.repeatChance) this.phase = 4;
    } else if (this.phase >= 4 && this.phase <= 11) {
      const sum = this.fireCounter + d.fireRate;
      this.fireCounter = sum & 255;
      if (sum > 255) {
        this.fireCounter = randomWord() & 63;
        const phase = this.phase & ~1;
        return bullet(d, this.x + 32, y + 88, phase === 6 ? 3 : phase === 8 ? 5 : 4,
          [d.bulletFrame]);
      }
    }
  }

  destroy(game) {
    const d = this.definition;
    this.hit = 0;
    game.score += d.score;
    game.kills++;
    game.explode(this.x + 32, this.motion.y + (this.core ? 16 : 64), true);
    const offsets = this.core ? [0, 1, 2, 3, 20, 21, 22, 23]
      : [40, 41, 42, 43, 60, 61, 62, 63, 80, 81, 82, 83, 101, 102];
    for (const offset of offsets) game.patchGround({ cell: this.cell + offset }, [0]);
    if (this.core) this.dead = true;
    else {
      this.core = 1;
      this.health = d.health[1];
      this.phase = 0;
      this.box = { x: 1000, y: 0, w: 0, h: 0 };
    }
  }
}

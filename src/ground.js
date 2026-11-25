import { shotDirection } from "./boss.js";

// Stage-one map guns: CS:6ac7, 6bca, 6d22; damage/map replacement: CS:3b76.
export class GroundGun {
  constructor(event, definitions) {
    const [, type, , , x, y, side] = event;
    this.definition = definitions.get(type);
    if (!this.definition) throw new Error(`Untranslated ground type ${type}`);
    this.type = type;
    this.side = side ? 1 : 0;
    this.x = x - 8 + (this.definition.xShift?.[this.side] || 0);
    this.worldY = y - 8;
    this.cell = Math.floor(this.worldY / 16) * 20 + Math.floor(this.x / 16);
    this.health = this.definition.health;
    this.phase = 0;
    this.fireCounter = 0;
    this.ground = true;
    this.hit = 0;
    this.dead = false;
    this.motion = { x: this.x, y: this.worldY };
    this.patches = this.definition.initial[this.side];
  }

  bounds(camera) {
    if (this.definition.delayedBounds && !this.boundsReady) return { x: 1000, y: 0, w: 0, h: 0 };
    const [x, y, w, h] = this.definition.box;
    return { x: this.x + x, y: this.worldY - camera + y, w, h };
  }

  update(camera, ceiling, randomWord) {
    this.motion.y = this.worldY - camera;
    this.hit = Math.max(0, this.hit - 1);
    if (this.worldY > ceiling + 0xd0) {
      this.dead = true;
      return;
    }
    const d = this.definition;
    if (d.delayedBounds) this.boundsReady = true;
    if (d.kind === "burst-gun") {
      if (!this.phase) {
        const sum = this.fireCounter + d.fireRate;
        this.fireCounter = sum & 255;
        if (sum <= 255) return;
        this.fireCounter = randomWord() & 63;
        if (!d.advanceFirst) {
          this.phase = 1;
          return;
        }
      }
      if (d.advanceFirst) this.phase++;
      this.patches = d.frames[this.side][this.phase];
      if (!d.advanceFirst) this.phase++;
      const fire = this.phase === d.firePhase;
      if (this.phase === d.cycle) this.phase = 0;
      if (!fire) return;
      const [x, y] = d.muzzle[this.side];
      const [dx, dy] = d.vectors[d.directions[this.side]];
      return {
        x: this.x + x, y: this.motion.y + y, direction: d.directions[this.side],
        dx: dx * d.bulletSpeed, dy: dy * d.bulletSpeed,
        frame: d.bulletAnimations?.[this.side][0] || d.bulletFrame,
        frames: d.bulletAnimations?.[this.side], damage: 4, fixed: true,
      };
    }
    if (d.kind === "random-gun") {
      if (!this.phase) {
        if ((randomWord() & 255) < d.chance) this.phase = 1;
        return;
      }
      this.patches = d.frames[this.side][this.phase];
      this.phase = (this.phase + 1) % 15;
      if (this.phase !== 7) return;
      return {
        x: this.x + 8, y: this.motion.y + 8,
        dx: this.side ? -d.bulletSpeed : d.bulletSpeed, dy: 0,
        frame: d.bulletFrame, damage: 4, fixed: true,
      };
    }
    const frames = d.frames[this.side];
    this.patches = frames[Math.floor(this.phase / d.frameTicks)];
    let fire = false;
    if (this.type !== 3 || !this.phase) {
      const sum = this.fireCounter + d.fireRate;
      this.fireCounter = sum & 255;
      if (sum > 255) {
        this.fireCounter = randomWord() & 63;
        fire = true;
      } else if (this.type === 3) return;
    }
    this.phase = (this.phase + 1) % d.cycle;
    if (this.type === 3) fire = this.phase === 0x18;
    if (!fire) return;
    const [offsetX, offsetY] = d.muzzle[this.side];
    return {
      x: this.x + offsetX, y: this.worldY - camera + offsetY,
      direction: this.side ? 6 : 2,
      dx: this.side ? -d.bulletSpeed : d.bulletSpeed, dy: 0,
      frame: d.bulletFrame, damage: 4, fixed: true,
    };
  }
}

// CS:6e2c / 7e87: vertical patrols become a short, non-looping firing animation.
export class GroundPatrol {
  constructor(event, definition, camera, sprite) {
    this.definition = definition;
    this.side = event[6] ? 1 : 0;
    this.type = event[1];
    this.x = event[4] - 8 + definition.xShift[this.side];
    this.worldY = event[5] - 8;
    this.travel = this.remaining = event[definition.travelField] * 16;
    this.direction = -1;
    this.health = definition.health;
    this.ground = this.spriteActor = true;
    this.dead = false;
    this.hit = 0;
    this.frameIndex = this.frameTicks = 0;
    this.firing = false;
    this.sprite = sprite;
    this.motion = { x: this.x, y: this.worldY - camera };
    this.updateBounds();
  }

  get frames() {
    return this.definition[this.firing ? "firing" : "frames"][this.side];
  }

  get frame() {
    return this.frames[this.frameIndex];
  }

  updateBounds() {
    const sprite = this.sprite(this.frame);
    const [x, y, w, h] = sprite.box;
    this.box = { x: this.x - sprite.originX + x,
      y: this.motion.y - sprite.originY + y, w, h };
  }

  bounds() {
    return this.box;
  }

  makeRound(direction, side = this.side, y = this.motion.y) {
    const d = this.definition;
    const [offsetX, offsetY] = d.muzzle[side];
    return {
      x: this.x + offsetX, y: y + offsetY, direction,
      dx: d.vectors[direction][0] * d.bulletSpeed,
      dy: d.vectors[direction][1] * d.bulletSpeed,
      frame: d.bulletFrame, damage: 4, fixed: true,
    };
  }

  update(camera, ceiling, randomWord, player) {
    this.hit = Math.max(0, this.hit - 1);
    if (this.motion.y > ceiling + 0xd0 - camera) {
      this.dead = true;
      return;
    }
    if (this.frame.duration && ++this.frameTicks === this.frame.duration) {
      this.frameTicks = 0;
      this.frameIndex++;
      if (this.frameIndex === this.frames.length) {
        if (this.firing) {
          this.dead = true;
          return;
        }
        this.frameIndex = 0;
      }
    }
    this.motion.y = this.worldY - camera;
    if (this.firing) return;
    const d = this.definition;
    const dy = this.motion.y - player.y;
    if (dy >= -30 && dy <= 10 && (randomWord() & 255) < d.chance) {
      this.firing = true;
      this.direction = this.frameIndex = this.frameTicks = 0;
      return d.directions[this.side].map((direction) => this.makeRound(direction));
    }
    this.worldY += this.direction;
    this.motion.y += this.direction;
    this.remaining += this.direction;
    if (!this.remaining || this.remaining === this.travel) this.direction = -this.direction;
    this.updateBounds();
  }
}

// Stage-two map-only actors CS:7ac4/7bef/7ce6 live outside the damageable actor list.
export class GroundHatch {
  constructor(event, definition) {
    this.definition = definition;
    this.type = event[1];
    this.side = event[6] ? 1 : 0;
    this.x = event[4] - 8;
    this.worldY = event[5] - 8;
    this.cell = Math.floor(this.worldY / 16) * 20 + Math.floor(this.x / 16);
    this.phase = 0;
    this.repeats = this.type === 2 ? 0 : 1;
    this.dead = false;
    this.patches = definition.initial?.[this.side];
  }

  update(camera, ceiling, tick, randomWord) {
    const d = this.definition;
    const y = this.worldY - camera;
    if (this.type === 2) {
      if (!this.phase) {
        if (y >= d.threshold) this.phase = 1;
        return [];
      }
      this.patches = d.frames[this.side][this.phase];
      if (++this.phase < 21) return [];
      this.dead = true;
      return d.creature.spawns.map((spawn) => ({
        definition: d.creature, frames: spawn.frames, direction: spawn.direction,
        x: this.x + 16 + spawn.x, y: y + 16 + spawn.y, age: randomWord() & 31,
      }));
    }
    if (this.worldY >= ceiling + 208) {
      this.dead = true;
      return [];
    }
    if (y >= 180) return [];
    if (this.phase >= 5) {
      if (!this.repeats) { this.dead = true; return []; }
      if (this.phase >= 9) { this.phase = 0; this.repeats--; }
    }
    if (this.phase <= 1) {
      if (y >= 100) this.phase = 2;
      else if (this.type === 5 && !(tick & 3)) this.phase ^= 1;
      else if (this.type === 4) return [];
    }
    this.patches = d.frames[0][this.phase];
    if (this.phase < 2 || (tick & 3)) return [];
    if (++this.phase !== 4) return [];
    const offset = this.type === 5 ? 16 : 0;
    return [{ definition: d.creature, x: this.x + offset, y: y + offset }];
  }
}

// Hatchling pursuit/dive CS:830c and short-lived eight-way swarm CS:85d0.
export class GroundCreature {
  constructor(spawn, sprite, actorPhase = 0) {
    this.definition = spawn.definition;
    this.sprite = sprite;
    this.actorPhase = actorPhase & 15;
    this.health = this.definition.health;
    this.ground = this.spriteActor = true;
    this.dead = this.expired = false;
    this.hit = this.state = 0;
    this.age = spawn.age || 0;
    this.direction = spawn.direction || 0;
    this.motion = { x: spawn.x, y: spawn.y };
    this.setFrames(spawn.frames || this.definition.frames);
    this.updateBounds();
  }

  setFrames(frames) {
    this.frames = frames;
    this.frameIndex = this.frameTicks = 0;
  }

  get frame() {
    return this.frames[this.frameIndex];
  }

  bounds() {
    return this.box;
  }

  updateBounds() {
    const sprite = this.sprite(this.frame);
    const [x, y, w, h] = sprite.box;
    this.box = { x: this.motion.x - sprite.originX + x,
      y: this.motion.y - sprite.originY + y, w, h };
  }

  update(camera, _ceiling, _randomWord, player, tick, delta) {
    this.hit = Math.max(0, this.hit - 1);
    if (this.frame.duration && ++this.frameTicks === this.frame.duration) {
      this.frameTicks = 0;
      if (++this.frameIndex === this.frames.length) this.frameIndex = 0;
    }
    const d = this.definition;
    const p = this.motion;
    if (d.kind === "swarm") {
      if (++this.age >= 80) { this.dead = this.expired = true; return; }
      if (!(this.age & 15)) {
        this.direction = (~shotDirection(player.x - p.x, player.y - p.y)) & 7;
        this.setFrames(d.directions[this.direction]);
      }
      const [dx, dy] = d.vectors[this.direction];
      const x = p.x + dx;
      if (x < 0 || x >= 320) { this.dead = true; return; }
      p.x = x;
      const y = p.y + dy + delta;
      if (y < 0 || y >= 192) { this.dead = true; return; }
      p.y = y;
    } else if (this.state) {
      p.y += 12;
      if (p.y >= 160) {
        this.state = 0;
        this.setFrames(d.frames);
      }
    } else if (p.y > 50) {
      p.y -= 5;
      p.x += d.wobble[(((tick + this.actorPhase) & 65535) >>> 2) & 7];
    } else if (Math.abs(p.x - player.x) < 10) {
      this.state = 1;
      this.setFrames(d.attacking);
    } else {
      p.x += p.x < player.x ? 4 : -4;
      p.y = Math.min(50, p.y + d.wobble[(((tick + this.actorPhase) & 65535) >>> 1) & 7]);
    }
    this.updateBounds();
  }
}

import { shotDirection } from "./boss.js";
import { GroundStageFiveSprite } from "./stage-five-ground.js";
import { stageFiveBeam } from "./stage-five-miniboss.js";

const disabled = { x: 1000, y: 0, w: 0, h: 0 };

class ArenaSeeker extends GroundStageFiveSprite {
  constructor(x, y, boss, game) {
    super(boss.definition.seeker, game);
    this.boss = boss;
    this.motion = { x, y };
    this.age = 1;
    this.direction = 0;
    this.setFrames(this.definition.frames[0]);
  }

  step() {
    const { game, motion, definition: d } = this;
    this.animate();
    if (!(++this.age & 7)) {
      const turn = (shotDirection(game.player.x - motion.x, game.player.y - motion.y) - this.direction) & 7;
      if (turn) {
        this.direction = (this.direction + (turn < 4 ? 1 : -1)) & 7;
        this.setFrames(d.frames[this.direction]);
      }
    }
    const [dx, dy] = d.vectors[this.direction];
    const speed = this.boss.remaining ? 1 : 2;
    motion.x += dx * speed;
    motion.y += dy * speed;
    this.updateBounds();
  }
}

// CS:d4a8/d62c: a separate arena with eighteen defenses shielding the final core.
export class StageFiveBoss {
  constructor(definition) {
    this.definition = definition;
    this.parts = [];
    this.y = definition.y;
    this.hatchCounter = this.hatch = this.hit = 0;
  }

  spawn(game) {
    if (this.parts.length) return;
    const d = this.definition;
    this.parts = d.parts.map((part) => {
      const actor = {
        definition: part, motion: { x: 48, y: this.y }, frame: part.frame,
        health: part.kind === "core" ? d.health : part.health,
        frameIndex: part.kind === "guard" ? 1 : 0,
        frameTicks: part.kind === "guard" ? part.frames[0].duration : 0,
        counter: 0, hit: 0, box: disabled, ground: true, boss: true, finalBoss: this,
        indestructible: part.kind === "wall" || part.kind === "core", bounds: () => actor.box,
      };
      return actor;
    });
    this.remaining = this.parts.length - 3;
    game.camera = game.control.camera = game.control.ceiling = d.camera;
    game.setCheckpointPosition(d.camera);
    game.eventStreamsClosed = true;
    for (let cell = 0; cell < 0x30c; cell++) {
      const row = Math.floor(cell / 20) - 6, col = cell % 20 - 3;
      const tile = row >= 0 && row < 18 && col >= 0 && col < 15 ? d.arena[row * 15 + col] : 0;
      game.patchGround({ cell }, [tile]);
    }
    game.ground = [];
    if (game.miniboss) game.miniboss.dead = true;
  }

  get targets() {
    return this.dead ? [] : this.parts.filter((part) => !part.dead && !part.destroyed);
  }

  arenaRegion() {
    return { x: 48, y: this.y, tiles: this.definition.arena, width: 15 };
  }

  hatchSprites() {
    if (!this.hatch) return [];
    const phase = Math.abs(this.hatch) >>> 2;
    const x = 153, y = this.y + (this.hatch < 0 ? 229 : 85);
    return [{ x, y, frame: this.definition.hatchFrames[phase] },
      ...(phase >= 5 && phase < 10
        ? [{ x: x + 14, y: y + 16, frame: this.definition.hatchFlashes[phase - 5] }] : [])];
  }

  firing(actor, rate, game) {
    actor.counter += rate;
    if (actor.counter < 256) return false;
    actor.counter = game.randomWord() & 63;
    return true;
  }

  update(game) {
    if (!this.parts.length || this.dead) return;
    const d = this.definition;
    game.control.ceiling = d.camera;
    this.y += game.control.delta;
    this.hit = 0;
    if (this.hatch) {
      this.hatch += Math.sign(this.hatch) * 2;
      if (Math.abs(this.hatch) === 60) this.hatch = 0;
      if (Math.abs(this.hatch) === 40) {
        const add = new ArenaSeeker(167, this.y + (this.hatch < 0 ? 245 : 101), this, game);
        game.ground.push(add);
        add.step();
      }
    } else {
      this.hatchCounter += d.hatchRate;
      if (this.hatchCounter >= 256) {
        this.hatchCounter = game.randomWord() & 63;
        this.hatch = game.tick & 1 ? 2 : -2;
      }
    }
    for (const actor of this.parts) {
      if (actor.dead) continue;
      const { motion, definition: p } = actor;
      motion.x = 48 + p.x;
      motion.y = this.y + p.y;
      actor.hit = 0;
      if (actor.destroyed) {
        actor.frame = d.deadGun;
        continue;
      }
      if (p.kind === "wall") {
        // CS:d60b adds the height to BL only, so the bottom wraps within its byte.
        const bottom = (motion.y & ~255) | ((motion.y + p.wallHeight) & 255);
        actor.box = { x: motion.x, y: motion.y, w: p.health + 1, h: bottom - motion.y + 1 };
        continue;
      }
      if (p.kind === "gun") {
        const direction = shotDirection(game.player.x - motion.x, game.player.y - motion.y);
        actor.frame = d.gunFrames[direction];
        if (this.firing(actor, d.gunRate, game)) {
          const [dx, dy] = d.vectors[direction];
          game.bullets.push({ x: motion.x + 8, y: motion.y + 8,
            dx: dx * d.gunSpeed, dy: dy * d.gunSpeed, frame: d.gunBullet, damage: 4, fixed: true });
        }
      } else if (p.kind === "beam" || p.kind === "guard") {
        if (actor.frameTicks && !--actor.frameTicks) {
          const frame = p.frames[actor.frameIndex];
          if (frame) {
            actor.frame = frame;
            actor.frameTicks = frame.duration;
            actor.frameIndex++;
          } else {
            actor.frame = p.frame;
            actor.frameIndex = p.kind === "guard" ? 1 : 0;
            actor.frameTicks = p.kind === "guard" ? p.frames[0].duration : 0;
          }
        }
        if (p.kind === "beam") {
          if (actor.frameIndex === 1 && actor.frameTicks === 1) {
            game.bullets.push(stageFiveBeam(motion.x - 2, motion.y - 24, -d.beamSpeed));
          }
          if (!actor.frameTicks && motion.y >= 0 && this.firing(actor, d.beamRate, game)) actor.frameTicks = 1;
        }
      } else {
        actor.indestructible = this.remaining !== 0;
        if (actor.indestructible) continue;
      }
      actor.box = game.bounds(game.sprite(actor.frame), motion.x, motion.y);
    }
  }

  damage(actor, amount) {
    if (actor.definition.kind === "core") {
      actor.health -= amount;
      this.hit = 3;
      if (actor.health > 0) actor.frame = this.definition.coreFrames[Math.floor(11 * actor.health / this.definition.health)];
    } else actor.health -= amount;
  }

  destroy(actor, game) {
    game.kills++;
    const kind = actor.definition.kind;
    if (kind !== "core") {
      this.remaining--;
      if (kind === "gun") actor.destroyed = true;
      else actor.dead = true;
      actor.box = disabled;
      const sprite = game.sprite(actor.frame);
      game.explode(actor.motion.x - sprite.originX + Math.floor(sprite.width / 2),
        actor.motion.y - sprite.originY + Math.floor((sprite.height - 1) / 2), actor.definition.contactDamage === 16);
      game.score += 200;
      return;
    }
    this.dead = true;
    for (const part of this.parts) part.dead = true;
    game.enemies = [];
    game.ground = [];
    for (let pair = 0; pair < 10; pair++) for (const value of [50, 100]) {
      game.pickups.push({ kind: "credit", counted: true, value, age: 0, state: 7, direction: 0,
        x: game.randomWord() % 300 + 10, y: game.randomWord() % 180 + 6 });
      game.countedCredits++;
    }
    for (let i = 0; i < 40; i++) game.explode(game.randomWord() % 320, game.randomWord() % 192, true);
    for (let cell = 0; cell < 0x30c; cell++) game.patchGround({ cell }, [0]);
  }
}

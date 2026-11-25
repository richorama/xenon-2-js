import { PathMotion } from "./motion.js";

const disabledBox = () => ({ x: 1000, y: 0, w: 0, h: 0 });
const direction = (motion) => (((motion.heading >>> 16) + 16) >>> 5) & 7;

// CS:9b22-9da9: a path-driven worm whose tail gates the next appearance.
export class StageThreeBoss {
  constructor(definition, paths, sine, sprite) {
    this.definition = definition;
    this.paths = paths;
    this.sine = sine;
    this.sprite = sprite;
    this.health = definition.health;
    this.parts = [];
    this.pathCounter = 0;
    this.pathSeed = 0xe496;
    this.active = this.dead = this.present = this.rewardsPending = false;
    this.hit = 0;
  }

  get targets() { return this.dead ? [] : this.parts.filter((part) => !part.dead); }

  setFrames(actor, frames) {
    actor.frames = frames;
    actor.frameIndex = 0;
    actor.frame = frames[0];
    actor.frameTicks = actor.frame.duration;
  }

  animate(actor) {
    if (actor.frameTicks > 0 && !--actor.frameTicks) {
      actor.frameIndex = (actor.frameIndex + 1) % actor.frames.length;
      actor.frame = actor.frames[actor.frameIndex];
      actor.frameTicks = actor.frame.duration;
    }
  }

  spawn(game) {
    let selection;
    if (this.pathCounter !== 1) selection = this.pathCounter++;
    else {
      do {
        this.pathSeed = ((this.pathSeed >>> 5) | (this.pathSeed << 11)) & 65535;
        selection = this.pathSeed & 7;
      } while (!selection || selection === 7);
    }
    let delay = 0;
    this.parts = this.definition.parts.map((part, index) => {
      const motion = new PathMotion(this.paths, 61 + selection, this.sine, { delay });
      delay += part.spacing;
      motion.cursor = motion.base;
      motion.yFixed -= (game.camera + game.control.scroll) * 65536;
      motion.heading = 192 * 65536;
      const actor = {
        index, definition: part, motion, finalBoss: this, boss: true, ground: true,
        indestructible: index !== 0, fireCounter: 0, dead: false,
        bounds: () => actor.dead ? disabledBox() : actor.box,
      };
      Object.defineProperties(actor, {
        health: { get: () => this.health, set: (value) => { this.health = value; } },
        hit: { get: () => this.hit, set: (value) => { this.hit = value; } },
      });
      this.setFrames(actor, [{ ...part.frame, duration: 0 }]);
      this.updateBounds(actor);
      return actor;
    });
    this.active = true;
  }

  updateBounds(actor) {
    const sprite = this.sprite(actor.frame);
    const [x, y, w, h] = sprite.box;
    actor.box = { x: actor.motion.x - sprite.originX + x,
      y: actor.motion.y - sprite.originY + y, w, h };
  }

  update(game) {
    this.hit = 0;
    if (game.camera <= 208) {
      game.control.ceiling = Math.max(32, game.control.ceiling);
      if (!this.dead && !this.present) this.spawn(game);
      this.present = false;
      if (this.rewardsPending) {
        for (let pair = 0; pair < 10; pair++) for (const value of [50, 100]) {
          game.pickups.push({ kind: "credit", counted: true, value, age: 0, state: 7, direction: 0,
            x: game.randomWord() % 300 + 10, y: game.randomWord() % 180 + 6 });
          game.countedCredits++;
        }
        this.rewardsPending = false;
      }
    }
    if (this.dead) return;
    for (const actor of [...this.parts].reverse()) {
      if (actor.dead) continue;
      const motion = actor.motion;
      motion.yFixed += game.control.delta * 65536;
      const previous = direction(motion);
      if (!actor.index) this.animate(actor);
      if (actor.index === this.parts.length - 1) this.present = true;
      motion.step(this.definition.speed);
      actor.dead = !motion.active;
      const current = direction(motion);
      if (!actor.index) {
        if (previous !== current) this.setFrames(actor, this.definition.heads[current]);
        const sum = actor.fireCounter + this.definition.fireRate;
        actor.fireCounter = sum & 255;
        if (sum > 255) {
          for (let direction = 7; direction >= 0; direction--) {
            const [dx, dy] = this.definition.vectors[direction];
            game.bullets.push({ x: motion.x, y: motion.y, direction,
              dx: dx * this.definition.bulletSpeed, dy: dy * this.definition.bulletSpeed,
              frame: this.definition.bullet[0], frames: this.definition.bullet, fixed: true, damage: 4 });
          }
        }
      } else {
        const group = actor.definition.update === 0x9cd6 ? 0
          : actor.definition.update === 0x9cfb ? 1 : 2;
        actor.frame = this.definition.bodies[group][current];
      }
      this.updateBounds(actor);
    }
  }

  destroy(actor, game) {
    if (this.dead || actor.indestructible) return;
    this.dead = this.rewardsPending = true;
    this.present = false;
    for (const part of this.parts) part.dead = true;
    for (let i = 0; i < 20; i++) game.explode(game.randomWord() % 320, game.randomWord() % 192, true);
    game.enemies = [];
    game.ground = [];
    game.kills++;
  }
}

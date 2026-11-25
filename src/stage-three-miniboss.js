import { PathMotion } from "./motion.js";
import { shotDirection } from "./boss.js";

const disabledBox = () => ({ x: 1000, y: 0, w: 0, h: 0 });

// CS:a0e5-a1d1 constructs the ordered, 17-part composite at background event 3.
export class StageThreeMiniboss {
  constructor(definition, paths, sine, sprite) {
    this.definition = definition;
    this.paths = paths;
    this.sine = sine;
    this.sprite = sprite;
    this.parts = [];
    this.active = this.dead = this.present = this.shopPending = false;
    this.remaining = 2;
    this.hit = 0;
  }

  spawn() {
    if (this.active || this.dead) return;
    const d = this.definition;
    this.parts = d.parts.map((part, index) => {
      const motion = new PathMotion(this.paths, d.path, this.sine);
      motion.xFixed -= 32 * 65536;
      motion.yFixed -= 40 * 65536;
      if (index) motion.turn = (part.y << 16) | (part.x & 65535);
      const actor = {
        index, definition: part, motion, miniboss: this, boss: true, ground: true,
        indestructible: part.damage !== 0x9f1c, health: d.eyeHealth,
        speed: d.speed, fireCounter: 0, amplitude: 0, amplitudeDelta: 0,
        enabled: true, destroyed: false, dead: false,
        bounds: () => actor.enabled && !actor.dead ? actor.box : disabledBox(),
        acceptsHit: () => actor.enabled && !actor.destroyed,
      };
      Object.defineProperty(actor, "hit", {
        get: () => this.hit, set: (value) => { this.hit = value; },
      });
      this.setFrames(actor, part.frames);
      this.updateBounds(actor);
      return actor;
    });
    this.active = this.present = true;
  }

  get targets() { return this.dead ? [] : this.parts; }

  setFrames(actor, frames) {
    actor.frames = frames;
    actor.frameIndex = 0;
    actor.frame = frames[0];
    actor.frameTicks = actor.frame.duration;
  }

  animate(actor) {
    if (actor.frameTicks > 0 && !--actor.frameTicks) {
      if (++actor.frameIndex === actor.frames.length) {
        this.setFrames(actor, actor.definition.frames);
      } else {
        actor.frame = actor.frames[actor.frameIndex];
        actor.frameTicks = actor.frame.duration;
      }
    }
  }

  updateBounds(actor) {
    const sprite = this.sprite(actor.frame);
    const [x, y, w, h] = sprite.box;
    actor.box = { x: actor.motion.x - sprite.originX + x,
      y: actor.motion.y - sprite.originY + y, w, h };
  }

  follow(actor) {
    const root = this.parts[0].motion;
    actor.motion.xFixed = (root.x + actor.definition.x) * 65536;
    actor.motion.yFixed = (root.y + actor.definition.y) * 65536;
  }

  updateEye(actor, randomWord) {
    this.animate(actor);
    this.follow(actor);
    this.updateBounds(actor);
    actor.enabled = false;
    if (actor.destroyed || actor.health <= 0) {
      actor.frame = this.definition.deadEyes[actor.index - 3];
      actor.frameTicks = 0;
      return;
    }
    if (actor.frameTicks) { actor.enabled = true; return; }
    const sum = actor.fireCounter + this.definition.eyeRate;
    actor.fireCounter = sum & 255;
    if (sum > 255) {
      actor.fireCounter = randomWord() & 63;
      this.setFrames(actor, this.definition.eyeOpen);
    }
  }

  updateArm(actor, randomWord, player) {
    this.animate(actor);
    this.follow(actor);
    const next = this.parts[actor.index + 1].motion;
    if (actor.amplitude) {
      actor.amplitude += actor.amplitudeDelta;
      if (actor.amplitude === 14) actor.amplitudeDelta = -actor.amplitudeDelta;
      this.parts[actor.index + 1].speed = actor.amplitude;
    } else if ((randomWord() & 255) < 3) {
      actor.amplitude = actor.amplitudeDelta = 1;
      let angle = ((shotDirection(player.x - actor.motion.x, player.y - actor.motion.y) << 5) - 96) & 255;
      let turn = ((randomWord() & 31) + 32) << 10;
      if (actor.index === 5) { angle = (angle + 64) & 255; turn = -turn; }
      next.heading = angle * 65536;
      // The DOS code negates only the low turn word; its high word stays zero.
      next.turn = turn & 65535;
      next.acceleration = 0;
      this.parts[actor.index + 1].speed = 1;
    } else {
      this.parts[actor.index + 1].speed = 0;
      next.heading = 64 * 65536 + (next.heading & 65535);
    }
    this.updateBounds(actor);
  }

  updateSegment(actor, tick) {
    const motion = actor.motion, previous = this.parts[actor.index - 1].motion;
    motion.xFixed = previous.xFixed;
    motion.yFixed = previous.yFixed;
    motion.remaining = 1000;
    const saved = [motion.heading, motion.turn, motion.acceleration];
    motion.step(actor.speed);
    if (actor.definition.update === 0xa027) {
      const next = this.parts[actor.index + 1];
      [next.motion.heading, next.motion.turn, next.motion.acceleration] =
        [motion.heading, motion.turn, motion.acceleration];
      next.speed = actor.speed;
      [motion.heading, motion.turn, motion.acceleration] = saved;
    } else {
      actor.frame = this.definition.tips[((motion.heading >>> 20) & 14) + ((tick & 4) >>> 2)];
      actor.frameTicks = 0;
    }
    this.updateBounds(actor);
  }

  update(game) {
    const { camera, control, player, tick } = game;
    const d = this.definition;
    if (game.endCamera === d.floor && camera === d.floor) {
      control.ceiling = d.floor;
      control.scroll = 0;
      if (!this.present) game.endCamera = 0;
      this.present = false;
    }
    const reverseLimit = camera > 208 ? 2608 : 32;
    if (control.ceiling < reverseLimit) control.ceiling = reverseLimit;
    this.hit = 0;
    if (!this.active || this.dead) return;
    this.present = true;
    for (const actor of this.parts) {
      switch (actor.definition.update) {
        case 0x9e32: {
          this.animate(actor);
          actor.motion.step(d.speed);
          this.updateBounds(actor);
          const sum = actor.fireCounter + d.fireRate;
          actor.fireCounter = sum & 255;
          if (sum > 255) {
            actor.fireCounter = game.randomWord() & 63;
            const x = actor.motion.x, y = actor.motion.y;
            const direction = shotDirection(player.x - x, player.y - y);
            const [dx, dy] = d.vectors[direction];
            game.bullets.push({ x: x + 16, y: y + 60, direction,
              dx: dx * d.bulletSpeed, dy: dy * d.bulletSpeed,
              frame: d.bullet[0], frames: d.bullet, damage: 4, fixed: true });
          }
          break;
        }
        case 0x9e89:
          this.animate(actor);
          this.follow(actor);
          this.updateBounds(actor);
          break;
        case 0x9ea4: this.updateEye(actor, () => game.randomWord()); break;
        case 0x9f7f: this.updateArm(actor, () => game.randomWord(), player); break;
        default: this.updateSegment(actor, tick);
      }
    }
  }

  destroy(actor, game) {
    if (this.dead || actor.destroyed || actor.indestructible) return;
    actor.destroyed = true;
    actor.enabled = false;
    const explode = (part, large) => {
      const sprite = this.sprite(part.frame);
      game.explode(part.motion.x - sprite.originX + Math.floor(sprite.width / 2),
        part.motion.y - sprite.originY + Math.floor((sprite.height - 1) / 2), large);
    };
    explode(actor, false);
    if (--this.remaining) return;
    for (const part of [...this.parts.slice(1), this.parts[0]]) {
      explode(part, true);
      part.dead = true;
    }
    game.score += 1000;
    game.kills++;
    for (let pair = 0; pair < 5; pair++) {
      for (const value of [50, 100]) {
        game.pickups.push({ kind: "credit", counted: true, value, age: 0, state: 7, direction: 0,
          x: game.randomWord() % 300 + 10, y: game.randomWord() % 180 + 6 });
        game.countedCredits++;
      }
    }
    this.dead = this.shopPending = true;
  }
}

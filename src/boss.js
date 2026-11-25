import { ActorList } from "./actor-pool.js";

// Stage-one controller CS:714d-758e and articulated arm updater CS:71dd.
export function shotDirection(x, y) {
  if (y < 0) return (4 - shotDirection(x, -y)) & 7;
  if (x < 0) return (8 - shotDirection(-x, y)) & 7;
  if (!x) return 4;
  if (!y) return 2;
  if (x === y) return 3;
  if (x < y) return Math.floor(Math.floor(x / 2) * 65536 / y) >= 0x3504 ? 3 : 4;
  return Math.floor(Math.floor(y / 2) * 65536 / x) >= 0x3504 ? 3 : 2;
}

const disabledBox = () => ({ x: 1000, y: 0, w: 0, h: 0 });

export class StageOneBoss {
  constructor(definition, sine, sprite) {
    this.definition = definition;
    this.sine = sine;
    this.sprite = sprite;
    this.health = definition.health;
    this.worldY = 16;
    this.phase = this.speed = this.dy = this.wait = this.mouthAge = 0;
    this.heading = this.turn = this.acceleration = 0;
    this.ground = this.boss = true;
    this.active = this.dead = false;
    this.hit = 0;
    this.motion = { x: 160, y: -100 };
    this.bodyBox = disabledBox();
    this.arms = [];
  }

  allocateCore(game) {
    game.run.actorPool.allocate(game.actorLists, ActorList.main, 0x50, this);
  }

  activate(game) {
    let previous;
    for (let index = 0; index < 8; index++) {
      const arm = {
        stageOneBoss: this, index,
        parent: previous?.actor ?? this,
        ground: true, indestructible: true, dead: false, hit: 0,
        motion: { x: 0, y: -100 }, xFixed: 0, yFixed: -100 * 65536,
        frame: this.definition.arm, fireCounter: 0, box: disabledBox(),
        bounds() { return this.box; },
      };
      previous = game.run.actorPool.allocate(game.actorLists, ActorList.main, index === 7 ? 0x100 : 0xfc,
        arm, previous);
      if (!previous) break;
      this.arms.push(arm);
    }
  }

  bounds() {
    return this.active && !this.dead ? this.bodyBox : disabledBox();
  }

  acceptsHit(shot, bounds) {
    if (shot.electroBall || shot.bomb || shot.flame || shot.mine || shot.shades) {
      return bounds.x <= 167 && bounds.x + bounds.w > 152
        && bounds.y <= this.weakY + 14 && bounds.y + bounds.h > this.weakY;
    }
    const x = shot.point ? shot.x : shot.x - 1;
    const y = shot.point ? shot.y : shot.y - 4;
    return x <= 167 && x + (shot.point ? 0 : 2) >= 152
      && y <= this.weakY + 14 && y + (shot.point ? 0 : 7) >= this.weakY;
  }

  get targets() {
    return this.active && !this.dead ? [this, ...this.arms.filter((arm) => !arm.dead)] : [];
  }

  updateCore(camera, control, tick, activate, aimOperand) {
    this.hit = Math.max(0, this.hit - 1);
    this.motion.y = this.worldY - camera;
    if (this.dead || camera > 0x1c0) {
      this.bodyBox = disabledBox();
      return aimOperand;
    }
    if (!this.active) {
      this.active = true;
      activate();
    }
    if (control.ceiling <= 0x1c0) control.ceiling = 0x1c0;
    this.bodyBox = { x: 128, y: this.motion.y + 4, w: 73, h: 81 };
    if (!this.phase && camera <= 0x30) {
      this.phase = 1;
      this.dy = 0;
      this.wait = 170;
    }
    if (this.phase) {
      this.speed = Math.max(0, Math.min(11, this.speed + (this.phase < 0 ? -1 : 1)));
      if (++this.phase === 0) this.phase++;
      if (this.phase >= 100) this.phase = -40;
      let angle = tick & 127;
      if (angle & 64) angle = 127 - angle;
      this.heading = (angle + 32) * 65536;
      angle = (tick + 80) & 255;
      if (angle & 128) angle ^= 255;
      this.turn = (angle - 64) * 1024;
      angle = (tick + 160) & 511;
      if (angle & 256) angle ^= 511;
      this.acceleration = (angle - 128) * 32;
      this.worldY += this.dy;
      if (this.worldY < 16 || this.worldY > 480) {
        this.worldY = Math.max(16, Math.min(480, this.worldY));
        this.wait = 0;
      }
      if (--this.wait < 0) {
        if (this.dy === -1) { this.dy = 0; this.wait = 170; }
        else if (this.dy === 1) { this.dy = 0; this.wait = 60; }
        else { this.dy = this.worldY === 16 ? 1 : -1; this.wait = 50; }
      }
      this.mouthAge = (this.mouthAge + 30 - this.health) & 255;
    } else {
      this.bodyBox = disabledBox();
    }
    this.motion.y = this.worldY - camera;
    this.weakY = this.motion.y + 68;
    return this.definition.tileAnimationPointers[(tick >> 2) & 3] + 12;
  }

  updateArm(arm, camera, randomWord, player, pool, aimOperand) {
    const parent = arm.parent;
    const address = parent.actorAddress;
    const slot = pool.recordsByAddress.get(address);
    const type = slot?.type;
    const replacement = type === 0x14 || type === 0x0c || type === 0x10 || type === 0x30
      || slot?.actor?.kind === "reward" || slot?.actor?.kind === "credit"
      ? slot.actor : undefined;
    const fromCore = parent === this && !replacement;
    if (replacement) {
      // These replacement constructors retain the fractional coordinates, turn and acceleration.
      const [x, y] = pool.subpixels.get(address) || [0, 0];
      arm.xFixed = replacement.x * 65536 + x;
      arm.yFixed = replacement.y * 65536 + y;
      arm.heading = ((pool.headings.get(address) ?? 0) << 16) | (parent.heading & 65535);
    } else {
      arm.xFixed = fromCore ? 160 * 65536 : parent.xFixed;
      arm.yFixed = fromCore ? (this.worldY - camera + 96) * 65536 : parent.yFixed;
      arm.heading = parent.heading;
    }
    arm.turn = parent.turn ?? 0;
    const speed = arm.speed = (replacement ? pool.movementBudgets.get(address) : undefined) ?? parent.speed;
    const acceleration = arm.acceleration = parent.acceleration ?? 0;
    for (let step = 0; step < speed; step++) {
      const angle = aimOperand = arm.heading >> 16;
      // CS:48de indexes the code segment before wrapping the inherited heading.
      if (angle < 0 || angle > 255) {
        arm.xFixed += this.definition.motionCode[(0x6156 + angle) & 65535] * 1024;
        arm.yFixed += this.definition.motionCode[(0x6116 + angle) & 65535] * 1024;
      } else {
        arm.xFixed += this.sine[(angle + 64) & 255] * 1024;
        arm.yFixed += this.sine[angle] * 1024;
      }
      arm.heading = (arm.heading + arm.turn) & 0xffffff;
      arm.turn = (arm.turn + acceleration) | 0;
    }
    arm.motion.x = Math.floor(arm.xFixed / 65536);
    arm.motion.y = Math.floor(arm.yFixed / 65536);
    let bullet;
    if (speed && arm.index === 7) {
      const direction = shotDirection(player.x - arm.motion.x, player.y - arm.motion.y);
      aimOperand = direction * 2;
      arm.heading = direction * 65536 + (arm.heading & 65535);
      arm.frame = this.definition.tip[direction];
      if (speed >= 11) {
        const sum = arm.fireCounter + 15;
        arm.fireCounter = sum & 255;
        if (sum > 255) {
          arm.fireCounter = randomWord() & 63;
          const [dx, dy] = this.definition.vectors[direction];
          bullet = { x: arm.motion.x, y: arm.motion.y, dx: dx * 4, dy: dy * 4,
            direction, frame: this.definition.bullet[0], frames: this.definition.bullet, damage: 4, fixed: true };
          aimOperand = bullet.y;
        }
      }
    }
    const sprite = this.sprite(arm.frame);
    const [x, y, w, h] = sprite.box;
    arm.box = speed ? {
      x: arm.motion.x - sprite.originX + x, y: arm.motion.y - sprite.originY + y, w, h,
    } : disabledBox();
    return { bullet, aimOperand };
  }
}

// Boss and wall-hunter rewards use CS:28df, not the provisional falling-pickup motion.
export function moveCredit(pickup, definition) {
  let state = pickup.state;
  if (!state) {
    pickup.y += 8;
    if (pickup.y >= 200) pickup.dead = true;
    return;
  }
  if (state < 0) {
    state++;
    if (!(state & 3)) pickup.direction = (pickup.direction + 1) & 7;
  } else {
    state &= 7;
    if (!state) pickup.direction = shotDirection(160 - pickup.x, 100 - pickup.y);
    state++;
    if ((160 - pickup.x) ** 2 + (100 - pickup.y) ** 2 < 400) state = -34;
  }
  pickup.state = state;
  const [dx, dy] = definition.vectors[pickup.direction & 7];
  pickup.x += dx;
  pickup.y += dy;
}

export function frameAt(frames, age) {
  let length = 0;
  for (const frame of frames) {
    if (!frame.duration) {
      if (age >= length) return frame;
      break;
    }
    length += frame.duration;
  }
  if (!length) throw new Error("Empty animation");
  age %= length;
  for (const frame of frames) {
    if (age < frame.duration) return frame;
    age -= frame.duration;
  }
  return frames[0];
}

// Native translation of CS:4871-4a66. Coordinates and turn rates are 16.16.
export class PathMotion {
  constructor(paths, index, sine, { delay = 0, offsetX = 0, seed = 1, randomWord } = {}) {
    if (index < 1 || index > paths.offsets.length) throw new Error("Invalid path number");
    this.data = new DataView(paths.bytes.buffer, paths.bytes.byteOffset, paths.bytes.byteLength);
    this.base = paths.offsets[index - 1];
    this.cursor = this.base;
    this.sine = sine;
    this.xFixed = offsetX * 65536;
    this.yFixed = 0;
    this.heading = 0;
    this.turn = 0;
    this.acceleration = 0;
    this.remaining = -delay;
    this.seed = seed;
    this.randomWord = randomWord;
    this.active = true;
    if (this.word(this.cursor) === 10) {
      this.xFixed += this.word(this.cursor + 2) * 65536;
      this.yFixed = this.word(this.cursor + 4) * 65536;
      this.cursor += 6;
    }
  }

  word(offset) {
    if (offset < 0 || offset + 2 > this.data.byteLength) throw new Error("Path outside bank");
    return this.data.getInt16(offset, true);
  }

  get x() { return Math.floor(this.xFixed / 65536); }
  get y() { return Math.floor(this.yFixed / 65536); }

  step(budget, aimOperand) {
    if (!this.active) return aimOperand;
    if (this.remaining < 0) {
      budget += this.remaining;
      if (budget <= 0) {
        this.remaining = budget;
        return aimOperand;
      }
      this.remaining = 0;
    }
    let commands = 0;
    while (budget > 0 && this.active) {
      if (this.remaining > 0) {
        const angle = this.heading >>> 16;
        aimOperand = angle;
        this.xFixed += this.sine[(angle + 64) & 255] * 1024;
        this.yFixed += this.sine[angle] * 1024;
        this.heading = (this.heading + this.turn) & 0xffffff;
        this.turn = (this.turn + this.acceleration) | 0;
        this.remaining--;
        budget--;
        if (!this.remaining && budget) this.remaining = -1;
        continue;
      }
      if (++commands > 1024) throw new Error("Path command loop");
      const command = aimOperand = this.word(this.cursor);
      switch (command) {
        case 0:
          this.active = false;
          break;
        case 2:
          this.heading = (this.word(this.cursor + 2) & 255) * 65536;
          this.turn = this.word(this.cursor + 4) * 256;
          this.acceleration = this.word(this.cursor + 6);
          this.remaining = this.word(this.cursor + 8);
          if (this.remaining < 0) throw new Error("Negative path segment");
          this.cursor += 10;
          break;
        case 4:
          budget -= this.word(this.cursor + 2);
          this.cursor += 4;
          if (budget <= 0) {
            this.remaining = budget;
            return aimOperand;
          }
          break;
        case 6: {
          let offset = -1;
          for (let attempt = 0; attempt < 256 && offset < 0; attempt++) {
            const random = this.randomWord ? this.randomWord()
              : (this.seed = (this.seed * 0x6255 + 0x3619) & 65535);
            offset = this.word(this.cursor + 2 + (random & 14));
          }
          if (offset < 0) throw new Error("Empty random path branch");
          this.cursor = this.base + offset;
          break;
        }
        case 8:
          this.cursor = this.base + this.word(this.cursor + 2);
          break;
        case 10:
          this.cursor += 6;
          break;
        default:
          throw new Error(`Unknown path command ${command}`);
      }
    }
    return aimOperand;
  }
}

// CS:bfff drives both stage-four articulated attacks from the game clock.
export function sweepArc(tick, offset) {
  const angle = tick * 4 & 127, turn = (tick * 2 + 80) & 255, acceleration = (tick + 160) & 511;
  return {
    heading: (offset + (angle & 64 ? 127 - angle : angle)) * 65536,
    turn: ((turn & 128 ? 255 - turn : turn) - 64) * 256,
    acceleration: ((acceleration & 256 ? 511 - acceleration : acceleration) - 128) * 4,
  };
}

export function followArc(actor, previous, sine, motionCode, aimOperand) {
  let { xFixed, yFixed, heading, turn, acceleration, length } = previous;
  // CS:48de uses the incoming heading word as a table offset before wrapping it.
  for (let i = 0; i < length; i++) {
    const angle = aimOperand = heading >> 16;
    xFixed = (xFixed + (angle < 0 || angle > 255
      ? motionCode[(0x6156 + angle) & 65535] : sine[(angle + 64) & 255]) * 1024) | 0;
    yFixed = (yFixed + (angle < 0 || angle > 255
      ? motionCode[(0x6116 + angle) & 65535] : sine[angle]) * 1024) | 0;
    heading = (heading + turn) & 0xffffff;
    turn = (turn + acceleration) | 0;
  }
  Object.assign(actor, { xFixed, yFixed, heading, turn, acceleration, length });
  actor.motion.x = Math.floor(xFixed / 65536);
  actor.motion.y = Math.floor(yFixed / 65536);
  return aimOperand;
}

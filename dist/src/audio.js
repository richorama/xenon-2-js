export const SOUND_RATE = 1193182 / 0x5555;

// Native translation of the two-channel PC-speaker driver at 14b9:0145-040c.
// Addresses name the original driver's state, not CPU instructions.
export class SpeakerDriver {
  constructor(bytes) {
    this.memory = new Uint8Array(65536);
    this.memory.set(bytes);
    this.data = new DataView(this.memory.buffer);
    this.memory[0x24] = 0x16;
    this.stop();
  }

  word(offset, value) {
    if (value !== undefined) this.data.setUint16(offset, value & 65535, true);
    return this.data.getUint16(offset, true);
  }

  start(track = 0) {
    if (track !== 0 && track !== 1) throw new Error("Invalid music track");
    const m = this.memory;
    const descriptor = 0x5e2 + track * 9;
    m[0x22] = m[0x29] = m[0x28] = 0;
    m.fill(0, 0x100, 0x130);
    m[0x25] = m[0x26] = m[descriptor];
    m[0x27] = 255;
    for (const [channel, offset] of [[0x100, 0], [0x118, 4]]) {
      this.word(channel + 4, this.word(descriptor + offset + 3));
      const list = this.word(descriptor + offset + 1);
      this.word(channel, list);
      this.word(channel + 2, this.word(list));
      m[channel + 6] = 1;
    }
    m[0x22] = m[0x29] = 255;
  }

  stop() {
    this.memory[0x22] = this.memory[0x23] = 0;
  }

  effect(index) {
    if (!Number.isInteger(index) || index < 0 || index > 25) throw new Error("Invalid sound effect");
    const m = this.memory;
    m.copyWithin(0x410, 0x420 + index * 15, 0x420 + (index + 1) * 15);
    this.word(0x40d, this.word(0x41d));
    m[0x23] = 255;
  }

  sequence(channel) {
    const m = this.memory;
    let flags = m[channel + 0x12];
    m[channel + 6]--;
    if (m[channel + 6]) {
      if (flags & 0x40) m[channel + 0x16] += flags & 0x80 ? -1 : 1;
      return;
    }
    flags &= 0x30;
    let cursor = this.word(channel + 2);
    const finish = () => {
      m[channel + 6] = m[channel + 7];
      this.word(channel + 2, cursor);
    };
    for (let guard = 0; guard < 1024; guard++) {
      const value = m[cursor++];
      if (value >= 0xe0) m[channel + 7] = value - 0xdf;
      else if (value >= 0xa0) m[channel + 9] = m[value + 0x506];
      else if (value < 0x80) {
        this.word(channel + 0xc, 0);
        m[channel + 0x12] = flags;
        m[channel + 0x16] = value;
        if (!(flags & 4)) this.word(channel + 0xa, this.word(channel + 8));
        finish();
        return;
      } else {
        switch (value) {
          case 0x80: m[channel + 0xa] = 0; finish(); return;
          case 0x81: flags = 0; break;
          case 0x82:
            this.word(channel + 0x14, this.word(cursor));
            cursor += 2;
            flags |= 8;
            m[channel + 0xe] = m[cursor++];
            break;
          case 0x83: flags |= 0xc0; break;
          case 0x84: flags |= 0x40; break;
          case 0x85: {
            let index = (m[channel + 0x13] + 2) & 255;
            if (index === m[channel + 4]) index = m[channel + 5];
            cursor = this.word(this.word(channel) + index);
            m[channel + 0x13] = index;
            break;
          }
          case 0x86:
            m[channel + 0x10] = m[cursor++];
            m[channel + 0x11] = m[cursor++];
            m[channel + 0xf] = m[channel + 0x11] * 2;
            flags |= 0x10;
            break;
          case 0x87: m[0x29] = 0; this.stop(); return;
          case 0x88: m[channel + 0x17] = m[cursor++]; break;
          case 0x89: flags |= 2; break;
          case 0x8a: m[channel + 8] = m[cursor++]; break;
          case 0x8b: flags |= 4; break;
          case 0x8c: m[0x2a] = m[cursor++]; break;
          default: throw new Error(`Unknown music command ${value.toString(16)}`);
        }
      }
    }
    throw new Error("Unterminated music sequence");
  }

  pitch(channel) {
    const m = this.memory;
    let index = (m[channel + 0xb] + 1) & 255;
    let offset = m[0x5b4 + index];
    if (offset >= 128) {
      offset = (offset + 1) & 255;
      if (offset) {
        offset = (offset + 0x7f) & 255;
        index = m[channel + 9];
        m[channel + 0xb] = index;
      }
    } else m[channel + 0xb] = index;
    const note = (offset + m[channel + 0x16] + m[0x2a] + m[channel + 0x17]) & 255;
    let divisor = this.word(0x54 + ((note * 2) & 255));
    let flags = m[channel + 0x12] ^ 1;
    if (flags & 0x10) {
      const step = m[channel + 0x10] || (flags & 1);
      const limit = m[channel + 0xf];
      const phase = (m[channel + 0x11] + (flags & 0x20 ? step : -step)) & 255;
      if (flags & 0x20 ? phase === limit : phase === 0) flags ^= 0x20;
      m[channel + 0x11] = phase;
      divisor += phase - (limit >>> 1);
    }
    if (flags & 8) {
      m[channel + 0xe]--;
      if (!m[channel + 0xe]) {
        m[channel + 0xe] = 1;
        const slide = this.word(channel + 0xc) + this.word(channel + 0x14);
        this.word(channel + 0xc, slide);
        divisor += slide;
      }
    }
    m[channel + 0x12] = flags;
    return (~flags & 3) === 0 ? 2 : divisor & 65535;
  }

  tick() {
    const m = this.memory;
    let divisor = 2;
    const phase = m[0x28] + m[0x24];
    m[0x28] = phase;
    if (phase <= 255 && m[0x22]) {
      const tempo = m[0x27] + m[0x25];
      m[0x27] = tempo;
      if (tempo > 255) {
        this.sequence(0x100);
        this.sequence(0x118);
      }
      const first = this.pitch(0x100);
      this.word(0x2e, first);
      divisor = this.pitch(0x118);
      let alternate = 2;
      if (m[0x10a]) { m[0x10a]--; alternate = first; }
      const gate = m[0x122] & 1;
      m[0x122] >>>= 1;
      if (!gate) divisor = alternate;
    }
    if (m[0x23]) {
      if (m[0x41c]) {
        m[0x41c]--;
        if (!m[0x41c]) m[0x23] = 0;
      }
      if (m[0x23]) {
        m[0x40e]--;
        if (!m[0x40e]) {
          m[0x40e] = m[0x41e];
          const gate = m[0x41a] & 1;
          m[0x41a] = (m[0x41a] >>> 1) | (gate << 7);
          this.word(0x412, this.word(0x412) + this.word(gate ? 0x416 : 0x418));
        }
        let next = this.word(0x412) + this.word(0x410);
        m[0x40d]--;
        if (!m[0x40d]) { m[0x40d] = m[0x41d]; next = this.word(0x414); }
        this.word(0x412, next);
        const gate = m[0x41b] & 1;
        m[0x41b] = (m[0x41b] >>> 1) | (gate << 7);
        if (!gate) divisor = next & 65535;
      }
    }
    this.word(0x2c, divisor);
    return divisor;
  }
}

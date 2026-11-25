function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function requireBytes(bytes, offset, length) {
  if (offset < 0 || offset + length > bytes.length) {
    throw new Error(`Truncated binary at 0x${offset.toString(16)}`);
  }
}

// XENON2.EXE, CS:019a-04f1: adaptive Huffman + a 4 KB LZ dictionary.
export function unpack(bytes) {
  requireBytes(bytes, 0, 15);
  const size = view(bytes).getUint32(11, true);
  if (size > 1_048_576) throw new Error("Invalid unpacked size");
  let bit = (bytes[0] + 2) * 8;
  const read = (count) => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      requireBytes(bytes, bit >>> 3, 1);
      value = (value << 1) | ((bytes[bit >>> 3] >>> (7 - (bit & 7))) & 1);
      bit++;
    }
    return value;
  };
  const n = 314;
  const treeSize = n * 2 - 1;
  const root = treeSize - 1;
  const freq = new Uint32Array(treeSize + 1);
  const parent = new Uint16Array(treeSize + n);
  const child = new Uint16Array(treeSize);
  for (let i = 0; i < n; i++) {
    freq[i] = 1;
    child[i] = i + treeSize;
    parent[i + treeSize] = i;
  }
  for (let i = 0, j = n; j <= root; i += 2, j++) {
    freq[j] = freq[i] + freq[i + 1];
    child[j] = i;
    parent[i] = parent[i + 1] = j;
  }
  freq[treeSize] = 0xffff;
  const reconstruct = () => {
    let j = 0;
    for (let i = 0; i < treeSize; i++) {
      if (child[i] >= treeSize) {
        freq[j] = (freq[i] + 1) >>> 1;
        child[j++] = child[i];
      }
    }
    for (let i = 0, j = n; j < treeSize; i += 2, j++) {
      const f = freq[i] + freq[i + 1];
      let k = j - 1;
      while (f < freq[k]) k--;
      k++;
      freq.copyWithin(k + 1, k, j);
      child.copyWithin(k + 1, k, j);
      freq[k] = f;
      child[k] = i;
    }
    for (let i = 0; i < treeSize; i++) {
      const c = child[i];
      parent[c] = i;
      if (c < treeSize) parent[c + 1] = i;
    }
  };
  const update = (symbol) => {
    if (freq[root] === 0x8000) reconstruct();
    let c = parent[symbol + treeSize];
    do {
      const f = ++freq[c];
      let l = c + 1;
      if (f > freq[l]) {
        while (f > freq[++l]) { /* Find the last lower-frequency node. */ }
        l--;
        freq[c] = freq[l];
        freq[l] = f;
        let i = child[c];
        parent[i] = l;
        if (i < treeSize) parent[i + 1] = l;
        const j = child[l];
        child[l] = i;
        parent[j] = c;
        if (j < treeSize) parent[j + 1] = c;
        child[c] = j;
        c = l;
      }
      c = parent[c];
    } while (c !== 0);
  };
  const dictionary = new Uint8Array(4096);
  let p = 0;
  for (let value = 0; value < 256; value++) {
    for (let i = 0; i < 13; i++) dictionary[p++] = value;
  }
  for (let i = 0; i < 256; i++) dictionary[p++] = i;
  for (let i = 255; i >= 0; i--) dictionary[p++] = i;
  p += 128;
  dictionary.fill(32, p);
  let ring = 0xfc4;
  let written = 0;
  const output = new Uint8Array(size);
  const emit = (value) => {
    if (written >= size) throw new Error("LZ match exceeds unpacked size");
    output[written++] = dictionary[ring] = value;
    ring = (ring + 1) & 4095;
  };
  while (written < size) {
    let c = child[root];
    while (c < treeSize) c = child[c + read(1)];
    c -= treeSize;
    update(c);
    if (c < 256) {
      emit(c);
    } else {
      const prefix = read(8);
      let high;
      let extra;
      if (prefix < 32) { high = 0; extra = 1; }
      else if (prefix < 80) { high = 1 + ((prefix - 32) >>> 4); extra = 2; }
      else if (prefix < 144) { high = 4 + ((prefix - 80) >>> 3); extra = 3; }
      else if (prefix < 192) { high = 12 + ((prefix - 144) >>> 2); extra = 4; }
      else if (prefix < 240) { high = 24 + ((prefix - 192) >>> 1); extra = 5; }
      else { high = 48 + prefix - 240; extra = 6; }
      const distance = (high << 6) | (((prefix << extra) | read(extra)) & 63);
      let source = (ring - distance - 1) & 4095;
      for (let i = 0; i < c - 253; i++) {
        emit(dictionary[source]);
        source = (source + 1) & 4095;
      }
    }
  }
  return output;
}

// CS:5d09: alternating literal-word runs and zero-word runs, 0x2ee0 bytes out.
export function decodeMap(bytes) {
  const output = new Uint16Array(6000);
  const data = view(bytes);
  let input = 0;
  let cursor = 0;
  while (cursor < output.length) {
    requireBytes(bytes, input, 1);
    const literals = bytes[input++];
    requireBytes(bytes, input, literals * 2 + 1);
    if (cursor + literals > output.length) throw new Error("Map literal overflow");
    for (let i = 0; i < literals; i++) {
      output[cursor++] = data.getUint16(input, true);
      input += 2;
    }
    const zeros = bytes[input++];
    if (!literals && !zeros) throw new Error("Empty map run");
    cursor += zeros;
    if (cursor > output.length) throw new Error("Map zero overflow");
  }
  return output;
}

export function decodePalette(exe, level = 0) {
  const offset = 0x800 + 0x18530 + 0x427d + level * 48;
  requireBytes(exe, offset, 48);
  return Array.from({ length: 16 }, (_, i) =>
    Array.from(exe.subarray(offset + i * 3, offset + i * 3 + 3),
      (channel) => Math.round(channel * 255 / 63)));
}

export function decodeRunScreenArt(exe, graphics) {
  const data = exe.subarray(0x800 + 0x18530);
  const words = view(data);
  const text = (offset, length) => String.fromCharCode(...data.subarray(offset, offset + length));
  const alphabet = text(0x33ca, 40);
  const font = (base, height) => ({
    height,
    glyphs: new Map([...alphabet].map((letter, i) => [letter,
      Uint8Array.from({ length: 16 * height }, (_, pixel) => {
        const x = pixel & 15, y = pixel >>> 4;
        const offset = base + (i * 4 * height + y) * 2 + (x >>> 3);
        const mask = 0x80 >>> (x & 7);
        let color = 0;
        for (let plane = 0; plane < 4; plane++) {
          if (graphics[offset + plane * height * 2] & mask) color |= 1 << plane;
        }
        return color;
      })])),
  });
  const logo = new Uint8Array(208 * 54);
  requireBytes(graphics, 0xaf80, 13 * 54 * 8);
  for (let i = 0; i < logo.length; i++) {
    const offset = 0xaf80 + (i >>> 4) * 8 + ((i & 15) >>> 3);
    const mask = 0x80 >>> (i & 7);
    for (let plane = 0; plane < 4; plane++) {
      if (graphics[offset + plane * 2] & mask) logo[i] |= 1 << plane;
    }
  }
  return {
    large: font(0x780, 22), small: font(0x2300, 14),
    frontPalette: decodePalette(exe),
    logo, staff: Array.from({ length: 6 }, (_, i) =>
      [text(0x3625 + i * 40, 20), text(0x3639 + i * 40, 20)]),
    select: text(0x3477, 20),
    selections: Array.from({ length: 4 }, (_, i) =>
      [text(0x348b + i * 40, 20), text(0x349f + i * 40, 20)]),
    prompt: text(0x344f, 20), counter: text(0x3463, 20),
    credits: text(0x33f3, 8), readyPlayer: text(0x3715, 20), gameOver: text(0x3729, 20),
    alphabet, scoreTitle: text(0x352b, 20), loading: text(0x353f, 20),
    scores: Array.from({ length: 10 }, (_, i) => ({
      score: words.getUint32(0x3567 + i * 4, true),
      label: text(0x358f + i * 15, 4), initials: text(0x359b + i * 15, 3),
    })),
    starColors: data.slice(0x373d, 0x3745),
  };
}

// 0f29:1afa/1d01 paints Colin in seven 16-pixel groups per scanline.
export function decodeShopArt(exe, graphics, sprites) {
  const width = 112;
  const height = 96;
  const pixels = new Uint8Array(width * height);
  const alpha = new Uint8Array(pixels.length);
  for (const [offset, top, rows] of [[0x8430, 0, 52], [0x91c0, 52, 34], [0x8f90, 86, 10]]) {
    requireBytes(graphics, offset, rows * 56);
    for (let y = 0; y < rows; y++) for (let x = 7; x < 104; x++) {
      const source = offset + y * 56 + (x >>> 4) * 8 + ((x & 15) >>> 3);
      const mask = 0x80 >>> (x & 7);
      const target = (top + y) * width + x;
      for (let plane = 0; plane < 4; plane++) {
        if (graphics[source + plane * 2] & mask) pixels[target] |= 1 << plane;
      }
      // The VGA painter masks the left edge and discards the last source byte.
      alpha[target] = 255;
    }
  }
  const data = view(exe.subarray(0x800 + 0x18530));
  const lookup = new Map(sprites.map((sprite) => [0xabbc + sprite.offset + 8, sprite]));
  const decorations = Array.from({ length: 7 }, (_, index) => {
    const entry = 0x3de4 + index * 6;
    const frames = [];
    for (let pointer = data.getUint16(entry + 4, true); ; pointer += 2) {
      const frame = data.getUint16(pointer, true);
      if (!frame) break;
      const sprite = lookup.get(frame);
      if (!sprite) throw new Error(`Missing shop sprite 0x${frame.toString(16)}`);
      frames.push(sprite);
    }
    return { x: data.getUint16(entry, true) - 208,
      y: data.getUint16(entry + 2, true), frames };
  });
  const planar = (offset, w, h, masked = false) => {
    requireBytes(graphics, offset, w * h / 2);
    const result = { width: w, height: h, pixels: new Uint8Array(w * h),
      alpha: new Uint8Array(w * h).fill(255) };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const source = offset + y * w / 2 + (x >>> 4) * 8 + ((x & 15) >>> 3);
      for (let plane = 0; plane < 4; plane++) {
        if (graphics[source + plane * 2] & (0x80 >>> (x & 7))) result.pixels[y * w + x] |= 1 << plane;
      }
      if (masked && (x < 7 || x >= 104)) result.alpha[y * w + x] = 0;
    }
    return result;
  };
  const glyph = (offset, w) => ({
    width: w, height: 8,
    pixels: Uint8Array.from({ length: w * 8 }, (_, i) => {
      let color = 0;
      for (let plane = 0; plane < 4; plane++) {
        if (graphics[offset + plane * 8 + Math.floor(i / w)] & (0x80 >>> (i % w))) color |= 1 << plane;
      }
      return color;
    }),
  });
  const bytes = exe.subarray(0x800 + 0x18530);
  const string = (address) => new TextDecoder("ascii").decode(bytes.subarray(address, bytes.indexOf(0, address)));
  const icons = Array.from({ length: 28 }, (_, id) => {
    if (id < 2) return [];
    const frames = [];
    for (let p = data.getUint16(0x3898 + id * 2, true); data.getUint16(p, true); p += 2) {
      frames.push(data.getUint16(p, true));
      if (frames.length > 256) throw new Error("Unterminated shop icon");
    }
    return frames;
  });
  return {
    width, height, pixels, alpha, palette: decodePalette(exe), decorations, icons,
    backdrop: [
      [0x3560, 0x180, 32, 191], [0x4150, 0x18e, 16, 191],
      [0x4748, 0x18, 128, 9], [0x4988, 0x1080, 128, 9],
      [0x4bc8, 0x1c8c, 80, 18], [0x4e98, 0x19a0, 192, 36],
    ].map(([offset, target, w, h]) => ({ ...planar(offset, w, h),
      x: target % 40 * 8, y: Math.floor(target / 40) })),
    font: Array.from({ length: 60 }, (_, i) => glyph(0x7cb0 + i * 32, 4)),
    digits: Array.from({ length: 10 }, (_, i) => glyph(0x500 + i * 32, 8)),
    mouths: Array.from({ length: 4 }, (_, i) => planar(0x91c0 + i * 0x770, 112, 34, true)),
    portraitDoor: [planar(0x5c18, 112, 40, true), planar(0x64d8, 112, 40, true)],
    dialogueDoor: planar(0x6d98, 112, 68, true),
    hatches: Array.from({ length: 9 }, (_, i) => data.getUint16(0x3ca0 + i * 2, true)),
    prompts: Object.fromEntries(Object.entries({ room: 0x3902, unavailable: 0x392b,
      cash: 0x3952, bought: 0x3967, sold: 0x3980, sell: 0x3da6, buy: 0x3dc4,
      sale: 0x3ab4, cost: 0x3ac2, power: 0x3ad4 }).map(([key, address]) => [key, string(address)])),
    ending: [0x3796, 0x37b1, 0x37d8].map((address) => string(address)),
    stageFiveGreeting: [0x3e82, 0x3ea6, 0x3eb9].map((address) => string(address)),
    labels: Array.from({ length: 26 }, (_, id) => string(data.getUint16(0x3866 + id * 2, true))),
  };
}

// Four 16-bit, big-endian bitplanes interleaved per tile scanline.
export function decodeTiles(bytes) {
  if (bytes.length % 128) throw new Error("Partial 16x16 tile");
  return Array.from({ length: bytes.length / 128 }, (_, tile) => {
    const pixels = new Uint8Array(256);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        for (let plane = 0; plane < 4; plane++) {
          const offset = tile * 128 + y * 8 + plane * 2 + (x >>> 3);
          pixels[y * 16 + x] |= ((bytes[offset] >>> (7 - (x & 7))) & 1) << plane;
        }
      }
    }
    return pixels;
  });
}

export function decodeSprites(bytes, start = 0, end = bytes.length) {
  const data = view(bytes);
  const sprites = [];
  let offset = start;
  while (offset < end) {
    requireBytes(bytes, offset, 16);
    const box = Array.from({ length: 4 }, (_, i) => data.getInt16(offset + i * 2, true));
    const originX = data.getInt16(offset + 8, true);
    const originY = data.getInt16(offset + 10, true);
    const width = data.getUint16(offset + 12, true);
    const height = data.getUint16(offset + 14, true) + 1;
    if (!width || width > 320 || height > 200) {
      throw new Error(`Invalid sprite at 0x${offset.toString(16)}: ${width}x${height}`);
    }
    const stride = Math.ceil(width / 8);
    const planeSize = stride * height;
    const next = (offset + 16 + planeSize * 5 + 1) & ~1;
    requireBytes(bytes, offset, next - offset);
    if (next > end) throw new Error("Sprite extends past bank");
    const pixels = new Uint8Array(width * height);
    const alpha = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = 7 - (x & 7);
        const index = y * stride + (x >>> 3);
        alpha[y * width + x] = ((bytes[offset + 16 + index] >>> bit) & 1) * 255;
        for (let plane = 0; plane < 4; plane++) {
          pixels[y * width + x] |= ((bytes[offset + 16 + planeSize * (plane + 1) + index] >>> bit) & 1) << plane;
        }
      }
    }
    sprites.push({ offset, box, originX, originY, width, height, pixels, alpha });
    offset = next;
  }
  return sprites;
}

export function decodeEvents(bytes) {
  const data = view(bytes);
  const events = [];
  for (let offset = 0; ; offset += 14) {
    requireBytes(bytes, offset, 2);
    if (data.getInt16(offset, true) < 0) return events;
    requireBytes(bytes, offset, 14);
    events.push(Array.from({ length: 7 }, (_, i) => data.getUint16(offset + i * 2, true)));
  }
}

export function decodePaths(bytes) {
  requireBytes(bytes, 0, 230);
  const data = view(bytes);
  return {
    bytes,
    offsets: Array.from({ length: 115 }, (_, i) => 230 + data.getUint16(i * 2, true)),
  };
}

const stageTemplates = [
  [0x6285, 0x6297, 0x62a9, 0x62bb, 0x62cd, 0x62df, 0x62f1, 0x6313, 0x6325, 0x6337],
  [0x7736, 0x7748, 0x775a, 0x776c, 0x777e, 0x7790],
  [0x959a, 0x95ac, 0x95be, 0x9630, 0x9642],
  [0xb028, 0xb05c, 0xb06e, 0xb04a, 0xb080, 0xb092],
  [0xcc9e, 0xccb0, 0xccc2, 0xccd4, 0xcce6, 0xccf8, 0xcd0a, 0xcd1c],
];

function animationFrames(code, offset) {
  const frames = [];
  for (let count = 0; count < 256; count++, offset += 4) {
    const pointer = code.getUint16(offset, true);
    if (!pointer) return frames;
    const duration = code.getUint16(offset + 2, true);
    frames.push({ bank: pointer & 1, offset: (pointer & ~1) - 8, duration });
    if (!duration) return frames;
  }
  throw new Error("Unterminated animation");
}

export function decodeStageLogic(exe, stage = 1) {
  if (!Number.isInteger(stage) || stage < 1 || stage > 5) throw new Error("Invalid stage");
  const code = view(exe.subarray(0x800));
  const word = (offset) => code.getUint16(offset, true);
  const templates = new Map();
  for (const [type, address] of [0x3377, ...stageTemplates[stage - 1]].entries()) {
    let offset = address;
    const parts = [];
    while (word(offset)) {
      parts.push({
        id: word(offset),
        score: word(offset + 2),
        update: word(offset + 4),
        hit: word(offset + 8),
        frames: animationFrames(code, word(offset + 10)),
        health: stage === 3 && type === 3 ? word(0x9598)
          : (word(offset + 14) & 255 ? [2, 2, 3, 8, 14] : [1, 1, 2, 6, 12])[stage - 1],
        flags: word(offset + 14),
      });
      offset += 16;
      if (parts.length > 16) throw new Error("Unterminated enemy template");
    }
    templates.set(type, parts);
  }
  const sine = Int8Array.from(exe.subarray(0x800 + 0x6116, 0x800 + 0x6216),
    (value) => value > 127 ? value - 256 : value);
  const frame = (pointer) => ({ bank: pointer & 1, offset: (pointer & ~1) - 8 });
  const data = view(exe.subarray(0x800 + 0x18530));
  const flameFrames = animationFrames(code, 0x1288);
  const explosions = [animationFrames(code, 0x1230), animationFrames(code, 0x124c)];
  return {
    templates, sine, explosions,
    maneuverJets: Array.from({ length: 4 }, (_, i) => ({
      frames: animationFrames(code, data.getUint16(0x3292 + i * 2, true)),
      offsets: Array.from({ length: 7 }, (_, bank) =>
        data.getInt16(0x3276 + (((3 - i) & 1) * 7 + bank) * 2, true)),
    })),
    foregroundShot: {
      frame: frame(word([0x7653, 0x8f8c, 0xace6, 0xc827, 0xe50f][stage - 1])),
      vectors: Array.from({ length: 8 }, (_, i) =>
        [code.getInt16(0x1f0d + i * 2, true) / 16384, code.getInt16(0x1f2d + i * 2, true) / 16384]),
    },
    entryFrames: stage === 3 ? Array.from({ length: 4 }, (_, i) =>
      animationFrames(code, word(0xad19 + i * 2))) : undefined,
    headingFrames: stage === 3 ? Object.fromEntries(
      [[0x99fb, 0xace9], [0x9a03, 0xacf9], [0x9a0b, 0xad09]].map(([script, offset]) =>
        [script, Array.from({ length: 8 }, (_, i) => frame(word(offset + i * 2)))])) : undefined,
    corridor: stage === 4 ? {
      firstCamera: word(0xb57a), lastCamera: word(0xb585), reverseLimit: word(0xb559),
      ships: Array.from({ length: 4 }, (_, i) => {
        const address = 0xc82a + i * 8, launcher = word(address + 4) === 0xb613;
        return { type: word(address), x: word(address + 2), frames: animationFrames(code, word(address + 6)),
          launcher, speed: word(launcher ? 0xafe2 : 0xafea), fireRate: code.getUint8(launcher ? 0xafe4 : 0xafec),
          health: word(0xafe0), score: 300, large: true, contactDamage: 16 };
      }),
      pods: Array.from({ length: 2 }, (_, side) => {
        const address = 0xc84a + side * 6;
        return { type: word(address), x: word(address + 2), frames: animationFrames(code, word(address + 4)),
          aimOperand: word(address + 4) + 4,
          path: 73 + side * 2, heading: side * 128, offsetX: side ? -10 : 10 };
      }),
      drone: {
        type: 0xf8, frames: Array.from({ length: 8 }, (_, i) => animationFrames(code, word(0xc856 + i * 2))),
        aimOperands: Array.from({ length: 8 }, (_, i) => word(0xc856 + i * 2) + 4),
        health: word(0xafe6), speed: word(0xafe8), score: 100, contactDamage: 8,
      },
      shotSpeed: word(0xafee), launcherShotSpeed: word(0xb024), launcherShotRate: code.getUint8(0xb004),
      shotFrames: [0x8269, 0x8235, word(0xcc50 + word(0xb026) * 2)].map(frame),
      vectors: Array.from({ length: 16 }, (_, i) =>
        [code.getInt16(0x1f0d + i * 2, true) / 16384, code.getInt16(0x1f2d + i * 2, true) / 16384]),
    } : undefined,
    playerDeath: animationFrames(code, 0x1264),
    playerBank: Array.from({ length: 13 }, (_, i) => frame(data.getUint16(0x304c + i * 2, true))),
    diveFrames: Array.from({ length: 5 }, (_, i) => frame(data.getUint16(0x3258 + i * 2, true))),
    invulnerabilityRing: animationFrames(code, 0x1148),
    terrainHull: Array.from({ length: 16 }, (_, i) => {
      const offset = data.getUint16(0x329a + i * 2, true);
      return Array.from({ length: 75 }, (_, j) => data.getUint16(offset + j * 2, false));
    }),
    boss: stage === 1 ? {
      health: word(0x6278), arm: frame(0x2e0f),
      motionCode: new Int8Array(code.buffer, code.byteOffset, 0x10000),
      tip: Array.from({ length: 8 }, (_, i) => frame(word(0x76ec + i * 2))),
      mouth: Array.from({ length: 4 }, (_, i) => frame(word(0x76fc + i * 2))),
      tiles: Array.from({ length: 42 }, (_, i) => word(0x7660 + i * 2)),
      tileAnimationPointers: Array.from({ length: 4 }, (_, i) => word(0x76e4 + i * 2)),
      tileAnimations: Array.from({ length: 4 }, (_, i) =>
        Array.from({ length: 8 }, (_, j) => word(word(0x76e4 + i * 2) + j * 2))),
      bullet: animationFrames(code, 0x6549),
      vectors: Array.from({ length: 16 }, (_, i) => [
        code.getInt16(0x1f0d + i * 2, true) / 16384,
        code.getInt16(0x1f2d + i * 2, true) / 16384,
      ]),
    } : stage === 2 ? {
      health: word(0x772c), fireRate: word(0x7732), bulletSpeed: word(0x7734),
      tiles: Array.from({ length: 54 }, (_, i) => word(0x92e7 + i * 2)),
      mouth: Array.from({ length: 4 }, (_, i) =>
        Array.from({ length: 4 }, (_, j) => word(word(0x94f3 + i * 2) + j * 2))),
      fins: [0x94fb, 0x94ff].map((address) => Array.from({ length: 2 }, (_, i) =>
        Array.from({ length: 4 }, (_, j) => word(word(address + i * 2) + j * 2)))),
      bullets: [animationFrames(code, 0x7a80), animationFrames(code, 0x7a92)],
      vectors: Array.from({ length: 16 }, (_, i) => [
        code.getInt16(0x1f0d + i * 2, true) / 16384,
        code.getInt16(0x1f2d + i * 2, true) / 16384,
      ]),
      egg: {
        idle: animationFrames(code, 0x78de), hatch: animationFrames(code, 0x78f4),
        vectors: Array.from({ length: 8 }, (_, i) => [
          data.getInt16(0x32de + i * 2, true), data.getInt16(0x32ee + i * 2, true),
        ]),
      },
      crawler: {
        health: word(0x7724), fireRate: word(0x7726), bulletSpeed: word(0x772a),
        bullet: frame(word(0x92a9 + word(0x7728) * 2)),
        frames: Array.from({ length: 8 }, (_, i) => animationFrames(code, word(0x950b + i * 2))),
        vectors: Array.from({ length: 8 }, (_, i) => [
          data.getInt16(0x32fe + i * 2, true), data.getInt16(0x330e + i * 2, true),
        ]),
        nodes: Array.from({ length: data.getUint16(0x331e, true) + 1 }, (_, i) =>
          Array.from({ length: 5 }, (_, j) => data.getInt16(0x3320 + i * 10 + j * 2, true))),
      },
      terrain: Array.from({ length: 4 }, (_, i) => {
        const address = 0x938b + word(0x9503 + i * 2);
        return Array.from({ length: word(address) }, (_, j) => ({
          x: word(address + 4 + j * 8), worldY: word(address + 6 + j * 8),
          tile: word(address + 8 + j * 8),
        }));
      }),
    } : stage === 3 ? {
      kind: "worm", health: word(0x9588), speed: word(0x9560),
      fireRate: word(0x958c), bulletSpeed: word(0x958e),
      bullet: animationFrames(code, 0x971e),
      parts: Array.from({ length: word(0xad21) + 1 }, (_, i) => ({
        spacing: word(0xad23 + i * 6), update: word(0xad25 + i * 6),
        frame: frame(word(0xad27 + i * 6)), contactDamage: 8,
      })),
      heads: Array.from({ length: 8 }, (_, i) => animationFrames(code, word(0xad65 + i * 2))),
      bodies: [0xad75, 0xad85, 0xad95].map((address) =>
        Array.from({ length: 8 }, (_, i) => frame(word(address + i * 2)))),
      overlays: Array.from({ length: 5 }, (_, i) => {
        const address = 0xaf83 + i * 10;
        const width = word(address + 2) + 1, height = word(address + 4) + 1;
        return { width, height, worldY: word(address + 6), x: word(address + 8),
          tiles: Array.from({ length: width * height }, (_, j) => word(word(address) + j * 2)) };
      }),
      vectors: Array.from({ length: 16 }, (_, i) => [
        code.getInt16(0x1f0d + i * 2, true) / 16384,
        code.getInt16(0x1f2d + i * 2, true) / 16384,
      ]),
    } : stage === 4 ? {
      eventType: 4, beamRate: word(0xaff0), turretRate: word(0xaff2), turretSpeed: word(0xaff4),
      motionCode: new Int8Array(code.buffer, code.byteOffset, 0x10000),
      parts: Array.from({ length: 19 }, (_, i) => {
        const address = 0xc96a + i * 12;
        const healthAddress = [0xb00e, 0xb00c, 0xb00c][i];
        return { x: word(address + 6), y: word(address + 8),
          health: healthAddress ? word(healthAddress) : word(address + 10) };
      }),
      bob: Array.from({ length: 16 }, (_, i) => data.getInt16(0x40e2 + i * 2, true)),
      body: [0xc866, 0xc8a2].map((address, i) =>
        Array.from({ length: (5 + i) * 6 }, (_, j) => word(address + j * 2))),
      turretTiles: [0xc8ea, 0xc8fc].map((base) => Array.from({ length: 9 }, (_, i) =>
        Array.from({ length: 4 }, (_, j) => word(word(base + i * 2) + j * 2)))),
      aim: [0x4122, 0x412a].map((base) => Array.from({ length: 8 }, (_, i) => data.getUint8(base + i))),
      muzzles: Array.from({ length: 8 }, (_, i) =>
        [data.getInt16(0x4102 + i * 2, true), data.getInt16(0x4112 + i * 2, true)]),
      beamFrames: [0x7d19, 0x7c69].map(frame),
      bullets: Array.from({ length: 8 }, (_, i) => {
        const address = word(0xca4e + i * 2);
        return address ? animationFrames(code, address) : [];
      }),
      vectors: Array.from({ length: 8 }, (_, i) =>
        [code.getInt16(0x1f0d + i * 2, true) / 16384, code.getInt16(0x1f2d + i * 2, true) / 16384]),
    } : stage === 5 ? {
      eventType: 6, camera: word(0xd52e), y: code.getInt16(0xd589, true),
      health: code.getUint8(0xcc8e), hatchRate: code.getUint8(0xcc6e),
      beamRate: code.getUint8(0xcc72), beamSpeed: word(0xcc7a),
      gunRate: code.getUint8(0xcc74), gunSpeed: word(0xcc76),
      gunBullet: frame(word(0xebbc + word(0xcc8c) * 2)), deadGun: frame(0x6715),
      parts: Array.from({ length: 21 }, (_, i) => {
        const a = 0xe77a + i * 16;
        const animation = word(a + 8), pointer = word(animation);
        const kind = { 0xd5f9: "wall", 0xdad2: "gun", 0xd82a: "beam", 0xd615: "guard", 0xd61e: "core" }[word(a + 2)];
        return { kind, x: word(a + 10), y: word(a + 12),
          health: code.getUint8(a + 14), contactDamage: code.getUint8(a + 15) ? 16 : 8,
          wallHeight: code.getUint8(a + 15), frame: pointer ? frame(pointer) : undefined,
          frames: animationFrames(code, kind === "beam" ? animation + 4 : animation) };
      }),
      arena: Array.from({ length: 15 * 18 }, (_, i) => word(0xe512 + i * 2)),
      hatchFrames: Array.from({ length: 15 }, (_, i) => frame(word(0xe8d4 + i * 2))),
      hatchFlashes: Array.from({ length: 5 }, (_, i) => frame(word(0xe8ca + i * 2))),
      coreFrames: Array.from({ length: 12 }, (_, i) => frame(word(0xe902 + i * 2))),
      gunFrames: Array.from({ length: 8 }, (_, i) => frame(word(0xe9d6 + i * 2))),
      vectors: Array.from({ length: 8 }, (_, i) =>
        [code.getInt16(0x1f0d + i * 2, true) / 16384, code.getInt16(0x1f2d + i * 2, true) / 16384]),
      seeker: {
        kind: "arena-seeker", health: word(0xcc70), score: 150, contactDamage: 4,
        frames: Array.from({ length: 8 }, (_, i) => animationFrames(code, word(0xe8f2 + i * 2))),
        vectors: Array.from({ length: 8 }, (_, i) => [0x3370, 0x3380].map((address) =>
          data.getInt16(address + i * 2, true))),
      },
    } : undefined,
    miniboss: stage === 2 ? {
      health: word(0x772e), waveHealth: word(0x7720), waveSpeed: word(0x7722),
      floor: word(0x8e05),
      eyes: Array.from({ length: 3 }, (_, i) => ({
        x: data.getUint16(0x33b0 + i * 4, true) * 16,
        worldY: data.getUint16(0x33b2 + i * 4, true) * 16,
        flash: Array.from({ length: i ? 6 : 9 }, (_, j) =>
          word([0x92cb, 0x92b3, 0x92bf][i] + j * 2)),
      })),
      eyeTiles: Array.from({ length: 5 }, (_, i) => word(0x92dd + i * 2)),
      entries: Array.from({ length: 16 }, (_, i) =>
        Array.from({ length: 5 }, (_, j) => word(0x9179 + i * 10 + j * 2))),
      parts: Array.from({ length: word(0x9117) + 1 }, (_, i) => ({
        id: word(0x9119 + i * 8), frame: frame(word(0x911d + i * 8)),
      })),
      directions: [0x952b, 0x953b, 0x954b].map((address) =>
        Array.from({ length: 8 }, (_, i) => frame(word(address + i * 2)))),
      corpses: [0x786c, 0x7892, 0x78b8].map((address) => animationFrames(code, address)),
      lights: Array.from({ length: 8 }, (_, i) => ({
        cell: word(0x9219 + i * 18) / 2,
        tiles: [0, 1].map((variant) => Array.from({ length: 4 }, (_, j) =>
          word(0x921b + i * 18 + variant * 8 + j * 2))),
      })),
    } : stage === 3 ? {
      kind: "composite", eventType: 3, floor: word(0xac52), path: 84,
      speed: word(0x9564), eyeHealth: word(0x958a),
      fireRate: word(0x9592), bulletSpeed: word(0x9594),
      eyeRate: word(0x9596), bullet: animationFrames(code, 0x989c),
      eyeOpen: animationFrames(code, 0x9870),
      deadEyes: [frame(0x7d29), frame(0x7dbb)],
      parts: Array.from({ length: 17 }, (_, i) => {
        const address = 0xadc3 + i * 10;
        return {
          update: word(address), damage: word(address + 2), contactDamage: 16,
          frames: animationFrames(code, word(address + 4)),
          x: code.getInt16(address + 6, true), y: code.getInt16(address + 8, true),
        };
      }),
      tips: Array.from({ length: 16 }, (_, i) => frame(word(0xae6f + i * 2))),
      vectors: Array.from({ length: 16 }, (_, i) => [
        code.getInt16(0x1f0d + i * 2, true) / 16384,
        code.getInt16(0x1f2d + i * 2, true) / 16384,
      ]),
    } : stage === 4 ? {
      eventType: 2, floor: word(0xc7a3), reverseLimit: word(0xc13f), resumeCamera: word(0xbdc0),
      motionCode: new Int8Array(code.buffer, code.byteOffset, 0x10000),
      extendChance: word(0xaff6), gunRate: word(0xb010), gunSpeed: word(0xb012),
      ringRate: word(0xb01c), ringSpeed: word(0xb01e), turretRate: word(0xaff8), turretSpeed: word(0xaffa),
      parts: Array.from({ length: 20 }, (_, i) => {
        const a = 0xca5e + i * 14;
        return { frames: animationFrames(code, word(a + 4)), x: word(a + 6), y: word(a + 8),
          heading: word(a + 10), health: code.getUint8(a + 12), contactDamage: code.getUint8(a + 13) ? 16 : 8 };
      }),
      segmentFrames: Array.from({ length: 4 }, (_, i) => frame(word(0xcb76 + i * 2))),
      coreFrames: Array.from({ length: 8 }, (_, i) => frame(word(0xcb7e + i * 2))),
      gunFramePointers: Array.from({ length: 8 }, (_, i) => word(0xcb8e + i * 2) + 4),
      turretFramePointers: Array.from({ length: 8 }, (_, i) => word(0xcb9e + i * 2) + 4),
      gunFrames: Array.from({ length: 8 }, (_, i) => animationFrames(code, word(0xcb8e + i * 2))),
      turretFrames: Array.from({ length: 8 }, (_, i) => animationFrames(code, word(0xcb9e + i * 2))),
      bullet: animationFrames(code, 0xb432), turretBullet: [frame(0x81c5)],
      muzzles: Array.from({ length: 8 }, (_, i) =>
        [data.getInt16(0x4132 + i * 2, true), data.getInt16(0x4142 + i * 2, true)]),
      vectors: Array.from({ length: 8 }, (_, i) =>
        [code.getInt16(0x1f0d + i * 2, true) / 16384, code.getInt16(0x1f2d + i * 2, true) / 16384]),
    } : stage === 5 ? {
      eventType: 5, reverseLimit: word(0xdb86),
      minY: word(0xdbe3), maxY: word(0xdbc7), moveChance: code.getUint8(0xdbbe),
      beamRate: code.getUint8(0xcc78), beamSpeed: word(0xcc7a),
      homingRate: code.getUint8(0xcc9c), gunRate: code.getUint8(0xcc74), gunSpeed: word(0xcc76),
      gunBullet: frame(word(0xebbc + word(0xcc8c) * 2)), deadGun: frame(0x6715),
      parts: Array.from({ length: 9 }, (_, i) => {
        const a = 0xe92a + i * 16;
        return { frame: frame(word(a + 8)), x: word(a + 10), y: word(a + 12),
          health: i === 4 ? word(0xcc94) : word(a + 14), contactDamage: 8 };
      }),
      coreFrames: Array.from({ length: 6 }, (_, i) => frame(word(0xe9ba + i * 2))),
      panels: [0xe9ce, 0xe9c6].map((address) =>
        Array.from({ length: 4 }, (_, i) => frame(word(address + i * 2)))),
      gunFrames: Array.from({ length: 8 }, (_, i) => frame(word(0xe9d6 + i * 2))),
      tiles: Array.from({ length: 36 }, (_, i) => word(0xea52 + i * 2)),
      beamTiles: Array.from({ length: 9 }, (_, phase) =>
        Array.from({ length: 6 }, (_, i) => word(0xe9e6 + phase * 12 + i * 2))),
      vectors: Array.from({ length: 8 }, (_, i) =>
        [code.getInt16(0x1f0d + i * 2, true) / 16384, code.getInt16(0x1f2d + i * 2, true) / 16384]),
    } : undefined,
    credits: {
      vectors: Array.from({ length: 8 }, (_, i) =>
        [data.getInt16(0x31b8 + i * 4, true), data.getInt16(0x31ba + i * 4, true)]),
      frames: [animationFrames(code, 0x11f2), animationFrames(code, 0x11b4)],
    },
    rearAttachment: [...animationFrames(code, 0x12f8), ...animationFrames(code, 0x12fc)],
    auxiliaryMounts: Array.from({ length: 4 }, (_, i) => {
      const offset = 0x30a8 + (3 - i) * 4;
      return [data.getInt16(offset, true), data.getInt16(offset + 2, true)];
    }),
    cannon: {
      frames: [animationFrames(code, 0x12da)[0], ...animationFrames(code, 0x12ca)],
      overlay: animationFrames(code, 0x1366),
      shot: animationFrames(code, 0x132c),
      damage: word(0x3da4),
    },
    mountFrames: {
      9: animationFrames(code, 0x1342),
      11: animationFrames(code, 0x140c),
      13: animationFrames(code, 0x1354),
      14: [{ ...frame(0xa658), duration: 0 }],
      17: [animationFrames(code, 0x1566)[0], ...animationFrames(code, 0x156a)],
      18: animationFrames(code, 0x118e),
      19: animationFrames(code, 0x115a),
      20: animationFrames(code, 0x110c),
    },
    bomb: { frames: animationFrames(code, 0x1170), blast: explosions[1],
      damage: word(0x3db0) },
    mine: { blast: explosions, damage: word(0x3db2) },
    flamer: { frames: flameFrames, ttl: flameFrames.reduce((sum, frame) => sum + frame.duration, 0),
      damage: word(0x3dac) },
    electroBallDamage: word(0x3da2),
    missileShot: { frames: animationFrames(code, 0x1380), damage: word(0x3daa) },
    homingMissile: {
      launch: Array.from({ length: 8 }, (_, i) =>
        animationFrames(code, data.getUint16(0x324a + i * 2, true))[0]),
      flight: Array.from({ length: 8 }, (_, i) =>
        animationFrames(code, data.getUint16(0x30bc + i * 2, true))),
      vectors: Array.from({ length: 8 }, (_, i) =>
        [data.getInt16(0x30dc + i * 2, true), data.getInt16(0x30cc + i * 2, true)]),
      blast: explosions[0],
      damage: word(0x3da0),
    },
    enemyBeamCaps: [0x32ca, 0x32c4].map((offset) => frame(data.getUint16(offset, true))),
    laserCaps: Array.from({ length: 3 }, (_, power) =>
      [0x32c8, 0x32c2].map((offset) => frame(data.getUint16(offset + power * 2, true)))),
    droneVolleys: Array.from({ length: 3 }, (_, power) => {
      const pointer = data.getUint16(0x30ec + power * 2, true);
      return Array.from({ length: data.getUint16(pointer, true) }, (_, i) =>
        Array.from({ length: 4 }, (_, j) => data.getInt16(pointer + 2 + i * 8 + j * 2, true)));
    }),
    nashwan: {
      meter: Array.from({ length: 10 }, (_, i) =>
        ({ bank: 0, offset: data.getUint16(0x3262 + i * 2, true) - 8 })),
    },
    terrainWorms: stage === 1 ? {
      firstCamera: word(0x6594), lastCamera: word(0x659c),
      rotations: Array.from({ length: 5 }, (_, i) => word(0x761d + i * 6)),
      openings: Array.from({ length: 16 }, (_, i) => {
        const opening = 0x6767 + i * 10, tiles = 0x65f6 + word(opening + 4) * 10;
        return {
          x: word(opening), y: word(opening + 2), cell: word(tiles) >> 1,
          retireIndex: word(opening + 6),
          path: (0xdede - 0xde30) / 2 + 1 + word(opening + 8),
          tiles: Array.from({ length: 4 }, (_, j) => word(tiles + 2 + j * 2)),
        };
      }),
      parts: Array.from({ length: word(0x670d) }, (_, i) => ({
        frame: frame(word(0x6713 + i * 8)), score: word(0x6715 + i * 8),
        delay: i * code.getUint8(0x6977),
      })),
      frames: [0x6a8d, 0x6a9d].map((address) =>
        Array.from({ length: 8 }, (_, i) => frame(word(address + i * 2)))),
      corpses: [animationFrames(code, 0x6523), animationFrames(code, 0x650d)],
      speed: word(0x6282), openTicks: word(0x6874),
    } : undefined,
    shopCheckpoint: stage === 1 ? { worldY: word(0x656a), camera: word(0x657c) } : undefined,
    shopCredits: {
      mid: word([0x7599, 0x8e17, 0xac64, 0xc7b5, 0xe4c5][stage - 1]),
      end: word([0x7593, 0x8e11, 0xac5e, 0xc7af, 0xe4bf][stage - 1]) + word(0x3fe4),
    },
  };
}

export const decodeStageOneLogic = (exe) => decodeStageLogic(exe, 1);

export function decodeGroundLogic(exe, stage) {
  const code = view(exe.subarray(0x800));
  const word = (offset) => code.getUint16(offset, true);
  const frame = (pointer) => ({ bank: pointer & 1, offset: (pointer & ~1) - 8 });
  const tiles = (address, count) => Array.from({ length: count }, (_, i) => word(address + i * 2));
  const vectors = Array.from({ length: 16 }, (_, i) => [
    code.getInt16(0x1f0d + i * 2, true) / 16384,
    code.getInt16(0x1f2d + i * 2, true) / 16384,
  ]);
  const definitions = new Map();
  if (stage === 3) {
    const data = view(exe.subarray(0x800 + 0x18530));
    definitions.set(1, {
      kind: "arm", health: word(0x9566), score: 400,
      body: [frame(0x4045), frame(0x3f95)],
      tips: [0x98b2, 0x98cc].map((address) => Array.from({ length: 5 }, (_, i) => ({
        ...frame(word(address + i * 4)), duration: word(address + i * 4 + 2),
      }))),
    });
    definitions.set(2, {
      kind: "skater", health: word(0x9568), score: 300, large: true, contactDamage: 16,
      frames: [0x98e6, 0x9918].map((address) => animationFrames(code, address)),
      attacking: [0x98fc, 0x992e].map((address) => animationFrames(code, address)),
      bulletFrames: [frame(0x40f5), frame(0x4129)],
      bulletSpeed: word(0x9572), vectors,
    });
    definitions.set(5, {
      kind: "terrain-turret", health: [word(0x956a), word(0x957e)],
      score: 500, idleChance: code.getUint8(0x9574), repeatChance: code.getUint8(0x9576),
      fireRate: word(0x9578), coreFireRate: word(0x9580),
      bulletFrame: frame(word(0xafc7 + word(0x957a) * 2)),
      bulletSpeed: word(0x957c), coreBulletSpeed: word(0x9582), vectors,
      initial: tiles(0xae8f, 24),
      frames: Array.from({ length: 9 }, (_, i) => tiles(0xaebf + i * 8, 4)),
      coreFrames: Array.from({ length: 5 }, (_, i) => tiles(0xaf2f + i * 8, 4)),
      coreBullets: Array.from({ length: 8 }, (_, i) => animationFrames(code, word(0xaf1f + i * 2))),
      flash: tiles(0xaf07, 12),
    });
    definitions.set(6, {
      kind: "wall-crawler", health: word(0x9562), score: 100,
      fireRate: word(0x956c), bulletSpeed: word(0x9570),
      bulletFrame: frame(word(0xafc7 + word(0x956e) * 2)), vectors,
      frames: Array.from({ length: 8 }, (_, i) => animationFrames(code, word(0xadb3 + i * 2))),
      routes: Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) =>
        data.getInt16(0x4062 + j * 16 + i * 2, true))),
    });
  }
  if (stage === 1 || stage === 2) {
    const first = stage === 1;
    definitions.set(first ? 4 : 3, {
      kind: "patrol", health: word(first ? 0x6280 : 0x771e),
      score: first ? 250 : 200, chance: first ? 50 : 30, large: first,
      travelField: first ? 3 : 2, xShift: first ? [0, 16] : [0, 0],
      frames: (first ? [0x64c1, 0x64e7] : [0x7a2c, 0x7a56])
        .map((address) => animationFrames(code, address)),
      firing: (first ? [0x64d7, 0x64fd] : [0x7a4a, 0x7a74])
        .map((address) => animationFrames(code, address)),
      muzzle: first ? [[0, 7], [0, 7]] : [[3, 7], [11, 7]],
      directions: first ? [[3, 2, 1], [7, 6, 5]] : [[2], [6]],
      bulletFrame: frame(first ? word(0x7656 + word(0x6274) * 2) : 0x52ed),
      bulletSpeed: word(first ? 0x6276 : 0x771a), vectors,
    });
  }
  if (stage === 2) {
    definitions.set(1, {
      kind: "random-gun", health: word(0x771c), score: 100, explosion: 8,
      chance: code.getUint8(0x7714), box: [-8, 4, 21, 9],
      frames: [0x90df, 0x90c1].map((base) =>
        Array.from({ length: 15 }, (_, i) => tiles(base + i * 2, 1))),
      initial: [tiles(0x90df, 1), tiles(0x90c1, 1)],
      death: [tiles(0x90bf, 1), tiles(0x90bd, 1)],
      bulletFrame: frame(word(0x92a9 + word(0x7716) * 2)),
      bulletSpeed: word(0x7718), muzzle: [[8, 8], [8, 8]],
    });
    const data = view(exe.subarray(0x800 + 0x18530));
    const swarm = {
      kind: "swarm", health: 1, score: 0, contactDamage: 4,
      vectors: Array.from({ length: 8 }, (_, i) =>
        [data.getInt16(0x3390 + i * 2, true), data.getInt16(0x33a0 + i * 2, true)]),
      directions: Array.from({ length: 8 }, (_, i) => animationFrames(code, word(0x951b + i * 2))),
      spawns: Array.from({ length: 8 }, (_, i) => ({
        frames: animationFrames(code, word(0x8fe9 + i * 6)),
        x: code.getInt16(0x8feb + i * 6, true), y: code.getInt16(0x8fed + i * 6, true),
        direction: 7 - i,
      })),
    };
    definitions.set(2, {
      kind: "hatch", creature: swarm, threshold: word(0x7730),
      initial: [tiles(0x9095, 4), tiles(0x906d, 4)],
      frames: [0x9043, 0x9019].map((address) =>
        Array.from({ length: 21 }, (_, i) => tiles(word(address + i * 2), 4))),
    });
    for (const [type, large] of [[4, false], [5, true]]) {
      definitions.set(type, {
        kind: "hatch", initial: large ? undefined : [[word(0x8fd7)]],
        frames: [Array.from({ length: 9 }, (_, i) =>
          tiles((large ? 0x8f8f : 0x8fd7) + i * (large ? 8 : 2), large ? 4 : 1))],
        creature: {
          kind: "hatchling", large, health: word(large ? 0x7710 : 0x7712),
          score: large ? 300 : 150, contactDamage: large ? 16 : 8,
          frames: animationFrames(code, large ? 0x783e : 0x785c),
          attacking: animationFrames(code, large ? 0x784c : 0x7860),
          wobble: Array.from({ length: 8 }, (_, i) => data.getInt16(0x32ce + i * 2, true)),
        },
      });
    }
  }
  if (stage === 4) {
    const data = view(exe.subarray(0x800 + 0x18530));
    definitions.set(3, {
      kind: "wall-hunter", health: word(0xaffe), chance: word(0xb000), speed: word(0xb002),
      score: 200, contactDamage: 16, fireCounterHighByte: word(0xb01a) >>> 8,
      frames: [0xb53c, 0xb524].map((address) => [
        { ...frame(word(address)), duration: 0 }, ...animationFrames(code, address + 4),
      ]),
      hatch: [tiles(0xcbc6, 3), tiles(0xcbcc, 3)],
      rewardHatches: Array.from({ length: 19 }, (_, id) =>
        [data.getInt16(0x4194 + id * 2, true) * 2, data.getInt16(0x41aa + id * 2, true)]),
    });
    definitions.set(5, {
      kind: "wall-ram", fireRate: word(0xaffc), contactDamage: 6,
      frames: [0xb4f8, 0xb50e].map((address) => animationFrames(code, address)),
      tiles: Array.from({ length: 6 }, (_, i) => tiles(0xcbba - (i + 1) * 2, (i + 1) * 2)),
    });
  }
  if (stage === 5) {
    definitions.set(1, {
      kind: "barrier", health: word(0xcc7c),
      initial: [0x4e81, 0, 0, 0x4ec1], death: [0x3781, 0, 0, 0x3741],
      frames: [0xeac2, 0xeab2, 0xeaca].map((base, part) => {
        const width = part === 1 ? 2 : 1;
        return Array.from({ length: 4 }, (_, i) => tiles(base + i * width * 2, width));
      }),
      flash: [tiles(0xead2, 1), null, tiles(0xead4, 1)],
    });
    const swivel = {
      kind: "swivel-turret", health: word(0xcc80), score: 400,
      fireRate: code.getUint8(0xcc82), bulletSpeed: word(0xcc84), vectors,
      frames: Array.from({ length: 8 }, (_, i) => tiles(0xeb16 + i * 8, 4)),
      muzzle: Array.from({ length: 8 }, (_, i) => [0, 2].map((offset) =>
        code.getInt16(0xeb56 + i * 4 + offset, true))),
      projectiles: tiles(0xeb76, 8).map(frame),
      neighbors: [[-1, 0x2ec1, 0x0641, 0x0b41, 0x3341], [2, 0x2f01, 0x1241, 0x1741, 0x3381]],
    };
    definitions.set(3, swivel);
    definitions.set(9, swivel);
    definitions.set(4, {
      kind: "ring-turret", health: word(0xcc7e), score: 500,
      fireRate: code.getUint8(0xcc90), bulletSpeed: word(0xcc92), vectors,
      frames: Array.from({ length: 8 }, (_, i) => tiles(0xead6 + i * 8, 4)),
      projectiles: animationFrames(code, 0xd0a8),
      neighbors: [[-1, 0x2e41, 0x05c0, 0x0ac0, 0x32c1], [2, 0x2e81, 0x05c0, 0x0ac0, 0x3301]],
    });
    const data = view(exe.subarray(0x800 + 0x18530));
    definitions.set(7, {
      kind: "ring-wave", health: word(0xcc60), score: 200, contactDamage: 8,
      delay: word(0xcc62), speed: word(0xcc64), firstPath: (0xdf0c - 0xde30) / 2 + 1,
      initial: frame(0x4969), frames: tiles(0xe742, 8).map((address) =>
        ({ ...frame(word(address)), duration: word(address + 2) })),
      fireRate: code.getUint8(0xcc96), bulletSpeed: word(0xcc98),
      bulletFrame: frame(word(0xebbc + word(0xcc9a) * 2)), vectors,
    });
    definitions.set(8, {
      kind: "wall-patrol", health: word(0xcc66), score: 250, large: true, contactDamage: 16,
      fireRate: code.getUint8(0xcc68),
      frames: [[0xcf0e, 0xcf3a], [0xcf24, 0xcf50]].map((pair) =>
        pair.map((address) => animationFrames(code, address))),
      homing: {
        kind: "patrol-homing", health: word(0xcc6a), score: 100, contactDamage: 8,
        lifetime: word(0xcc6c),
        frames: tiles(0xe75a, 8).map((address) => animationFrames(code, address)),
        vectors: Array.from({ length: 8 }, (_, i) => [0x3370, 0x3380].map((address) =>
          data.getInt16(address + i * 2, true))),
      },
    });
  }
  const burst = {
    3: { type: 4, health: 0x957c, fire: 0x9584, speed: 0x9586,
      anim: [0xaf57, 0xaf65], death: [0xaf73, 0xaf75],
      cycle: 14, firePhase: 8, repeat: 2, width: 1, box: [2, 2, 13, 13],
      muzzle: [[8, 0], [8, 10]], directions: [0, 4], bullet: 0x73b7 },
    4: { type: 1, health: 0xb004, fire: 0xb006, speed: 0xb00a,
      anim: [0xcc02, 0xcbd2], death: [0xcc3a, 0xcc32], delayedBounds: true,
      cycle: 6, firePhase: 4, repeat: 1, width: 4, box: [2, 2, 29, 29],
      muzzle: [[18, 14], [10, 14]], directions: [2, 6],
      bullet: word(0xcc50 + word(0xb008) * 2), score: 400 },
    5: { type: 2, health: 0xcc86, fire: 0xcc88, speed: 0xcc8a,
      anim: [0xeb96, 0xeb86], death: [0xeba6, 0xeba8],
      cycle: 7, firePhase: 3, repeat: 1, width: 1, box: [2, 2, 13, 13],
      muzzle: [[24, 8], [0, 8]], directions: [2, 6],
      bullet: word(0xd0be), bulletAnimations: [0xd0be, 0xd0cc], advanceFirst: true },
  }[stage];
  if (burst) {
    definitions.set(burst.type, {
      ...burst, kind: "burst-gun", health: word(burst.health), fireRate: word(burst.fire),
      bulletSpeed: word(burst.speed), bulletFrame: frame(burst.bullet), vectors,
      frames: burst.anim.map((base) => Array.from({ length: burst.cycle + (burst.advanceFirst ? 1 : 0) }, (_, i) =>
        tiles(base + Math.floor(i / burst.repeat) * burst.width * 2, burst.width))),
      initial: burst.anim.map((base) => tiles(base, burst.width)),
      death: burst.death.map((base) => tiles(base, burst.width)),
      bulletAnimations: burst.bulletAnimations?.map((address) => animationFrames(code, address)),
      explosion: burst.width === 1 ? 8 : 16,
    });
  }
  if (stage !== 1) return definitions;
  const entries = [
    { type: 1, health: 0x627c, fire: 0x626e, anim: [0x6ddc, 0x6dfc],
      death: [0x6e24, 0x6e1c], initial: [0x6ddc, 0x6dfc], frameTicks: 4, cycle: 16,
      box: [10, 4, 18, 24], muzzle: [[32, 14], [0, 14]] },
    { type: 2, health: 0x627a, fire: 0x6262, anim: [0x6b9a, 0x6b7a],
      death: [0x6bc2, 0x6bba], initial: [0x6b9a, 0x6b7a], frameTicks: 1, cycle: 4,
      box: [4, 4, 24, 24], muzzle: [[16, 14], [0, 14]], xShift: [-16, 0] },
    { type: 3, health: 0x627e, fire: 0x6268, anim: [0x6c82, 0x6cd2],
      death: [0x6dd4, 0x6dd4], initial: [0x704b, 0x7053], frameTicks: 2, cycle: 40,
      box: [8, 8, 16, 16], muzzle: [[26, 2], [0, 2]] },
  ];
  for (const entry of entries) {
    const width = entry.type === 3 ? 2 : 4;
    definitions.set(entry.type, {
      ...entry, health: word(entry.health), fireRate: word(entry.fire),
      bulletSpeed: word(entry.fire + 4),
      bulletFrame: frame(word(0x7656 + word(entry.fire + 2) * 2)),
      frames: entry.anim.map((base) => Array.from({ length: entry.cycle / entry.frameTicks },
        (_, i) => tiles(base + i * width * 2, width))),
      initial: entry.initial.map((address) => tiles(address, entry.type === 1 ? 2 : 4)),
      death: entry.death.map((address) => tiles(address, 4)),
    });
  }
  return definitions;
}

export function decodePlayerShots(exe) {
  const code = view(exe.subarray(0x800));
  const bytes = exe.subarray(0x800 + 0x18530);
  const data = view(bytes);
  const mask = (pointer) => {
    const originX = data.getInt16(pointer, true);
    const originY = data.getInt16(pointer + 2, true);
    const height = data.getUint16(pointer + 4, true);
    const address = data.getUint16(pointer + 6, true);
    const pixels = new Uint8Array(16 * height).fill(7);
    const alpha = new Uint8Array(16 * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < 16; x++) {
        alpha[y * 16 + x] = ((bytes[address + y * 2 + (x >>> 3)] >>> (7 - (x & 7))) & 1) * 255;
      }
    }
    return { pointer, originX, originY, width: 16, height, pixels, alpha };
  };
  return Object.fromEntries(Object.entries({ left: 0x12b2, forward: 0x12b8,
    right: 0x12be, rear: 0x12c4 }).map(([name, table]) =>
    [name, Array.from({ length: 3 }, (_, power) => mask(code.getUint16(table + power * 2, true)))]));
}

export const decodeRearShots = (exe) => decodePlayerShots(exe).rear;

export function decodeRewards(exe) {
  const code = view(exe.subarray(0x800));
  const data = view(exe.subarray(0x800 + 0x18530));
  return Array.from({ length: 19 }, (_, id) => ({
    id, actor: data.getUint16(0x31fe + id * 4, true),
    handler: data.getUint16(0x31d8 + id * 2, true) & ~1,
    frames: animationFrames(code, data.getUint16(0x3200 + id * 4, true)),
  }));
}

export function decodeShop(exe) {
  const bytes = exe.subarray(0x800 + 0x18530);
  const data = view(bytes);
  return Array.from({ length: 25 }, (_, index) => {
    const id = index + 1;
    const pointer = data.getUint16(0x3866 + id * 2, true);
    let end = pointer;
    while (end < bytes.length && bytes[end]) end++;
    if (end === bytes.length) throw new Error("Unterminated shop label");
    const name = new TextDecoder("ascii").decode(bytes.subarray(pointer, end)).replace(/\r/g, " ");
    return {
      id, name, price: data.getUint16(0x38ce + id * 2, true),
      mounts: bytes[0x384d + id],
    };
  });
}

export function decodeAdvice(exe) {
  const bytes = exe.subarray(0x800 + 0x18530);
  const data = view(bytes);
  return Array.from({ length: 5 }, (_, stage) => Array.from({ length: 6 }, (_, line) => {
    const start = data.getUint16(0x3ed6 + stage * 12 + line * 2, true);
    let end = start;
    while (end < bytes.length && bytes[end]) end++;
    return new TextDecoder("ascii").decode(bytes.subarray(start, end));
  }));
}

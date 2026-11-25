export function scoreRank(scores, score) {
  const high = (value) => value >> 16;
  const low = (value) => value & 65535;
  const last = scores.at(-1).score;
  // Qualification uses signed low words; the insertion loop compares them unsigned.
  if (high(score) < high(last) || high(score) === high(last)
    && (score << 16 >> 16) <= (last << 16 >> 16)) return -1;
  let rank = scores.length - 1;
  while (rank > 0) {
    const above = scores[rank - 1].score;
    if (!(high(score) > high(above) || high(score) === high(above) && low(score) > low(above))) break;
    rank--;
  }
  return rank;
}

export class RunScreen {
  constructor(art, palette, randomWord) {
    this.art = art;
    this.palette = palette;
    this.randomWord = randomWord;
    this.pixels = new Uint8Array(320 * 200);
    this.stars = Array.from({ length: 48 }, () => this.newStar());
    this.age = 0;
  }

  newStar() {
    return { x: this.randomWord() << 16 >> 16, y: this.randomWord() << 16 >> 16,
      z: this.randomWord() & 8191 };
  }

  text(font, text, left, top) {
    for (const [i, letter] of [...text].entries()) {
      const glyph = font.glyphs.get(letter);
      if (!glyph) continue;
      for (let y = 0; y < font.height; y++) {
        this.pixels.set(glyph.subarray(y * 16, (y + 1) * 16), (top + y) * 320 + left + i * 16);
      }
    }
  }

  drawStars() {
    // 0f29:0202 projects each star and reseeds it when it leaves the viewport.
    for (const [i, star] of this.stars.entries()) {
      let candidate = star;
      candidate.z -= 512;
      for (;;) {
        if (candidate.z > 512) {
          const x = 160 + Math.trunc(candidate.x * 16 / candidate.z);
          const y = 100 + Math.trunc(candidate.y * 16 / candidate.z);
          if (x >= 0 && x < 320 && y >= 0 && y < 200) {
            const cell = y * 320 + x;
            if (!this.pixels[cell]) this.pixels[cell] = this.art.starColors[candidate.z >>> 10];
            this.stars[i] = candidate;
            break;
          }
        }
        candidate = this.newStar();
      }
    }
  }

  drawCredits(credits) {
    this.text(this.art.small, this.art.credits + String.fromCharCode(48 + (credits & 255)), 176, 184);
  }

  attractFrame(scores) {
    const { large, logo, staff } = this.art;
    const creditsEnd = staff.length * 72;
    const frame = this.age++ % (creditsEnd + 86);
    if (frame >= creditsEnd) {
      this.scoreFrame(frame === creditsEnd, scores);
      return;
    }
    this.pixels.fill(0);
    for (let y = 0; y < 54; y++) {
      this.pixels.set(logo.subarray(y * 208, (y + 1) * 208), (48 + y) * 320 + 48);
    }
    const [role, name] = staff[Math.floor(frame / 72)];
    const phase = frame % 72;
    if (phase >= 18) this.text(large, role, 0, 120);
    if (phase >= 36 && phase < 54) this.text(large, name, 0, 150);
    this.drawStars();
  }

  menuFrame(selection, music) {
    const { large, select, selections } = this.art;
    this.pixels.fill(0);
    this.text(large, select, 0, 12);
    if (selection !== undefined) {
      for (let i = 0; i < 3; i++) {
        this.text(large, selections[i === 2 && !music ? 3 : i][Number(selection === i)], 0, 60 + i * 24);
      }
      this.drawCredits(3);
    }
    this.drawStars();
  }

  continueFrame(ticks, credits) {
    const { large, prompt, counter } = this.art;
    this.pixels.fill(0);
    this.text(large, prompt, 0, 80);
    if (ticks !== undefined) {
      this.text(large, counter.replace("9", String(ticks >> 3)), 0, 120);
      this.drawCredits(credits);
    }
    this.drawStars();
  }

  gameOverFrame() {
    this.pixels.fill(0);
    this.text(this.art.large, this.art.gameOver, 0, 100);
    this.drawStars();
    this.age++;
  }

  readyFrame(player) {
    this.pixels.fill(0);
    this.text(this.art.large, this.art.readyPlayer.replace("1", String(player)), 0, 100);
    this.drawStars();
  }

  loadingFrame(stage) {
    const { large, loading } = this.art;
    this.text(large, loading.replace("1", String(stage)), 0, 12);
    this.drawStars();
  }

  openScores(scores, rank = -1) {
    this.scores = scores;
    this.scoreRank = rank;
    this.initialIndex = 0;
    this.scoreDirection = 0;
    this.scoreRepeat = 0;
    this.scoreHold = rank < 0 ? 85 : 0;
    this.scoreFrame(true);
    if (rank >= 0) this.setInitial(0);
  }

  setInitial(letter) {
    this.letter = (letter + this.art.alphabet.length) % this.art.alphabet.length;
    const entry = this.scores[this.scoreRank];
    entry.initials = entry.initials.slice(0, this.initialIndex) + this.art.alphabet[this.letter]
      + entry.initials.slice(this.initialIndex + 1);
  }

  scoreFrame(titleOnly = false, scores = this.scores) {
    this.pixels.fill(0);
    this.text(this.art.large, this.art.scoreTitle, 0, 12);
    if (!titleOnly) scores.forEach(({ score, initials }, index) => {
      const millions = String.fromCharCode(48 + Math.floor(score / 1000000));
      const digits = millions + String(score % 1000000).padStart(6, "0");
      this.text(this.art.small, `${this.art.scores[index].label}${digits} ${initials}`, 32, 38 + 16 * index);
    });
    this.drawStars();
  }

  updateScores({ left, right, scoreStep, confirm } = {}) {
    this.scoreFrame();
    if (this.scoreHold) return --this.scoreHold === 0 || (this.scoreRank < 0 && confirm);
    if (confirm) {
      this.scoreDirection = 0;
      if (++this.initialIndex === 3) this.scoreHold = 18;
      else this.setInitial(this.letter);
    } else if (scoreStep) {
      this.scoreDirection = 0;
      this.setInitial(this.letter + scoreStep);
    } else {
      const direction = left ? -1 : right ? 1 : 0;
      if (this.scoreDirection && direction !== this.scoreDirection) this.scoreDirection = 0;
      else if (direction && (!this.scoreDirection || --this.scoreRepeat === 0)) {
        this.setInitial(this.letter + direction);
        this.scoreDirection = direction;
        this.scoreRepeat = 4;
      }
    }
    return false;
  }
}

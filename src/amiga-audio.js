const EFFECT_CHANNELS = {
  shot: [2], explosion: [1], "explosion-large": [1], pickup: [2],
  credit: [2], health: [2], dive: [2], death: [1, 2],
};
export const AMIGA_AUDIO_PATHS = Object.freeze(Object.fromEntries([
  ["music", "amiga/audio/megablast.ogg"],
  ...Object.keys(EFFECT_CHANNELS).map((name) => [name, `amiga/audio/sfx-${name}.wav`]),
]));

export class AmigaAudio {
  constructor({
    createContext = () => {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) throw new Error("Web Audio is not supported");
      return new Context();
    },
    fetch = (...args) => globalThis.fetch(...args),
    onState = () => {},
  } = {}) {
    this.createContext = createContext;
    this.fetch = fetch;
    this.onState = onState;
    this.enabled = true;
    this.active = false;
    this.state = "idle";
    this.offset = 0;
    this.effects = new Map();
  }

  notify(state = this.state) {
    this.state = state;
    this.onState(state);
  }

  async unlock() {
    if (!this.enabled || this.state === "error") return;
    try {
      if (!this.context) {
        this.context = this.createContext();
        this.volume = this.context.createGain();
        this.volume.gain.value = 0.55;
        this.volume.connect(this.context.destination);
        this.musicVolume = this.context.createGain();
        this.musicVolume.gain.value = 0.75;
        this.musicVolume.connect(this.volume);
        this.deathVoiceVolume = this.context.createGain();
        // The recovered stereo death buffer is the exact sum of two identical voices.
        this.deathVoiceVolume.gain.value = 0.5;
        this.deathVoiceVolume.connect(this.volume);
      }
      // Resume inside the user gesture, before any fetch/decode awaits.
      const resumed = this.context.resume();
      if (!this.loading) {
        this.notify("loading");
        this.loading = Promise.all(Object.entries(AMIGA_AUDIO_PATHS).map(async ([name, path]) => {
          const response = await this.fetch(new URL(`../${path}`, import.meta.url));
          if (!response.ok) throw new Error(`Could not load Amiga audio: ${path.split("/").at(-1)}`);
          const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
          return [name, buffer];
        })).then((entries) => {
          this.buffers = new Map(entries);
        });
      }
      await Promise.all([resumed, this.loading]);
      if (this.state === "error") return;
      this.notify("ready");
      this.sync();
    } catch (error) {
      this.error = error;
      this.stop();
      this.notify("error");
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.sync();
    this.notify();
  }

  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    this.sync();
  }

  restart() {
    this.stop();
    this.offset = 0;
    this.sync();
  }

  stop() {
    if (this.music) {
      this.offset = (this.offset + this.context.currentTime - this.startedAt)
        % this.buffers.get("music").duration;
      this.music.stop();
      this.music.disconnect();
      this.music = undefined;
    }
    for (const source of this.effects.values()) {
      source.stop();
      source.disconnect();
    }
    this.effects.clear();
  }

  sync() {
    if (!this.enabled || !this.active || this.state !== "ready") {
      this.stop();
      return;
    }
    if (this.music) return;
    const source = this.context.createBufferSource();
    source.buffer = this.buffers.get("music");
    source.loop = true;
    source.connect(this.musicVolume);
    this.startedAt = this.context.currentTime;
    source.start(0, this.offset);
    this.music = source;
  }

  playFrame(names) {
    if (!this.enabled || !this.active || this.state !== "ready"
      || this.context.state !== "running") return;
    const pending = [];
    for (const name of names) {
      if (!Object.hasOwn(EFFECT_CHANNELS, name)) continue;
      // 00615a only requests the normal shot if 0414 is still empty.
      if (name === "shot" && pending[2]) continue;
      for (const channel of EFFECT_CHANNELS[name]) pending[channel] = name;
    }
    const now = this.context.currentTime;
    for (const channel of [2, 1]) {
      const name = pending[channel];
      if (!name) continue;
      const previous = this.effects.get(channel);
      if (previous) {
        previous.stop(now);
        previous.disconnect();
      }
      const source = this.context.createBufferSource();
      source.buffer = this.buffers.get(name);
      source.connect(name === "death" ? this.deathVoiceVolume : this.volume);
      source.onended = () => {
        if (this.effects.get(channel) === source) this.effects.delete(channel);
        source.disconnect();
      };
      this.effects.set(channel, source);
      source.start(now);
    }
  }
}

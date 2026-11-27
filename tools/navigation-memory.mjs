export function createNavigationMemory(initial = [], onChange = () => {}) {
  if (!Array.isArray(initial) || initial.length > 32) throw new Error("Navigation memory must contain at most 32 incidents.");
  const incidents = initial.map((entry) => {
    if (!entry || !["health-loss", "terrain-stall", "missed-supply"].includes(entry.kind)
      || !["stage", "campaignRound", "x", "worldY", "startTick", "endTick"].every((key) => Number.isFinite(entry[key]))
      || !Number.isInteger(entry.stage) || entry.stage < 1 || entry.stage > 5
      || !Number.isInteger(entry.campaignRound) || entry.campaignRound < 1
      || entry.endTick < entry.startTick || entry.startTick < 0
      || !Number.isFinite(entry.energyLost) || entry.energyLost < 0) {
      throw new Error("Invalid navigation incident.");
    }
    return Object.fromEntries([...["kind", "stage", "campaignRound", "x", "worldY", "startTick", "endTick", "energyLost"]
      .map((key) => [key, entry[key]]), ["previousAttempt", true]]);
  });
  const sameLevel = (entry, scene) => entry.stage === scene.stage && entry.campaignRound === (scene.campaignRound ?? 1);
  const seenPickups = new Map(), resolvedPickups = new Set();
  const add = (scene, kind, startTick, endTick, energyLost = 0) => {
    const x = scene.player.x, worldY = scene.camera + scene.player.y;
    const existing = incidents.findLast((entry) => entry.kind === kind && sameLevel(entry, scene)
      && Math.hypot(entry.x - x, entry.worldY - worldY) <= 24
      && (kind === "terrain-stall" || startTick <= entry.endTick + 8 && endTick >= entry.startTick - 8));
    if (existing) {
      const overlap = startTick < existing.endTick && endTick > existing.startTick;
      existing.energyLost = overlap ? Math.max(existing.energyLost, energyLost) : existing.energyLost + energyLost;
      existing.startTick = Math.min(existing.startTick, startTick);
      existing.endTick = Math.max(existing.endTick, endTick);
    } else {
      incidents.push({ kind, stage: scene.stage, campaignRound: scene.campaignRound ?? 1,
        x, worldY, startTick, endTick, energyLost, previousAttempt: false });
      if (incidents.length > 32) incidents.shift();
    }
    onChange(structuredClone(incidents));
  };
  onChange(structuredClone(incidents));
  return {
    record(before, after) {
      for (const pickup of before.pickups ?? []) {
        if (pickup.kind === "credit") continue;
        const key = `${before.campaignRound}:${before.stage}:${before.life}:${pickup.id}`;
        if (seenPickups.has(key)) continue;
        seenPickups.set(key, { x: pickup.bounds.x + pickup.bounds.w / 2,
          worldY: before.camera + pickup.bounds.y + pickup.bounds.h / 2,
          startTick: before.elapsedTicks });
        if (seenPickups.size > 64) seenPickups.delete(seenPickups.keys().next().value);
      }
      for (const outcome of after.pickupOutcomes ?? []) {
        const key = `${outcome.campaignRound}:${outcome.stage}:${outcome.life}:${outcome.id}`;
        if (resolvedPickups.has(key) || !seenPickups.has(key)) continue;
        resolvedPickups.add(key);
        if (resolvedPickups.size > 64) resolvedPickups.delete(resolvedPickups.values().next().value);
        const first = seenPickups.get(key);
        seenPickups.delete(key);
        if (!outcome.collected && outcome.kind !== "credit") {
          add({ ...before, stage: outcome.stage, campaignRound: outcome.campaignRound,
            camera: first.worldY, player: { x: first.x, y: 0 } },
          "missed-supply", first.startTick, outcome.elapsedTicks);
        }
      }
      const energyLost = Math.max(before.player.health - after.player.health,
        Number.isFinite(before.energyLost) && Number.isFinite(after.energyLost) ? after.energyLost - before.energyLost : 0);
      if (before.status === "playing" && before.stage === after.stage && before.life === after.life
        && Number.isFinite(before.camera) && energyLost > 0) {
        add(before, "health-loss", before.elapsedTicks, after.elapsedTicks, energyLost);
      }
    },
    nearby(scene, navigation) {
      if (scene.status !== "playing" || !Number.isFinite(scene.camera)) return [];
      if (navigation?.mapStalled && navigation.shipStalled && !navigation.bossVisible
        && (scene.terrain?.recovering || scene.terrain?.touching || navigation.cycle)) {
        add(scene, "terrain-stall", scene.elapsedTicks - Math.min(
          navigation.windowTicks ?? 32, 32), scene.elapsedTicks);
      }
      const worldY = scene.camera + scene.player.y;
      return incidents.filter((entry) => sameLevel(entry, scene) && worldY - entry.worldY >= -48
        && worldY - entry.worldY <= 192 && Math.abs(entry.x - scene.player.x) <= 160)
        .sort((a, b) => Math.hypot(a.x - scene.player.x, a.worldY - worldY)
          - Math.hypot(b.x - scene.player.x, b.worldY - worldY))
        .slice(0, 4).map((entry) => ({ ...entry, aheadPixels: worldY - entry.worldY,
          horizontalOffset: entry.x - scene.player.x }));
    },
    entries: () => structuredClone(incidents),
  };
}

export function incidentInstructions(packet) {
  if (!packet.feedback?.nearbyIncidents?.length) return "";
  return `\nPRIOR INCIDENT WARNING: feedback.nearbyIncidents records earlier health loss or terrain loops near this part of the level.
These are observed experiences, NOT predictions or proof of a damage cause. WorldY=camera+screenY; positive aheadPixels means the location is ahead.
For a terrain-stall pocket ahead, select a different connected corridor BEFORE reaching its x/worldY. Avoid entering the same dead end merely because the next short action looks clear.
Health-loss incidents include tick ranges for context; enemy motion and encounter timing may differ on this attempt. Recheck the current visible threats.
missed-supply is an OPPORTUNITY, not a hazard: a previously seen released supply expired without collection. Prepare a safe intercept near its first-seen location/time, keep firing, and prioritize the live supply when it appears. Do not assume it has already spawned or is still there; never ram a sealed pod or trade health for it.
The warning concerns a local position, not the whole horizontal row. Do not retreat indefinitely or abandon a safe supply solely because a historical incident is nearby. All steering remains your choice.`;
}

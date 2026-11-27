function distance(player, point) {
  return Math.hypot(player.x - point.x, player.worldY - point.worldY);
}

export function recoveryRoutes(scene) {
  const grid = scene.terrain?.navigation;
  if (!grid?.rows?.length || !Number.isFinite(scene.camera)) return [];
  const size = grid.cellSize, width = grid.rows[0].length, height = grid.rows.length;
  const player = { x: scene.player.x, worldY: scene.camera + scene.player.y };
  const point = (index) => ({
    x: grid.x + index % width * size,
    worldY: scene.camera + grid.y + Math.floor(index / width) * size,
  });
  const clear = (index) => grid.rows[Math.floor(index / width)]?.[index % width] === "0";
  const column = Math.round((scene.player.x - grid.x) / size);
  const row = Math.round((scene.player.y - grid.y) / size);
  const start = row * width + column;
  const routes = [];
  if (column >= 0 && column < width && row >= 0 && row < height && clear(start)) {
    const parents = new Map([[start, null]]), queue = [start];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor], x = index % width, y = Math.floor(index / width);
      for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
        const nx = x + dx, ny = y + dy, next = ny * width + nx;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || !clear(next) || parents.has(next)) continue;
        parents.set(next, index);
        queue.push(next);
      }
    }
    const targets = [
      queue.filter((index) => point(index).worldY <= player.worldY - 24)
        .sort((a, b) => point(a).worldY - point(b).worldY
          || Math.abs(point(a).x - player.x) - Math.abs(point(b).x - player.x))[0],
      queue.filter((index) => point(index).x <= player.x - 24)
        .sort((a, b) => point(a).x - point(b).x || point(a).worldY - point(b).worldY)[0],
      queue.filter((index) => point(index).x >= player.x + 24)
        .sort((a, b) => point(b).x - point(a).x || point(a).worldY - point(b).worldY)[0],
    ];
    for (const target of new Set(targets.filter((index) => index !== undefined))) {
      const path = [];
      for (let index = target; index !== null; index = parents.get(index)) path.unshift(point(index));
      const waypoints = path.filter((_, index) => {
        if (index === 0) return false;
        if (index === path.length - 1) return true;
        const before = path[index - 1], here = path[index], after = path[index + 1];
        return here.x - before.x !== after.x - here.x || here.worldY - before.worldY !== after.worldY - here.worldY;
      });
      routes.push({ kind: "visible-corridor", waypoints });
    }
  }
  routes.push({
    kind: "make-turning-room",
    waypoints: [{ x: player.x, worldY: player.worldY + 12 }],
  });
  return routes.map((route) => {
    const goal = route.waypoints.at(-1);
    return {
      id: `${route.kind}_${Math.round(goal.x / 16)}_${Math.round(goal.worldY / 16)}`,
      ...route,
    };
  });
}

export function createRecoveryNavigation() {
  let flight, active, requested = false, failed = [], lastOutcome;
  const fail = (reason) => {
    lastOutcome = { id: active.id, reason };
    failed.push({ id: active.id, goal: active.waypoints.at(-1), reason });
    failed = failed.slice(-4);
    active = undefined;
  };
  return {
    snapshot(scene, feedback) {
      const context = JSON.stringify([scene.status, scene.stage, scene.life, scene.campaignRound]);
      if (context !== flight || feedback?.navigation?.bossVisible) {
        flight = context;
        active = undefined;
        requested = false;
        failed = [];
        lastOutcome = undefined;
      }
      if (scene.status !== "playing" || !scene.terrain?.navigation || feedback?.navigation?.bossVisible) return;
      const player = { x: scene.player.x, worldY: scene.camera + scene.player.y };
      if (active) {
        const tolerance = active.kind === "make-turning-room" ? 2 : 8;
        while (active.index < active.waypoints.length && distance(player, active.waypoints[active.index]) <= tolerance) {
          active.index++;
          active.bestDistance = Infinity;
          active.improvedAt = scene.elapsedTicks;
        }
        if (active.index === active.waypoints.length) {
          lastOutcome = { id: active.id, reason: "waypoints-reached" };
          active = undefined;
        } else {
          const gap = distance(player, active.waypoints[active.index]);
          if (gap < active.bestDistance - 2) {
            active.bestDistance = gap;
            active.improvedAt = scene.elapsedTicks;
          }
          if (scene.elapsedTicks - active.improvedAt >= 32) fail("no-waypoint-progress");
          else if (scene.elapsedTicks - active.selectedAt >= 128) fail("plan-time-budget");
        }
      }
      const approachingTrap = feedback?.nearbyIncidents?.some(({ kind, aheadPixels }) =>
        kind === "terrain-stall" && aheadPixels >= 0 && aheadPixels <= 160);
      if (!active && !feedback?.navigation?.requiresRecovery && !approachingTrap) {
        requested = false;
        return;
      }
      const candidates = active ? [] : recoveryRoutes(scene).filter((route) => !failed.some((entry) =>
        entry.id === route.id && distance(entry.goal, route.waypoints.at(-1)) < 16));
      requested = !active;
      return structuredClone({
        ...(active ? {
          plan: { id: active.id, kind: active.kind, selectedAt: active.selectedAt,
            waypoint: active.waypoints[active.index], remainingWaypoints: active.waypoints.slice(active.index) },
        } : { candidates }),
        failedPlans: failed, ...(lastOutcome ? { lastOutcome } : {}),
      });
    },
    select(packet, choice) {
      if (choice === undefined) return;
      if (!requested || !packet.recovery?.candidates || typeof choice !== "string") {
        throw new Error("Unexpected recovery waypoint selection.");
      }
      if (choice === "manual") return;
      const route = packet.recovery.candidates.find(({ id }) => id === choice);
      if (!route) throw new Error("Model selected an unavailable recovery waypoint.");
      active = {
        ...structuredClone(route), index: 0, selectedAt: packet.scene.elapsedTicks,
        improvedAt: packet.scene.elapsedTicks,
        bestDistance: distance({ x: packet.scene.player.x, worldY: packet.scene.camera + packet.scene.player.y }, route.waypoints[0]),
      };
      requested = false;
    },
  };
}

export function recoveryInstructions(packet) {
  const recovery = packet.recovery;
  if (!recovery) return "";
  const plan = recovery.plan;
  return `\nRECOVERY WAYPOINTS: These are advisory routes from visible hull-clearance samples, not guaranteed safe paths or automatic steering.
Coordinates are x and worldY=camera+screenY. Smaller worldY is forward. Recheck enemies, banking and actual displacement; safety overrides a plan.
Visible-corridor routes connect clear four-neighbour samples; the gaps between samples and future scrolling are not certified clear.
make-turning-room proposes a brief straight retreat, not a known-clear corridor. At y=176 hold DOWN to reverse-scroll toward its worldY, checking recovery and danger each decision. Waiting after every DOWN can immediately scroll away the room just gained. Once reached, choose a new route; do not keep retreating.
${plan
    ? `PERSISTENT MODEL-SELECTED PLAN ${plan.id}: current waypoint x=${plan.waypoint.x}, worldY=${plan.waypoint.worldY} (screenY now ${plan.waypoint.worldY - packet.scene.camera}). Keep pursuing this waypoint while safe, rather than switching goals after every button press. Controls remain entirely your choice.`
    : "Select one offered recovery waypoint plan, or manual if none is suitable. Begin the safest manoeuvre toward that plan; subsequent decisions retain the selected goal."}
Plans are retired after 32 ticks without waypoint progress or 128 ticks total. Failed plans in this pocket are remembered. Reaching a retreat waypoint is NOT level progress; find a forward exit afterwards.`;
}

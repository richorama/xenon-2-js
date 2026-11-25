# Remaining native-port work

The browser reconstruction is playable, but is not yet a complete high-fidelity
port. Keep this checklist aligned with implementation and verified source
behaviour. Do not mark an encounter complete merely because its artwork renders.

## Playable release pass

- [x] Give a waiting stage-five winner one continue even if their partner is
  eliminated and the ending plays later. Test the real death and game-over
  timers, the ending, and the subsequent harder round. Ordinary keyboard play
  in Chromium also verifies the death animation, both Amiga death voices and
  the stage-one handoff to Player 2.
- [x] Paint stage-one mixed mounts in linked order, including the late Cannon
  overlay. DOS compares wall and weapon fire in two purchase orders; Chromium
  verifies actual overlay pixels and draw order in both.
- [x] Keep fire, dive/surface and a touch exit available in mobile fullscreen.
  Chromium verifies those controls with touch input and game-only fullscreen
  with keyboard/mouse.
- [x] Run all 601 foreground events, boss defeats, animated shops, and the
  ending in one scripted campaign. Buy and use a Cannon, then verify the
  restored wallet and loadout after a projectile death. See README for the
  exact assists and validation commands.
- [x] Keep flight keyboard controls active after pointer mute or dive, without
  taking focus from a keyboard-activated button. Verified in Chromium.
- [x] Retire normal rounds during the death animation in stages three and five,
  while the separate Drone pass keeps running. DOS checks the death latch before
  moving ordinary rounds; Node and Chromium verify the two paths.
- [x] Apply the ordinary foreground death callback after a surviving ram in
  stage three. A lethal ram still leaves the enemy intact. Node covers both
  cases, and Chromium survives the previously fatal input sequence.
- [x] Complete a five-stage run using only gameplay inputs and use it to
  identify ordinary-play blockers or difficulty spikes. Chromium replayed
  35,740 input frames through all five stages, the ending and flight in round
  two. The final arena required backtracking and aligning Side Shot with the
  last beam turret's narrow hitbox; no gameplay assists were used.
- **Deferred fidelity:** rare shared-pool and recycled-slot ordering, specialized
  animation/death and audio callbacks without a confirmed ordinary-play issue,
  and original Paula channel stealing and analogue filters. The checklist
  below records those differences; they are not blockers for this pass.

## Current baseline

- Five stages of foreground events run: 601 records.
- Stage one's boss, tentacle, weak point, rewards and stage transition are ported.
- Stage two's three-eye miniboss, segmented attacks, forced backtracking,
  destruction rewards and same-stage shop are ported.
- Stage two's final boss, eggs/crawlers, repairable arena walls, counted rewards
  and stage-three shop transition are ported.
- Stage three's eleven-part final worm, head damage, eight-way fire, twenty
  counted rewards and stage-four shop transition are ported.
- Stage-one background types 1-4 and its rotating terrain worms run.
- Stage-two background types 1-5 run.
- Stage-three background types 1-6 run, including its 17-part miniboss and mid-shop.
- Stage-four background types 1-5, both bosses and both shop transitions run.
- Stage-five background types 1-9, both bosses, the mid-stage shop and victory
  sequence run. All five stages finish through their original bosses, and a
  victory starts the next, harder campaign round.
- The original graphical shop runs in the game canvas, with recovered cabinet,
  animated stock, hatches, shutters, Colin, pixel dialogue and credits.
- Super Nashwan uses the original timed seven-mount loan and restores equipment.
- Recovered Amiga music and eight effects play.
- Three original DOS bugs are intentionally corrected: boss death explosion
  placement, foreground aiming and final-worm projectile animation. See
  [the documented fixes](README.md#intentional-fixes-to-original-dos-bugs).
- 331 Node tests pass, with additional original-executable scene comparisons.

## 1. Stage encounters and progression

- [x] Stage-two miniboss: three weak points, opening/vulnerability rules, attack
  formations, animation, scrolling locks/reversal, destruction and mid-stage shop.
  Verified all 16 formation entries, eye/light updates, corpse callbacks,
  32 eye-hit states, destruction RNG and the counted-credit shop trigger against
  original execution. Browser-tested backtracking, rewards, shop purchase/resume
  and game-only fullscreen. Shared actor-pool/global-frame fidelity remains below.
- [x] Stage-two final boss: body/mouth weak point, movement, animated single/ring
  shots, eggs hatching into routed crawlers, destructible/repairable arena walls,
  death rewards and stage-three shop transition. Original execution verifies
  7,200 controller ticks, 16 egg scenarios, 8,000 crawler ticks, 132 terrain cases
  and death/reward RNG. Corrects the DOS death callback's clobbered-register
  bug so its large explosions use the boss position. Browser-tested rendering,
  hit flash, attacks, creatures, wall destruction/repair, 20 counted rewards,
  actual stage-three shop purchase/continue, mobile layout and game-only
  fullscreen. Shared population/update ordering remains approximate.
- [x] Stage-one terrain scripting: five rotating slots release segmented worms
  from sixteen animated openings. DOS execution verifies every route with
  forward, reverse and held scroll, a 750-tick automatic sequence, directional
  bounds, exit tiles, score, and the head/body corpses. Each live chain uses
  fourteen shared records. DOS compares raw allocation and retirement order,
  retained driver fractions and inherited headings without normalization.
  Corpses enter the shared transient list. DOS verifies their draw eligibility,
  expiry and slot release, including a saturated death that reuses its own slot
  and never draws. Chromium verifies hatch animation, shot damage, corpse paint
  after the ship, recycled poses and checkpoint cleanup. Worm rams use the
  pre-steering hull and the previous group gate; a ram corpse can move in the
  same frame, and a fatal ram does not flash. Straight rounds, Cannons, Drone
  and Shades also honor the cached group gate and stop at the first matching
  record, even if it is hidden or marked. Straight and Cannon rounds share the
  transient list with corpses: a projectile-born corpse draws immediately but
  first moves on the next visit, even when it reuses the killing shot's slot.
  Mixed-list contact, paint and saturation with other actor families remain open.
- [x] Pool stage-one stationary map guns and their hostile rounds. DOS verifies
  both sides of all three gun types in one linked scene, linked RNG and expiry,
  and a full-pool shot that inherits a spent round's fractional position.
  Chromium verifies that the replacement moves and draws after the ship on
  its firing tick. Large death explosions also use the pool. DOS verifies
  their five frames, delayed release, spent-round reuse, and the raw map
  writes when a gun replaces itself with a marked, undrawn explosion.
  Chromium verifies that visible explosions draw once after the ship.
- [x] Pool stage-one wall patrols and their three-shot fans. Both sides keep
  their slot when they move to the transient list, advance the firing animation
  on the migration tick, and cease to be main-list targets. DOS verifies
  allocation, draw order, and retirement, including the later shots reading
  the overwritten slot's type and position at capacity. Patrol kills also
  use the shared explosion callback, including spent-shot and self-reuse.
  Chromium verifies the patrol's draw order before and after firing, and that
  a visible blast draws once per frame while a self-reused blast never draws.
- [x] Search stage-one pooled ground targets in original main-list order for
  straight rounds, Cannon, Drone, Shades and pre-steering rams. DOS verifies
  both gun/worm insertion orders, marked blockers, and the six stationary
  guns' cached inclusive bounds. Chromium verifies the chosen target's
  explosion or corpse and that a marked gun blocks Shades without a blast.
  Foreground and boss targets also use this list.
- [x] Pool stage-one foreground fire and the boss tip's animated rounds.
  DOS verifies same-tick motion, draw order with a wall gun's shot,
  retained fractions after recycling, and deferred slot release. The
  stage-one boss death prepends 20 explosions, appends 18 counted credits,
  and releases only main-list slots. DOS verifies the fatal callback and
  subsequent updates with spare capacity and at capacity. Chromium verifies
  that a live boss round keeps moving and draws between the two groups
  after a lethal player shot.
- [x] Pool stage-one foreground formations, pods, explosions, and drops.
  DOS verifies linked composite poses, cached inclusive bounds, draw eligibility,
  retirement, and a shot that inherits a foreground successor's fractions and
  advances in both lists at capacity. Death traces verify free and recycled
  slots, retained reward headings, and a self-reused pod drop that never draws.
  Chromium verifies ship/mount–main–transient draw order, including attachments
  drawn once, plus same-frame births and a reward sharing a weapon's type ID.
- [x] Dispatch stage-one Z through the shared main list. DOS verifies a pod,
  formation and wall gun in both linked orders, recording resulting effects,
  credits, rewards and the marked hostile round. Chromium verifies that
  collecting Z before a hostile round prevents damage and paints drops and
  blasts in link order.
- [x] Match the full-pool Z detour when a pod reward replaces the saved
  formation successor. DOS verifies the cross-list dispatch, unchanged trailing
  formation, fatal score/reuse, and palette-7 flash if the inherited health
  survives, for both single-part and composite formations. Chromium verifies
  the reward and surviving attachment flash or are suppressed as appropriate.
- [x] Dispatch the full-pool Z hit when a pod reward replaces the saved wall
  gun or patrol. DOS verifies the inherited callback, score, blast position and
  retirement. A wall gun copies tiles from the new blast's animation cursor.
  Chromium verifies those tiles, patrol removal and no reward or blast paint.
- [x] Mark a terrain worm's path driver during Z without awarding extra score
  or a corpse. DOS verifies the segment corpses, driver and guard retirement,
  allocation and RNG with and without spare slots. Chromium verifies corpse
  pixels and the driver's release.
- [x] Pool the stage-one boss core and arms. DOS verifies core reservations
  for solo and alternating starts, arm allocation and parent links on arena
  entry, cached bounds, linked mixed fire and cleanup. The eight arms retain
  their slots across a checkpoint restore. Chromium verifies the main-list
  paint order and that a real lethal eye hit leaves the tip round flying.
- [x] Follow recycled parent positions for stage-one foreground attachments.
  DOS verifies a surviving attachment following a replacement round in flight,
  retaining its last position after unlinking, then following a blast that reuses
  the address. DOS also verifies a boss arm following a replacement round's
  position, heading and step count while inheriting the old arm's turn and
  acceleration. Chromium verifies both surviving attachments render correctly.
- [x] Match stage-one formation and boss-eye hit flashes. DOS verifies both
  composite sprite masks, four boss tile poses and the draw callback reset,
  all using palette index 7. A Cannon round is spent on a boss arm without
  flashing or damaging it. Chromium verifies the one-tick color, the missing
  mouth during the core flash, and the next-tick flash from a Drone hit.
- [x] Route hits on a stage-one attachment through a root slot reused by a
  hostile round or a blast. DOS and Chromium verify the inherited health,
  both palette-7 flashes, the lethal retirement, score and credit. At capacity
  the credit takes the killing shot's slot.
- [x] Follow a blast or pod reward that takes a stage-one boss arm's parent
  slot. DOS verifies the full chain's positions, inherited fractions and
  motion budget, including a blast retaining the previous round's speed
  and a surviving arm using the final coordinates after unlinking.
  Chromium verifies that the surviving arm moves and paints accordingly.
- [x] Follow forward, left and Cannon rounds that take a stage-one boss arm's
  parent slot. DOS verifies their inherited fractions and movement budget,
  the Cannon's retained heading, and the left shot's signed table lookup
  before heading wraps. Chromium verifies the projectile and arm positions.
- [x] Follow counted and ordinary credits that take a stage-one boss arm's
  parent slot. DOS verifies linked updates, retirement and the first motion
  step when an ordinary credit supplies an unmasked RNG heading, including
  16-bit address wrap. Chromium verifies the visible credit and surviving arm.
- [x] Verify corrected stage-one aimed fire across HUD and main-list callbacks.
  Corrected in-memory DOS execution verifies all three map guns, both patrols
  (including a fan reusing its patrol slot), worm guard bounds, boss callbacks
  and banking jets. Shots target the player rather than inherited register
  state. Node regressions cover all five stages and mixed stage-one callbacks.
- [x] Preserve the stage-one frame painted before a lethal Drone hit.
  DOS verifies the old formation sprites and gun tiles on impact, then the
  first visible explosion and credit frames. Chromium verifies unchanged
  impact-frame playfield pixels for a formation, a wall gun and the boss.
- [x] Match attachment damage after the hostile round in its root slot is
  marked or freed. DOS verifies retained health, score, credit and the
  released slot's reuse; only the still-linked marked round paints its flash.
  Chromium verifies that distinction on the playfield.
- [x] Match attachment damage when a pod reward or Cannon round takes the
  root slot. DOS verifies the two flashes, shared health, score and credit;
  Chromium verifies that the replacement still paints before it is retired.
- [x] Match attachment damage when a credit takes the root slot. DOS and
  Chromium verify the ordinary credit's flash, score and replacement drop.
  DOS also verifies those effects for a counted credit without decrementing
  the countdown.
- [ ] Match attachment damage through the remaining root-slot replacements
  and boss-arm parent motion for the remaining replacement types.
  Match other screen-clear slot replacements and carry across other list visits.
- [x] Use the eight-entry formation credit table for scheduled waves in
  all five stages, including the seven-part stage-three worm and two-part
  stage-four formation.
  DOS verifies four-tick small/large groups, combined counts, capacity, unlink
  cleanup, escape cancellation, supply pods and the Z reset. Chromium verifies
  one globe paints after the final kill across two grouped waves in each stage.
- [x] Dispatch stage-one camera events after painting and Drone updates.
  DOS verifies coincident foreground, wall-gun and patrol allocation, delayed
  tile and sprite paint, and a Drone earning credit before the next wave
  registers in the same group. Chromium verifies unchanged birth-frame
  playfield pixels and the new sprites and tiles on the following frame.
- [x] Dispatch stage-two camera events after painting, separately from the
  reserved boss and miniboss arena controllers. DOS verifies coincident wave,
  gun, patrol and hatch births in both pool layouts, including constructor
  order, RNG, map writes, first callbacks and delayed gun collision bounds.
  Chromium verifies that birth-frame pixels are preserved even when an event
  reclaims an already-painted explosion.
- [x] Preserve stage-two wall-gun paint across the late Drone pass. DOS verifies
  that idle guns do not overwrite overlapping animated tiles, and that
  the flash callback and death blast are not painted on the impact frame.
  Chromium verifies the following frame's palette-7 flash or destroyed tiles
  and blast.
- [x] Dispatch stage-three camera events after painting, including the
  17-part miniboss constructor. DOS verifies coincident wave, skater, turret
  and miniboss births, map writes, first updates and RNG; Chromium verifies
  unchanged birth-frame pixels and the new sprites and tiles on the next frame.
- [x] Dispatch stage-four and stage-five camera events after painting. DOS
  verifies mixed wave and wall births, delayed stage-four gun bounds, both
  stages' miniboss and final-boss entries, and stage five's deferred final-room
  camera snap and map rewrite. Chromium verifies unchanged birth-frame
  pixels and subsequent wall actors, boss parts or arena terrain.
- [x] Match the original foreground/background camera high-water marks.
  DOS verifies startup, unsorted dispatch, held/reverse scrolling, separate
  exclusive checkpoint bounds and the final arena's camera snap.
- [x] Port stage four's separate prepaint corridor spawns and reverse clamp
  at `CS:b555`. DOS verifies 1,798 ticks of all four ship variants, angled
  shots, pods that release drones and then explode, drone reroutes and the
  50-credit reward. Chromium verifies visible ship, pod, blast and drone
  sprites.
- [x] Stage-three background types 1/2/5/6: eight-part retracting arms with shared
  health and triggered tip animation, skaters with corridor-turning projectiles,
  terrain-following crawlers with aimed fire, and two-stage terrain turrets with
  separately damageable cores and animated eight-way fire. Original execution
  verifies 72 actor traces, eight damage/death scenarios and 20 projectile traces,
  including reversal, corners, visibility, tiles, RNG and source flag quirks.
  Browser-tested all 56 supported background events (including existing type 4),
  sprites/tiles, shots, hit flash, both turret deaths, continuation, mobile and
  game-only fullscreen. Whole-frame list ordering remains a shared-state gap.
- [x] Stage-three background type 3's 17-part miniboss: path-driven body, two
  independently damageable 20-health opening eyes, articulated claws, animated
  aimed shots, white hit flash, camera lock, chained destruction, ten counted
  credits and same-stage shop. Original execution verifies 4,000 complete
  component-update ticks across four eye-health profiles and both eye-death
  orders, including fixed-point movement, animation, bounds, RNG, rewards and
  the delayed camera-floor release. Browser-tested actual shot damage, dead-eye
  art, final destruction/rewards, shop purchase/resume, all 149 stage-three
  foreground events, mobile and game-only fullscreen. Prevented a provisional
  next-stage transition during the death latch. Specialized claw audio and
  whole-frame shared-list fidelity remain under the sections below.
- [x] Stage-three final boss and original stage/shop transitions: eleven delayed
  path-following components, seven appearances, original rotating path selector,
  80-health head, directional animation, eight-way fast shots, terrain overlays,
  shared white hit flash, death cleanup and twenty counted rewards before the
  stage-four shop. Independent execution verifies 12,600 complete controller
  ticks, four damage/death scenarios and eight projectile lifetimes. Corrects
  the source projectile-animation timer bug while retaining signed path-end
  duration; the comparison applies the timer fix only in memory.
  Browser-tested worm/terrain rendering, actual shot damage, white flash,
  twenty explosions/rewards and actual graphical-shop purchase/stage-four
  continuation. Shared actor-pool/global-frame fidelity remains below.
- [x] Stage-four background types 3/5: hatching wall hunters that reset after
  attack or death and award uncounted credits, and map-only extending wall
  rams that survive Z. Original execution verifies 40 traces and 5,003 ticks
  of animation, hit bounds, draw commands, RNG, expiry and rewards.
- [x] Stage-four type 2 miniboss: twenty components, articulated attacks,
  aimed/ring projectiles, guarded guns, tail-triggered forced reverse,
  core-only finish, terrain clearing and ten rewards before a same-stage shop.
  Original execution verifies 1,000 ticks including both guard-death orders.
- [x] Stage-four type 4 final boss: two turrets protecting the core, animated
  shots, sixteen-part sweeping beam, original explosion quirks and twenty
  counted credits before the stage-five shop. Original execution verifies
  1,000 ticks including both turret-death orders. Browser-tested both fights,
  forced reversal, rendering, all 103 foreground events and both graphical
  shop transitions in a scripted stage-four playthrough.
- [x] Stage-five background types 1/3/4/9: breakable barriers, swiveling
  and ring-firing terrain turrets, and separate death flags for the two tagged
  turrets. Original execution verifies 66 traces and 8,668 ticks, including
  hit bounds, flash drawing, firing, conditional terrain patches and expiry.
  Browser-tested shot hits, flash rendering, turret rounds and destruction.
- [x] Stage-five types 7/8: three staggered ten-ship formations fire eight-way
  rings, and nine wall patrols release damageable, short-lived homing enemies.
  Original execution verifies 36 traces and 8,236 ticks of paths, firing,
  direction changes, animation, bounds and damage. Chromium verifies their art
  and attacks.
- [x] Stage-five type 5 miniboss: four aimed guns, moving core, extending beam,
  homing attacks and limited backscroll. Core destruction clears the arena and
  releases ten counted credits before the same-stage shop. The tagged turrets
  are independent, not a core lock. Original execution verifies 1,100 ticks;
  Chromium verifies attacks, hit flash, purchase and resume.
- [x] Stage-five type 6 final boss: rebuild the arena, extend backscroll, destroy
  eighteen defenses to expose the core, then resolve twenty counted credits.
  Original execution verifies 1,405 ticks, including both scroll directions,
  attack timing, the wall's low-byte collision wrap and death cleanup. The
  victory visit plays Colin's three recovered lines, then the original cross
  and blank holds. Chromium verifies the fights, rewards and ending imagery;
  victory sound timing remains part of audio fidelity.
- [x] Replace provisional wave-count completion in the shipped campaign.
  The campaign regression runs all 601 foreground events through the five
  boss-controlled stage endings, including stage five's victory sequence.
- [x] Port background type-zero checkpoints, equipment/credit restoration,
  death animation and single-player continues. All 39 records save camera,
  spawn X and credits, and skip the equipment snapshot during Super Nashwan.
  `CS:195b` restores the ship at Y=176 with separate foreground/background
  re-entry bounds. The two special arena checkpoints save equipment but
  leave saved credits unchanged. Stage-four and stage-five arena damage
  survives death; the final room keeps both event streams closed.
  Original execution verifies the saves, re-entry bounds, death frames and
  79-update continue countdown. Chromium verifies actual deaths, two
  checkpoint respawns, keyboard continuation, timeout and game over.
- [x] Restore original stage entry and post-victory campaign cycling
  (`CS:40a7-416f`). Stage transitions clear the wallet and enter at Y=176,
  retaining score, lives, health and equipment between ordinary stages. Victory
  gives one extra continue and returns to stage one at a higher difficulty
  with a fresh starter gun. DOS verifies four
  transitions and foreground health in rounds 1, 2 and 7. Chromium verifies
  the cross, blank hold and automatic playable return to stage one.
- [x] Recover the original high-score, continue and game-over screens.
  DOS VGA execution compares 66 indexed frames and matching RNG, score
  qualification and ties, initials entry/repeat and holds. Chromium verifies
  keyboard and touch initials, continue acceptance and expiry, read-only score
  viewing, and restart. Scores last for the browser page session.
- [x] Restore the eight-step ship and equipment posture on startup and respawn.
  DOS stage transitions include the reset value; Chromium verifies the
  checkpoint animation and that mounted weapons wait while the basic gun works.
- [x] Port local alternating two-player play and synchronized stage advancement.
  Lives, continues, score, equipment, maps and checkpoints are separate; the
  score board, RNG and campaign round are shared. DOS verifies six handoff
  cases, the stage and victory gates, and ten complete get-ready frames.
  Chromium verifies touch selection, both ready prompts, death and continue
  handoffs, both shop exits, synchronized advancement and restart. Original
  shared actor capacity/reuse and full two-player playthrough parity remain open.
- [x] Restore the original attract-mode logo, timed staff credits, high-score
  loop and graphical player selection. DOS verifies 33 full frames, the
  frontend palette, RNG, menu wrap and music toggle; Chromium verifies
  keyboard and fullscreen touch selection. Both numbered ready screens
  use the recovered font and stars.
- [x] Show numbered Get Ready after a solo checkpoint restore, including
  accepted continues. DOS verifies five complete checkpoint-entry frames,
  shared RNG and the fire latch; Chromium verifies keyboard and touch resume.
- [x] Restore the numbered loading frame on menu launch and stage changes,
  including the campaign loop, followed by Get Ready before flight. DOS
  verifies four loading-to-ready sequences; Chromium verifies both frames
  appear on the canvas before gameplay resumes.
- [x] Return to attract mode after the last player's 30-frame game-over screen
  (`CS:3f7b/3c9d`). DOS verifies the return from either seat, including first
  title frames and RNG. Chromium verifies automatic return and keyboard menu
  access; the surviving seat still takes over in alternating play.

## 2. Combat fidelity

- [x] Audit installed upgrade slots and idle/on-ship artwork: original
  auxiliary coordinates, trailing Drone/Electro Ball, animated Mine and
  Flamer mounts, and no separate model for Side Shot, Bomb or Homing Missile.
  The Missile Launcher now opens and fires the original pair from its
  barrels. Original execution compares 24 purchase/pod loadouts, their
  idle poses and launcher firing. Chromium confirms Cannon and overlay,
  Laser and Missile Launcher anchors, both launcher rounds, trailing Drone
  and no separate Side Shot sprite. Active weapon behavior is covered below.
- [x] Paid cannon: use the original four mount offsets, recoil, muzzle,
  animated rounds and two-damage collision. Shares the cannon implementation
  with Super Nashwan and uses the existing autofire pulse. Original execution
  compares 200 update ticks across all four mounts, with held fire and taps.
- [x] Super Nashwan: replace the invented fan with the source seven-mount loan:
  powered double shot, two cannons, two lasers, drone and side shots. Preserve
  purchased equipment, 170 gameplay ticks, pause/shop suspension, death handling
  and restoration. Recover cannon animation/fire cadence, growing/detaching
  nine-damage lasers, twelve-way drone volleys and three-position trailing.
  Original execution verifies constructors, 300 weapon-update ticks, expiry/
  restoration and the powered beam's clipping and damage bounds.
  Browser-tested actual purchase, attacks and timed restoration.
- [x] Paid Laser and Drone share the verified Super Nashwan implementation.
  The Laser grows and detaches, widens and gains damage with each power level,
  and follows autofire pulses. The trailing Drone uses its separate held-fire
  cadence and emits four, eight, or twelve shots. Original execution verifies
  300 paid-weapon update ticks and 18 beam lifetimes across all powers.
  Chromium verifies all three beam widths, detached caps and Drone volleys.
- [x] Electro Ball: hold fire to steer the existing ball relative to ship
  movement, release to return to the trailing mount. Only the first target
  takes four damage per active tick. Original execution verifies 480 ticks
  of animation, positions, collision bounds and damage. Chromium verifies
  the launch, steering and return draws. Dive presentation and shared
  collision ordering remain approximate.
- [x] Bomb: one spinning charge at a time, height-dependent ascent, a brief
  stationary fuse, a 64-pixel-square blast and four randomized explosion
  sprites. Original execution verifies 360 ticks across three firing rhythms
  and launch heights, including reload, damage, animation and RNG. Chromium
  verifies projectile and explosion rendering.
- [x] Flamer: two animated plumes per held-fire tick, signed fixed-point drift
  and first-target damage of 1/2/3 for only one plume. Original execution
  verifies 1,080 ticks across all powers and three firing rhythms, including
  RNG, bounds and expiry. Chromium verifies both plumes and the animated mount.
  The dedicated continuous sound remains unported.
- [x] Mine: hold fire to raise and steer the mount, lay up to ten spaced
  charges, then release to detonate them in order. Original execution
  verifies 960 ticks across both powers; Chromium verifies the mount,
  charges and blasts.
- [x] Homing Missile: launch four rockets, coast, pause and acquire targets
  with the shared RNG, then steer in discrete steps and deal point damage.
  Original execution verifies 480 ticks; Chromium verifies live rockets
  and expiry bursts. Exact target traversal depends on the shared actor pool.
- [x] Recover ordinary foreground attacks and directional entry frames.
  Original execution verifies 1,600 firing updates, six entry poses and 45
  projectile cases, including all five stage sprites, the source aiming
  register quirk, fixed-point flight, reverse scroll and dive collision.
  DOS and Chromium verify pre-steering hitbox edges and the palette-7 ship
  flash in all five stages. Chromium also checks all five projectile sprites.
  Cross-list order, recycled subpixels and shared protection remain below.
- [x] Recover ordinary foreground composites: animated stage-one/stage-four
  attachments copy the root, while the stage-three chain follows a delayed
  path with eight-direction sprites per part. All its hitboxes route damage to
  the root. Six original formation traces verify construction, motion, escape,
  shared death, explosion frames, score and credit rewards. Chromium verifies
  the component rendering and death in all three stages.
- [x] Restore the four ship maneuver jets. A 48-tick DOS trace verifies
  their front/rear pairs, bank offsets, animation while hidden, and dive
  and death behavior. Chromium verifies the flame pixels in stages one and two.
- [ ] Port remaining animation callbacks and special death sequences.
- [ ] Match player/projectile/terrain collision ordering and edge conditions.
- [x] Match ordinary ship contact with map tiles: use the calibrated hull mask,
  reset banking, extend the reverse limit and rewind recent world positions.
  DOS verifies six recovery traces, including camera clamps, fatal overlap and
  the counted-credit gate. Chromium verifies a natural stage-one wall hit and escape.
- [x] Match bought Protection and ordinary damage. Protection halves each
  hit until the next shop; ordinary hits don't start an immunity timer.
  DOS verifies consecutive hits, truncation, fatal damage and the shop reset.
- [x] Port dive charges, the four dive poses, terrain occlusion, the 136-tick
  hold timer and early resurfacing on a second press. DOS verifies six input
  traces (including pickup eligibility), 1,600 hull-mask cases across all
  stages, and both escape and death when replaying recent ship positions.
  Chromium verifies Shift, touch, Canvas poses and terrain occlusion.
- [x] Match mounted weapons during dive, resurfacing and death: apply the
  original sprite-center transform, hide at posture sixteen, animate the
  mounts while hidden and gate their attacks separately from the basic gun.
  DOS compares 305 updates across five loadouts, including the Cannon's
  overlay and remote mounts. Chromium verifies movement, hiding and firing
  after resurfacing.
- [x] Port the two-frame invulnerability ring and Shades. The ring stacks time
  and only counts down at full exposure; Shades replaces ship contact with one
  127-damage search per exposed tick. DOS verifies 580 ring ticks and six
  Shades cases; shared actor order and stage-specific terrain fallbacks remain open.
- [x] Match the dive and Shades meter pass before Drone flight. A 229-tick DOS
  trace compares draw order, sprite levels, countdown and cancellation: both
  meters paint the empty level on expiry, and ship death cancels only the dive
  timer. Chromium verifies active and empty levels in stages one and two.
- [x] Port the shared pickup flight and sprite-bound collection for all 19
  pod rewards and credit globes: seek the center, orbit, then fall out.
  Original execution verifies both complete lifetimes for each pod reward;
  Chromium verifies the orbiting sprite and collection after surfacing.
- [x] Match collection against the cached ship bounds in every stage. DOS and
  Chromium verify edge hits and misses after steering, both credit values,
  and the counted-credit decrement on collection.
- [x] Preserve the inherited direction word for pooled stage-two pod rewards
  and boss credits. DOS traces one slot through a shot, a pod reward and a
  boss globe; Chromium verifies their first steps and visible retargeting.
- [x] Match the global boss-credit countdown when ordinary drops coexist
  with boss credits. DOS and Chromium verify that collecting an ordinary
  credit or letting a pod reward fall out can finish the count and expose
  the ship to later shots before the shop opens. Collecting a pod does not.
- [x] Keep the boss-credit countdown unchanged when stage-two slot pressure
  discards a globe. DOS and Chromium verify that an evicted globe leaves
  damage protection and the shop gate active until another qualifying drop.
- [ ] Audit pickup effects, cross-list collection order and actor reuse,
  including direction writers not yet tracked by the pool and reuse outside
  stage two.

## 3. Shared simulation state

- [ ] Reproduce the original shared RNG consumption across all actors/systems.
  Ordinary foreground constructors and randomized path branches now share the
  RNG with firing; ordering across the other actor lists remains open.
- [x] Port the 159-record shared allocator and starter reservations, with
  stage-two foreground enemies, wall guns, patrols, their rounds, map hatches
  and hatchlings wired to it. Hatchling wobble comes from its allocated slot,
  and a firing patrol keeps its record when it changes lists. DOS comparisons
  cover both startup modes, six exhaustion cases, and 16 hatch traces with
  actual allocation addresses and deferred reuse.
- [x] Add stage-two credit globes, pod rewards and standard explosions to the
  transient list. Four 48-tick mixed scenes compare slots, round positions,
  explosion frames, score and RNG, with and without Z. DOS also verifies both
  Z/round contact orders and the final boss's 20-credit/30-effect list order.
- [x] Reserve the stage-two boss and eye records for both seats and keep live
  controllers on checkpoint restore. Pool the final boss's eggs, crawlers and
  rounds, including retained projectile subpixels. A 900-tick DOS arena trace
  compares actor addresses, list order, frames, positions, free head and RNG.
- [x] Match the final boss egg's hatch when its own slot is reclaimed. DOS
  verifies that the replacement crawler is marked without drawing, and the
  slot frees on its next main-list visit. Chromium verifies both the suppressed
  crawler and normal hatch artwork.
- [x] Pool stage-two miniboss waves and corpses and run the eye callbacks in
  main-list order. A 1,040-tick DOS comparison across both startup modes covers
  wave dispatch, Z, corpse movement, deferred retirement, reused heading and
  coordinate words, and the last eye's cleanup and reward allocation.
- [x] Pool stage-two forward, rear, side, double, and Missile Launcher rounds
  in the transient list. Two 98-tick DOS scenes compare addresses, movement,
  launcher animation, overlapping targets, culling, and the death-time clear.
- [x] Pool stage-two Cannon rounds in the transient list. A 98-tick DOS
  trace compares four paid mounts, animated projectile bounds, repeated
  two-damage hits, effects, culling, and death cleanup. Chromium verifies
  animation and repeated hits on the newest overlapping target.
- [x] Pool stage-two Laser beams in the transient list. Three 98-tick DOS
  traces compare two paid mounts, all three powers, beam growth and release,
  damage to overlapping targets, effects, slot reuse, and death cleanup.
  Chromium verifies the growing and detached beams in Canvas.
- [x] Pool the stage-two Bomb charge and its four blast effects. A 98-tick
  DOS trace compares charge animation, fuse, ordered area damage, effect
  positions and frames, slot reuse, and cancellation on ship death.
  Chromium verifies charge and blast rendering and death cleanup.
- [x] Pool both stage-two Flamer plumes, preserving the horizontal fraction
  and delaying reuse of the replaced starter until its mount-list visit.
  Three 98-tick DOS traces compare all power levels, allocation, fixed-point
  drift, RNG, collision bounds, retirement, and ship-death cleanup. Chromium
  verifies that both plumes render and the visual plume survives a hit.
- [x] Pool the stage-two Mine and Super Mine charges and their blast effects.
  Two 179-tick DOS traces compare mount motion, the ten-charge cap, release
  fuses, RNG, blast damage, effect frames, slot reuse, and death cleanup.
  The original count survives checkpoint cleanup even when death clears
  live charges. Chromium verifies both charge sprites and blast animations.
- [x] Pool stage-two Homing Missiles and their targetless bursts. Two 98-tick
  DOS traces compare four-way launches, actor-address locks, nonfatal hits,
  burst animation, and death cleanup. Chromium verifies launch, turning,
  and burst rendering.
- [x] Keep an existing Homing Missile lock when a stage-two wall patrol
  moves to the transient list to fire. DOS and Chromium verify that the
  missile steers without another RNG roll, while a missile without a lock
  cannot acquire the moved patrol.
- [x] Match stage-two Homing Missile locks when a target slot is reused by
  the final boss. DOS and Chromium verify that a crawler retains the lock,
  while an untargetable egg triggers a fresh search and, with no target, a burst.
- [x] Match recycled stage-two miniboss corpse slots. A locked Homing Missile
  follows inherited patrol bounds even as the corpse drifts elsewhere, but
  fresh searches skip the corpse and a prior egg leaves no usable bounds.
  At capacity a corpse that reuses its own wave's slot is marked and frees
  without moving or drawing. Verified in DOS and Chromium.
- [x] Update the stage-two Electro Ball during its mount-list visit and hit
  the first overlapping main-list record. A 42-tick DOS trace compares
  steering, return, two overlapping guns, and the explosion allocation
  before the starter shot. Chromium verifies steering and return in Canvas.
- [x] Give Drone rounds their own 80-entry table, shared between seats and
  cleared on checkpoint restore. Three 64-tick stage-two DOS VGA traces
  compare entry order, partial volleys at capacity, point hits, the VGA
  damage quirk, culling, and continued flight during ship death. Chromium
  verifies regular dots and the one-column VGA mask at byte boundaries.
- [x] Allocate player mounts and Cannon overlays from the shared pool. DOS
  compares mounted slots, overlays and the entire free chain across purchases,
  sales, Nashwan loans and checkpoint reconstruction in both starting modes.
- [x] Run stage-two weapon callbacks in mount-list order. A 40-tick Super
  Nashwan comparison covers mixed straight shots, Lasers, Cannons, the Drone
  table, and reuse of the retired starter's slot. Chromium verifies that
  all four shot families render together.
- [x] Paint pooled stage-two transients in list order after the ship and
  mounted weapons. The Super Nashwan trace also compares draw callbacks,
  including tail-appended Cannon overlays and skipped dead records.
  Chromium verifies that a tail-appended credit paints over an explosion
  at their overlapping pixels.
- [x] Pool the stage-two invulnerability ring. DOS compares collection,
  first-frame paint, stacking, expiry, ordered draw callbacks and slot reuse.
  The meter draws under the actor layers; Chromium verifies both ring/explosion
  orders and that explosions cover the meter. Stacked meter levels are clamped
  to valid artwork when DOS would read beyond the sprite table.
- [x] Expire Super Nashwan after actor painting and before Drone flight. The
  extended DOS scene trace checks the final loan draws, empty meter, release
  order and first paid-loadout ticks. Chromium verifies the final weapon and
  meter pixels, including during ship death.
- [x] Paint the stage-two ship, mount list and main actor list before the
  transient pass. DOS comparisons cover the mounted Super Nashwan weapons
  and 900 ticks of egg, crawler and boss core drawing. Chromium verifies
  that the boss tiles cover both the ship and an egg where they overlap.
- [x] Scan stage-two main-list ship contact and Shades before steering and
  transient updates. DOS cases verify sprite-box edges, the first linked
  target (including marked records), and damage before invulnerability
  collection. Chromium verifies nonfatal and fatal contact and energy pixels.
- [x] Match the stage-two swarm's separate post-move contact test. DOS uses
  the bottom of the refreshed swarm box as X and twice its direction index
  as Y, against the ship's earlier bounds. Eight DOS cases cover this quirk,
  Protection, invulnerability, diving, fatal damage, ramming and expiry.
  Chromium verifies the remote hit, visible miss and energy bar.
- [x] Use the cached ship bounds for stage-two hostile rounds and pickups.
  Six DOS cases cover hit and miss edges after movement, dive gating and the
  final ascent tick, which still uses the last exposed box. Chromium verifies
  shot visibility, energy loss and collection of an invulnerability pickup.
- [x] Restore the one-tick stage-two ship flash for hostile rounds, ramming
  and swarms. DOS verifies the callback, palette-7 mask and first death frame:
  a fatal shot flashes, but fatal ramming and swarm contact do not. Chromium
  verifies solid and transparent pixels, including during resurfacing.
- [x] Follow live stage-two transient slots when a callback recycles its
  saved successor within the list. At full capacity, DOS and Chromium verify
  that a targetless Homing Missile advances its replacement blast immediately,
  frees the spent missile's slot, and still updates the trailing round.
- [x] Suppress the burst when a full-pool Homing Missile reuses its own slot.
  DOS and Chromium verify that the replacement does not draw, its slot frees
  on the next visit, and the trailing round still moves on both ticks.
- [x] Follow live stage-two main-list slots, including successors moved into
  the transient list. In a full-pool DOS fixture, a boss round that replaces
  the saved wall-gun slot advances in both passes on its first tick. Chromium
  verifies the twice-updated position and animation frame.
- [x] Share actor slots between stage-four corridor attackers, pods, drones
  and rounds. DOS verifies linked addresses, deferred release, recycled
  fractions, the launcher's retained fire counter and the drone death
  allocations, including reuse in a saturated 12-slot corridor fixture.
  The pod changes to a blast without changing address, and either arena
  defeat frees the corridor's main-list slots.
- [x] Put stage-four wall guns and hunters in the main list and rams in the
  scenery list. DOS verifies 500 additional ticks of wall/corridor slot
  ordering, gun rounds and tile writes, hunter reset and reward allocation,
  and a gun round that reclaims a ram's slot when no transients are present.
  Saturated damage callbacks and reuse with arena parts remain open.
- [x] Add stage-four foreground waves, composite attachments, supply pods
  and their drops to the linked lists. DOS compares 520 mixed ticks with
  corridor and wall actors, including aimed shots, an attachment kill,
  a supply drop and reuse in a saturated 28-slot fixture. Keep painted
  formations on the Drone impact frame and draw drops on the next tick.
- [x] Follow stage-four composite damage through a root slot reused by a
  hostile round, Cannon round, blast, supply reward or credit. DOS compares inherited
  health and flash state, the marked-versus-freed round distinction, and
  the eventual blast, score and 100-credit drop. Other replacement types,
  specialist collisions and cross-list aim carry remain open.
- [x] Check stage-four pooled ship contact before steering, in main-list
  order. DOS verifies 19 cases including inclusive edges, marked blockers,
  first-target Shades, dive, Protection, retained gun bounds and contact size,
  and the wall rams' later check against the same hull. Chromium verifies
  that fatal main-list contact does not flash, but a fatal wall ram does.
  Mixed contact now uses the linked arena slots too; contact through
  reclaimed arena slots remains unverified.
- [x] Pool stage-four straight and Cannon rounds. Mounts run after pooled
  main actors; DOS verifies original round birth order, a full pool replacing
  the wall gun's newborn shot, a lethal straight shot yielding its slot to the
  drop, and repeated hits by one surviving Cannon. Chromium verifies that
  surviving shots paint once in linked order.
- [x] Restore stage-four wall-gun hit flashes using the initial tile masks,
  even during a burst. DOS verifies both sides, clipped VGA pixels and the
  draw callback reset. Chromium verifies one-frame flashes on impact from
  a straight round and on the next frame from a Drone.
- [x] Run stage-four weapon mounts in linked order and pool Laser beams.
  DOS verifies 40 Nashwan ticks of mixed volleys, Drone positions, Cannon
  overlays, final loan paint and paid-loadout restoration. The Laser skips
  live attachments on a root hit but can revisit an attachment hit first;
  DOS also verifies the marked-successor and counted-credit stops. Chromium
  verifies extended Laser pixels and Cannon overlays on the expiry frame.
- [x] Resume stage-four area damage from the saved slot address, not a
  snapshot of the main list. DOS verifies the exact visits when an orphan
  attachment's root has moved to the transient list, when it has been
  freed, and when its death replaces the marked successor with a credit.
  Chromium verifies that the overlapping later enemy does not flash and
  the new credit paints on the hit tick.
- [x] Dispatch the inherited wall-gun and formation damage callbacks when
  stage-four area damage follows a saved successor replaced by a supply
  reward. DOS verifies retained bounds, lethal map patches and formation
  deaths, and the flash on a surviving reward or attachment. A surviving
  wall-gun hit draws its fallback tile mask once, then leaves the moving
  reward invisible. Chromium verifies the exact tile pixels and the
  replacement and attachment flashes.
- [x] Dispatch inherited hunter and corridor damage on a recycled supply
  reward during stage-four area attacks. DOS verifies hunter survival, hatch
  lookup and lethal reset, plus grouped drone survival and the marked credit
  after a lethal hit. Chromium verifies the hunter's camera-relative flash
  and delayed hatch pixels, and the visible flash or suppressed drone credit.
  Other transient callbacks remain open.
- [x] Dispatch stage-four Z through live slot addresses. DOS verifies normal
  filtering, self-reuse for the right wall gun, both hunters, a corridor ship
  and a grouped drone, and inherited damage when a pod reward takes the
  saved successor. A hunter resets its replacement credit to the hatch's
  world coordinates; the credit expires on its next transient update. A
  corridor death marks the occupant left at the source address after the blast
  and any credit are allocated. Chromium verifies the fallback wall tiles, the
  unchanged trailing enemy, and no pixels from the offscreen hunter credit or
  the marked corridor blast and credit. Other inherited callbacks remain open.
- [x] Pool stage-four Flamer plumes and Bombs. DOS compares 314 linked ticks
  across all three Flamer powers, Bomb ascent and fuse, wall-gun hits,
  counted-credit stops, and ship-death cleanup. At capacity the Bomb marks
  the last blast that occupies its slot and damages around that blast's
  position. Chromium verifies linked plume order, visible Bomb and blast art,
  and suppression of the recycled blast.
- [x] Pool stage-four Mine charges and their blasts. DOS compares 358
  stage-four ticks for both powers, the ten-charge cap, the held fuse and the
  count retained on death. A full-pool trace verifies that the Mine's blast
  hits a wall gun from the recycled position, then marks the gun's explosion
  that reuses the same address.
- [x] Pool stage-four Homing Missiles and use linked hit order for Electro
  Ball. DOS compares 294 seeker ticks, including one-slot targetless burst
  suppression, plus targeted pre-corridor population, composite skip and lock
  retention cases. A 42-tick Electro Ball trace verifies animation, steering,
  return and first-hit order with overlapping wall guns and starter rounds.
  Chromium verifies the linked missile and burst order and moving ball paint.
  New locks can select linked arena parts despite their exclusion from the
  population count. Additional recycled replacements remain open.
- [x] Link the stage-four final arena, turret rounds, explosions and counted
  credits. DOS verifies 1,000 controller ticks and mixed wall/arena firing
  and core cleanup with 21, 22 and 64 available slots. Matches retained counter
  bytes, fractions, and the explosion origin read from the old core address.
  Chromium verifies no birth-frame paint, the turret's palette-7 flash, and
  identical pixels on the late Drone kill frame, followed by blasts and
  credits in linked order. A checkpoint regression preserves the same arena
  slots, and a Cannon round is spent on the beam.
- [x] Link all twenty stage-four miniboss parts, their rounds, blasts and
  rewards. DOS verifies 1,000 controller ticks and mixed wall/miniboss fire
  and death with 22, 23 and 120 available slots. Unlike the final core, the
  miniboss marks the main list before allocating blasts and credits. Chromium
  verifies shared core/gun flash, the preserved Drone impact frame and the
  next frame's arena cleanup. The checkpoint retains arena damage.
- [x] Follow the current previous main-list slot for stage-four arena limbs.
  DOS verifies a final beam following a disabled turret's signed heading
  and a miniboss limb following a foreground actor after each original
  predecessor's slot becomes an explosion. Both cases verify the next aimed
  shot; the controller traces compare BX after every arena callback.
  Chromium verifies that the surviving beam paints at the new pose.
- [x] Route hits on the stage-four miniboss core gun through its current
  predecessor and flash the damage target and its current successor. DOS
  verifies guarded and lethal hits after the core slot is reused, and a
  core hit after the gun slot is reused. Chromium verifies palette-7 flashes
  on the relinked neighbors and unchanged blast pixels in the old slots.
- [x] Destroy the miniboss tail and follow nine live previous links. DOS verifies a
  missing limb, a full pool, and both together, including blast allocation
  and forced reverse scroll. Chromium verifies that the chain reaches the
  core gun and paints its blast without repainting the removed limb.
- [x] Preserve a final-boss turret's disabled update when its own slot becomes
  a blast. DOS verifies both turret slots: the blast follows the arena, never
  advances its first frame, refreshes the turret bounds, and preserves BX.
  Chromium verifies that the same pixels move with the blast after 24 updates.
- [ ] Follow remaining inherited stage-four damage and callbacks when slots
  are reclaimed, and verify carry across the remaining lists.
- [ ] Extend allocation/reuse to remaining projectiles, specialist effects,
  and actors in the other stages. Extend mount callback order beyond stage two
  and match the remaining HUD and scenery drawing, cross-list collision order,
  live traversal involving other actor lists, and recycled fields.
- [ ] Match remaining fixed-point arithmetic and signed/unsigned boundaries.

## 4. Original shop

- [x] Recover stage/visit-specific stock caps, wallet eligibility, unavailable
  icons, More pagination and current-stage purchase discounts.
- [x] Replace the surrounding HTML purchase layout with the original graphical
  presentation: cabinet, twenty animated slots, hatch/static effects, portrait
  and dialogue shutters, four talking-mouth strips, facial overlays, original
  pixel font, dialogue, prices, seven-digit credits, selection and EXIT/BUY/SELL.
  Sell then buy before leaving; accessible transparent DOM hotspots preserve
  keyboard and pointer/touch controls. All pixels in 36 isolated complete
  screens and 120 stock/page states compare with original VGA execution.
  Browser-tested buy/sell, pagination, insufficient/closed stock, continuation,
  genuine touchscreen purchase, mobile layout and game-only fullscreen.
- [x] Restore Colin's first- and return-visit advice, including the repeated
  final reply, payment prompt and one-eye wink. DOS verifies 40 transactions
  across both visits in all five stages. Chromium verifies touch purchases,
  input gating and the wink on the canvas.
- [x] Restore the stage-five shop greeting. DOS verifies all three dialogue
  panels, two 17-update holds and entry to selling. Chromium verifies the
  panels, frozen gameplay and input unlocking at the sell prompt.
- [x] Port the opening hand gesture (`CS:5510`), shared by ordinary and victory
  visits. DOS verifies all 35 clipped sprite draws: 12 approach, two six-update
  poses and 11 retreat. Chromium verifies both visits and the input lock.
- [x] Port per-slot flicker (`CS:5691/56b8`), icon animation pauses and shared
  static RNG. DOS verifies 48 idle ticks across both stock pages, including
  timer/cursor state and sampled VGA pixels. Chromium verifies that neighboring
  slots animate independently and redraws do not advance RNG.
- [x] Match Colin's forced eyelids through the opening press and the word
  writer's retry after painting the portrait. DOS verifies face state and
  shared RNG throughout the 35-update hand trace and all three stage-five
  greeting panels and holds.
- [x] Restore the sale quote's 47-update gesture and raised left eyebrow
  (`CS:5240/51bf`). DOS verifies the clipped poses, dialogue, resale amounts
  and RNG for a powered Laser and a Cannon. Chromium verifies the quote's
  input lock and touch sale after the price is revealed.
- [x] Lock buying during quote, payment and result dialogue. Debit and install
  only after the cash prompt, then show the receipt or advice. DOS verifies
  Speedup quote, debit, upgrade and refusal frames in stages one and five,
  including portrait RNG and final dialogue pixels. Chromium verifies the
  input lock, balance redraw and touch exit.
- [x] Match the sell-to-buy shutters (`CS:55d0/558e`), stock swap and buy
  prompt lock. DOS verifies 32 hatch draws, sampled slot/action pixels and
  portrait/RNG through the prompt. Chromium verifies input stays locked
  until the buy grid is ready.
- [x] Restore the cabinet entry in ordinary and victory visits
  (`CS:4a69/4c59/558e`): closed hold, both shutters, then stock hatches.
  DOS compares 64 full cabinet draws, the nine-tick hold and portrait/RNG.
  Chromium verifies the canvas animation and input lock.
- [x] Restore ordinary and victory departure (`CS:4b6d/4bfb/4cad`): stock
  hatches, both shutters, then the nine-tick closed hold. DOS compares sampled
  pixels and portrait/RNG through both exits, plus the 150-tick cross and
  80-tick blank victory holds. Chromium verifies touch exit to flight or Get
  Ready and the victory return to stage one.
- [x] Match the three victory dialogue panels and their 30/30/17-update holds.
  DOS compares all 99 text and portrait/RNG frames, including the first two
  lines sharing a panel and the clear before the last line.
- [x] Let a second selection of the quoted slot confirm a sale or purchase;
  empty slots leave the quote intact. DOS verifies both confirmation paths.
  Chromium verifies touch confirmation and the sale receipt's input lock.
- [x] List resale items in live mount order (`CS:5119`). Selling the forward
  gun leaves its slot empty until a Cannon installation or shop exit
  (`CS:3788/3319`). Save the real loadout, not the credit balance, before
  activating Nashwan on departure (`CS:4b9b/35f2`). DOS verifies all three
  exit loadouts; Chromium verifies the sale slot and the restored starter.
- [ ] Finish remaining purchase, sale, equipment-state and progression quirks.
  The second Homing Missile charge without a duplicate mount already matches
  the original shop when one slot remains free. Powerup picks the original
  lowest-power eligible mount in slot order (`CS:2a6e`); its shop eligibility
  uses that scan rather than DOS's misaligned `CS:50d8` scan, which refuses a
  rear-only upgrade in the verified case.

## 5. Amiga audio fidelity

- [x] Play the Amiga dive cue on entry and when the timer reaches zero
  (`007996/0063f6`). Original 68000 execution verifies natural expiry and
  early cancel; Chromium verifies both cues use the same Web Audio buffer.
- [x] Resolve recovered effects once per simulation tick in original request
  lane order (`002170–002196`). A pending lane-2 cue suppresses the standard
  shot (`00615a`); later unconditional requests can overwrite their own
  lane. Original execution verifies dispatch and independent, identical
  death voices; Web Audio allows either voice to be replaced separately.
- [ ] Identify and connect remaining specialized weapon/encounter/shop effects.
- [ ] Recover original shop and transition audio flow, including the hand
  gesture cue. DOS requests effect 8 after the 18th draw; the Amiga equivalent
  is not connected.
- [ ] Replace premixed music/effect layering with original Paula channel sharing.
- [ ] Verify replay timing, looping and relevant filter/mixing behaviour.

## 6. Validation and completion

For each translated system:

- [ ] Compare constructors, updates, attacks, damage/death and RNG against original
  execution, including boundaries, reversal and exceptional states.
- [ ] Add focused regressions that exercise the newly ported behaviour.
- [ ] Run affected tests, `npm test` and `npm run check`.
- [ ] Check real-browser rendering and gameplay; retain fullscreen, controls help,
  mobile usability and working audio.
- [ ] Update README fidelity limits and this checklist with verified results.

Before calling the whole port complete:

- [ ] Compare complete stage playthroughs, including shops, every boss, deaths,
  checkpoints, equipment progression, rewards and ending.
- [ ] Validate two-player behaviour and actor-capacity stress cases.
- [ ] Remove remaining provisional substitutes and document unavoidable
  platform/audio differences.

Original game files remain unchanged. CPU emulation is an offline verification
tool only; gameplay stays native JavaScript/Canvas.

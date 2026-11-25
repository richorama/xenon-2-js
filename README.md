# 🚀 Xenon 2: Megablast in your browser

Blast through five stages, spend your credits at Colin's shop, and see how far
you get in the harder second round. Play solo or take turns with a friend.

This is a native JavaScript and Canvas 2D reconstruction, not a DOS emulator.
A [Chromium replay using only gameplay inputs](#validate) cleared all five
stages and flew into round two. It plays through to the ending, but it doesn't
match the DOS game frame for frame.

**💾 Bring your own DOS game files.** The game decodes them locally as it
starts. They're not included in this repository, so there's no standalone
web build.

## Run

You'll need **Node.js 20+** and your own copy of the original DOS game.
Clone the repository, then copy the files into these locations:

| Where | Files |
| --- | --- |
| Project root | `XENON2.EXE`, `X2SPR.DAT`, `X2WEAPS.DAT`, `GR.DAT`, `SHOP.DAT` |
| Each stage folder (`S1` through `S5`) | `MODS.VGA`, `SPRITES.VGA`, `MAP.CMP`, `EVENTS.PC`, `EVENTSBG.PC`, `PATHS.BIN` |

From the project root:

```sh
npm start
```

Open <http://127.0.0.1:8080>. There's nothing to install or build. The server
only listens on your machine; use `PORT=8081 npm start` for a different port.

🎵 Sound is optional. See [Recovered Amiga audio](#recovered-amiga-audio) to
add the soundtrack and effects.

## 🎮 Controls

Press **Enter** or **Space**, or tap the title screen, to open the menu.
Use **Up / Down** to select a mode, then **Enter / Space** to confirm, or
tap the option directly. On **Get Ready**, press **Enter / Space** or tap
**Start Turn** to launch.

| Action | Keyboard | Touch |
| --- | --- | --- |
| Move and fire | WASD or arrows to move; Space to fire | Drag the ship to move and fire; **Hold to Fire** to fire in place |
| Dive / surface early | Shift | **Dive / Surface** |
| Pause | P or Esc (Esc exits fullscreen first) | **Pause** outside fullscreen |
| Fullscreen | F to toggle; Esc to exit | **Fullscreen / Exit Fullscreen** |
| Restart / sound | R / M | **Restart / Sound** outside fullscreen |

Tip: hold **Down at the bottom edge** to backtrack up to 16 pixels. The game
pauses if its window loses focus. If audio is installed, pausing stops effects
and lets the music resume where it left off; restarting keeps your mute setting.

### Lives, scores and two players

When you lose a life, you return to the last checkpoint with the equipment and
credits it saved. After the last life, press **Enter / Space** or tap
**Continue** before the countdown ends: you get three lives but lose your
score. You start with two continues and earn one more each time you clear the
campaign.

If you qualify for the high-score board, use **Left / Right** to change a letter
and **Enter / Space** to confirm. On touch, tap the left or right third to
change the letter, or the middle to confirm. The toolbars stay hidden during
initials entry. **High Scores** is available from the title screen; scores last
until you reload the page.

Choose **2 Player Game** to take turns on the same controls. Each player keeps
their own lives, continues, equipment and checkpoints. Losing a life passes
control to the other player unless they've already finished the stage or are
out of the game. The next stage starts once both surviving players finish.

<details>
<summary>Campaign walkthrough (boss spoilers)</summary>

**Stage one** opens Colin's shop at its original mid-level world-position trigger
(roughly two minutes in, depending on movement). Continue resumes the same stage
and equipment. Stage one continues to its original boss: damage its glowing
eye, avoid the articulated tentacle, and collect the credit burst after defeating
it. The next-stage shop waits until those counted credits are collected or expire.
Before the first shop, rotating terrain openings release segmented worms.
Each part can be destroyed individually; heads are worth 250 points and
segments 50.

**Stage two** runs its original animated hatches: large/small creatures emerge
twice, climb into position and dive at the ship; other pods open into eight-way
swarms that periodically re-aim and expire. The hatch machinery is map scenery,
not a damageable enemy, so Z clears released creatures without disabling it.
Stage two's three-eye miniboss blocks further progress. Destroy the segmented
attackers' heads to make its eyes vulnerable, attack each side from that half of
the screen, then follow the forced backscroll to its centre eye. Destroying all
three releases the camera and ten credit globes; the same-stage shop waits until
those globes are collected or expire.
After that shop, stage two continues to its 75-health final boss. Approach
upward to activate it, use backscroll to keep its mouth in view, and shoot that
weak point while avoiding downward shots and sixteen-way volleys. Its eggs hatch
into armed crawlers that repair broken arena walls. Defeating it releases twenty
counted credit globes before the stage-three shop.

**Stage three** includes retracting eight-part wall arms, attacking skaters,
wall-following crawlers and two-stage terrain turrets. Destroy a turret's lower
gun to expose its separately damageable, eight-way-firing core. Its 17-part
miniboss locks the camera at 2800: shoot its two eyes while they open, avoid its
articulated claws and aimed shots, then collect or wait out ten credit globes
before the same-stage shop. Each eye has twenty health; its body and claws are
indestructible. Its final encounter is an eleven-part worm with an 80-health
head, delayed body segments, repeated paths and eight-way fire. Its body absorbs
shots; defeating its head releases twenty counted credits before the stage-four
shop.
**Stage four** includes extending wall rams and hunters that emerge from wall
hatches. Its twenty-part miniboss locks the camera: destroy the trailing end
of the sweeping arm and four fixed guns, then backtrack to the exposed core.
Ten counted credits gate the same-stage shop. The final boss has a sweeping
beam and two turrets; destroy both turrets before attacking the core. Twenty
counted credits gate the stage-five shop.

**Stage five** adds wall patrols that launch homing enemies and three ten-ship
formations that fire rings. Its moving miniboss exposes a small core; its four
guns can be destroyed separately. The miniboss's ten credits lead back to
Colin's shop. At the final arena, destroy all eighteen defenses, then hold
**Down at the bottom edge** to backtrack if the exposed core has scrolled out of
view. Collect or wait out its twenty credits to see the victory sequence.

Afterward, the game loops to stage one with tougher ordinary enemies and a fresh
starter gun in place of the previous loadout. Health, lives and score carry
forward. Between stages of the same round, equipment also carries forward.
Entering a new stage or round resets credits.

</details>

### Shop and power-ups

The original stage-specific minimum shop balances are applied to low funds.
The shop fills the game canvas with the original cabinet, twenty animated
equipment displays, Colin, shutters, pixel dialogue, credits and action buttons.
Use arrows/WASD and Enter/Space, or tap the original displays/buttons. Select an
item to quote it, then select it again or use SELL or BUY to confirm. EXIT
finishes selling first; EXIT on the buying screen resumes flight. MORE pages
later stock when available.
Stock respects the original visit budget and your balance; a large wallet does
not unlock equipment the current visit does not stock.
Super Nashwan temporarily loans powered double shot, two cannons, two lasers,
a trailing twelve-way-firing drone and side shots. Your actual equipment is
restored after 170 gameplay ticks (about 9.3 seconds), not replaced permanently.
Supply containers also open on ship contact, costing eight energy unless protected;
a fatal hit does not open them. The Z pickup damages active enemies, including
wall guns and patrols, but not bosses, and opens remaining supply containers.
Restart resets the run. Remaining shop-sequence and equipment quirks are noted below.

## Recovered Amiga audio

The supported Amiga BS1 disk contains a custom **David Whittaker** replay driver,
not a ProTracker MOD. Supply your own archive; neither it nor the extracted
audio is included. Generated files go in `amiga/audio/`:

- `megablast.ogg`: compact, browser-playable **3:11.6 music loop**, used by the game.
- `megablast.wav`: the same preview as 44.1 kHz, 16-bit stereo PCM.
- `megablast.dw`: original replay code, sequences, envelopes and sample banks.
- `music-01.wav` through `music-20.wav`: 20 original music samples.
- `effect-01.wav` through `effect-18.wav`: 18 additional sampled effects.
- `manifest.json`: source archive, disk/executable hashes, offsets, rates and
  SHA-256 hashes for every raw sample. Raw sample names remain neutral indices.
- `sfx-*.wav` and `effects.json`: eight source-identified gameplay effects,
  rendered through the original 68000 driver, with call-site addresses and hashes.

Once `megablast.ogg` has been generated and the server is running, listen at
<http://127.0.0.1:8080/amiga/audio/megablast.ogg>.
The game uses this music and the recovered shot, small/large explosion,
pickup, credit, health, dive and player-death effects. The dive cue plays on
entry and again when the timer hits zero, including after an early cancel
(`007996/0063f6`). Nonfatal damage does not beep: the original Amiga shield-damage
routine requests no sound.
Music continues through the native shop and game-over screen; no replacement
PC-speaker tune is started. Missing audio is reported on the sound button.

To play with audio, activate a Python environment with `unicorn` installed,
then run these commands from the project root (FFmpeg must support `libvorbis`):

```sh
python tools/extract-amiga-audio.py --render --render-effects
ffmpeg -nostdin -n -i amiga/audio/megablast.wav -c:a libvorbis -q:a 5 amiga/audio/megablast.ogg
```

The default input is
`amiga/Xenon II - Megablast (1989)(ImageWorks)[cr BS1][t +3 BS1](Disk 1 of 2).zip`.
Use `--archive PATH` if your copy is elsewhere. The extractor requires the
verified game executable hash and leaves the ZIP intact. The unrelated tracker
tune in the Deejay99 crack intro is deliberately excluded. To extract only the
module and raw samples, omit both render flags; that mode uses only Python 3's
standard library.

The render flags execute the original 68000 replay routines offline; no Amiga
emulator is added to the browser. The music preview uses PAL-clock four-channel
stereo mixing at 50 Hz, stopping at the main sequence's first wrap. Intra-tick
DMA timing and analogue Paula filters are approximated, so it is not a
hardware-exact recording.
The depacker's entire 287,946-byte output was independently compared against
execution of the original 68000 depacker; all 38 exported sample WAVs reverse
back to their original signed PCM bytes exactly.

The game queues sound requests at `0414` and `0418`; the interrupt
dispatcher at `2170-2196` assigns Paula channels 2 and 1. The source shot code
is `89`, explosions `85/83`, pickups `04`, credits `05`, health `07`, dive `10`,
and death `0a` on both channels (hexadecimal). Synthesized effects retain the
driver's original envelopes, period changes and waveforms, rather than using
arbitrarily selected raw samples.

The browser requires `megablast.ogg` and all eight rendered `sfx-*.wav` files
to enable sound. `megablast.wav` is only an intermediate for the Ogg conversion,
not a playback fallback. `src/amiga-audio.js` decodes the music and effects into
Web Audio buffers. Playback loops the decoded music without
streaming-duration estimates. Each browser simulation tick dispatches the last
pending effect on each original request lane, except that a regular shot never
overwrites a pending cue. Death's two identical voices play independently,
so replacing one lane leaves the other intact. **Music is a premixed track:**
effects are mixed over it rather than stealing individual music voices as Paula
did. Browser tick batching does not reproduce the original interrupt timing
within a frame or provide hardware-exact four-channel arbitration.

## What is actually recovered

<details>
<summary>Technical reference: DOS routines, file formats and ported systems</summary>

Executable addresses below are `CS` offsets in this specific DOS executable,
after removing its `0x800`-byte MZ header. Original files are never modified.

| System | Evidence and implementation |
| --- | --- |
| Compressed `.DAT` files | `CS:011c-04f1`: adaptive Huffman coding, 4 KB LZ dictionary, custom dictionary initialization. `src/formats.js` implements the decoder. All four outputs independently match the original routine byte-for-byte. |
| VGA palettes | Data segment `1853:427d`, six RGB tables of 48 bytes, using 6-bit channel values. Table 1 is used for stage one. The palette setter is in segment `0f29`, offsets `00fc-0135`. |
| Map compression | `CS:5d09-5d26`: alternating literal-word and zero-word runs, expanding to 6,000 words. Maps are 20 columns by 300 rows of 16x16 tiles. A tile index is `word >>> 6`. |
| Background graphics | Four big-endian 16-bit planes interleaved by scanline, 128 bytes per tile. The first stage contains 338 tiles. |
| Sprite banks | 32-byte bank header; 16-byte records contain a collision box and drawing origin/width/inclusive height, followed by a mask and four contiguous bitplanes. Records align to even byte boundaries. All five level banks decode successfully. |
| Wave events | `CS:3615-3681`: unordered 14-byte records triggered by crossing the camera position. All 601 foreground records across five stages run. In stage one the records dispatch after paint and Drone damage, foreground before background. DOS verifies coincident wave, map gun and patrol births; Chromium verifies that their sprites and tiles first paint on the next frame. Later stages still dispatch earlier. `CS:3389-3528` supplies formation counts, spacing, delays and paths. Type-zero objects are destructible pickup pods. |
| Enemy templates / animations | Dispatchers `CS:70f1`, `80ca`, `abcc`, `c771`, `e475` select stage-specific templates. Sprite references and frame durations come directly from the executable, including seven-part stage-three templates. Special composite behaviour is incomplete. |
| Flight paths | `CS:4871-4a66`: native 16.16 fixed-point translation, original signed sine table at `CS:6116`, per-event substep budgets, waits, jumps, random branches, turn rates and angular acceleration. Five paths are independently checked against the original routine over 100 total ticks. |
| Supply pods | `CS:1e61`, `28df-29d6`, data `1853:31d8/31fe`: 19 reward IDs, original pickup animations and mapped effects. Shooting or surviving ship contact (`CS:4381-43b6`, eight energy) opens a container at its original position, without an invented explosion. Regular enemies explode rather than turning into upgrades. |
| Formation credits | Scheduled stage-one waves share eight credit counters. Small and large waves have separate group IDs within each four-tick window; dropping a globe requires finishing the whole registered group. Opening a pod does not decrement its group count. DOS verifies grouping, saturation, escape, unlinking, Z, and a Drone kill earning credit before a same-frame wave joins its group. Chromium verifies one globe for the final kill across two waves. Later stages still count per wave. |
| Z screen clear | `CS:2ad0-2b21` dispatches 127 damage through the main list, including pod-opening callbacks, while exempting boss types `0x50/0x54`. DOS verifies stage-one pod, formation and wall-gun order, plus terrain-worm driver retirement and corpse allocation. Chromium verifies those corpses and that a Z pickup visited before a hostile round prevents damage. The second pass clears hostile rounds without removing unrelated pickups. Supported cross-list reuse cases are listed below. |
| Stage-one stationary map guns | Background types 1-3: spawn handlers `CS:6f7f/6f00/6fe0`, updates `6d22/6ac7/6bca`, damage/death `3b76`. Both sides use recovered tiles, hitboxes, health and firing counters. DOS compares independent and linked gun/round traces, and Chromium verifies that a recycled round moves and draws on its firing tick. Large death explosions share the transient list. DOS verifies the five frames, delayed release, spent-round reuse, and raw tile writes if the gun replaces itself with a marked explosion. Chromium verifies one draw per visible frame after the ship and no draw on self-reuse. |
| Stage-one terrain worms | `CS:655b/6823/6a0a` rotates five slots across sixteen openings and animates their tiles. The driver, eleven damageable segments and two invisible guards occupy the shared pool. DOS compares all sixteen routes and a 750-tick pass for addresses, allocation, retained fractions and headings, part bounds, and exit tiles. Thirteen death traces verify corpse allocation, animation, expiry and capacity reuse. Rams, straight rounds, Cannons, Drone and Shades use the original group gate, including hidden segments and marked blockers. Straight and Cannon rounds share the corpse list; a newborn corpse draws before it starts moving, including when it reuses the killing shot's slot. Timing with the remaining unpooled actor families is still approximate. |
| Stage-one main-list targeting | Straight rounds, Cannons, Drone, Shades and pre-steering rams search the shared main list in link order (`CS:1bea/1ccc/4311`), including the stage-one boss. DOS verifies which actor wins when a gun and worm overlap in either order, marked blockers, and cached inclusive bounds for stationary guns and foreground actors. Chromium verifies the resulting gun explosion or worm corpse, and that a marked gun can block Shades without producing a blast. |
| Background patrols | Stage-one type 4 (`CS:705b/6e2c`) and stage-two type 3 (`8018/7e87`): original vertical patrol ranges, side-specific sprites, proximity/RNG triggers, three-shot fans or single shots, health and scores. Firing patrols keep their slot when they move to the transient list and leave main-list targeting. Stage one's firing animation removes the actor; stage two holds its final frame. DOS verifies stage-one linked draw and update order, later shots reading the recycled patrol slot at capacity, and pooled death explosions with and without reuse. Chromium verifies the patrol's paint order before and after firing, plus its visible and suppressed death blasts. |
| Stage-two hatches and creatures | Background types 2/4/5 (`CS:7fdb/80a3/80bb`): source tile-opening sequences, trigger positions, repeat counts, eight-way burst positions and RNG. `CS:830c` supplies large/small pursuit and diving, original animations, six/four health and 300/150-point rewards; `85d0` supplies short-lived, zero-score swarms, quantized homing and source movement vectors. Map-only emitters update after actors/pickups and remain outside Z's damageable list. Sixteen emitter scenarios and 32 isolated creature traces independently match original execution, including reversal, animation/bounds and expiry. |
| Later-stage side guns | Stage-two type 1 (`CS:7f82/7dde`), stage-three type 4 (`a40f/ab25`), stage-four type 1 (`c5c3/c61a`) and stage-five type 2 (`e35a/e3b3`). Original firing counters/chances, animation tiles, health, hit boxes, bullet directions/speeds and death tiles; stage five also animates its projectiles. Both sides match 256 original updates per gun and original damage/death handlers. |
| Stage-one boss | `CS:714d-758e`: original tile body and animations, vulnerable eye, eight articulated arm segments, indestructible tentacle, source-quantized aiming, firing cadence, movement phases and camera limits. Two 1,200-tick traces compare arm motion, damage-dependent eye animation, RNG and shots. DOS verifies the reserved core, arm links and bounds, mixed foreground fire, draw order and cleanup in the shared actor pool. The death callback prepends 20 explosions, appends 18 counted credits and clears only the main list, preserving tip shots. See the hit-flash and arm-slot checks below. |
| Stage-two miniboss | `CS:7f32`, `80f5-830b`, `866d-89ad`: three 12-health eyes, player-side and head-busy vulnerability, original eye/light tiles, two-sided 12-segment attacks with two health per part, source flight paths and terrain masking. Head deaths release the busy bit; custom corpses retain their original animations, motion and zero score. Destroying both side eyes forces reverse scrolling toward the centre; the final death clears the source map region, creates 40 large explosions and ten counted credits, then requests a same-stage shop through the last credit's callback. All 16 formation entries, eye/light traces, 32 damage states, corpse traces, death RNG and the shop flag are independently compared with original execution. |
| Stage-two final boss | `CS:89ae-8c84`: tile body, mouth-only damage, player-world activation, movement/wait phases, mouth/fin animation, white hit flash, animated downward shots and sixteen-way volleys. `83bd-85cf` supplies invulnerable eggs, hatching, eight-direction crawler animation/turning, route nodes, aimed fire and 30-point deaths. `8c85-8e00` supplies 44 destructible/repairable arena cells. Independent original execution compares 7,200 controller ticks, 16 egg scenarios, 8,000 crawler ticks and 132 terrain cases. Death at `8745` clears main actors but preserves hostile bullets, creates twenty counted credits, and opens the stage-three shop after their countdown. Death/reward RNG and the end-level flag also match. |
| Stage-three ordinary background encounters | Types 1/2/5/6: `CS:a1d2/a5a4/a613/a656` supplies eight-part arms, one shared 12-health pool, proximity-triggered extension/retraction, gated tip animation and one 400-point chained death. `a33f/a689/a7b4` supplies six-health, 300-point skaters, attack pauses and original fixed-point projectiles that turn at x128/192. `9db3/a469` supplies three-health, 100-point crawlers with eight terrain-following states, corner handling and quantized aimed fire. `a3bf/a7df/a8d4/a9cf/aa9e` supplies 24-health lower turrets and 24-health cores, 500 points per destruction, map animation/removal, white tile flashes and eight animated core shots. Independent original execution verifies 72 actor traces, eight damage/death scenarios and 20 projectile traces, including reversal, boundary cases, RNG and terrain changes. |
| Stage-three miniboss | Background type 3, `CS:a0e5-a1d1`, constructs seventeen ordered components. `9e32-a0e4` supplies path-84 body movement, two independently animated 20-health eyes, sixteen-energy contact, articulated claws, directional tip frames and animated quantized aimed shots. Body/claws absorb shots; closed eyes and their first opening tick reject damage. `9f1c` supplies shared white flash, dead-eye artwork, seventeen chained large explosions, 1,000 points and ten counted credits before the same-stage shop. `9a99` supplies the 2800 camera lock, presence-latch release and reverse limits. Independent execution compares 4,000 complete 17-part update ticks across four eye-health profiles and both final-death orders, including fixed-point state, animation, bounds, shots, RNG, effects, credits and floor release. |
| Stage-three final boss | `CS:9a99-9d4c` supplies the eleven-part worm: camera-208 activation, cumulative path delays, seven appearances, rotating path selection, directional animation, 80-health head and eight-way speed-12 shots. `9d4d` supplies shared white flash, main-list cleanup and twenty random large explosions; the next controller tick creates twenty counted credits before the stage-four shop. Terrain overlays draw above its body. Independent execution compares 12,600 complete controller ticks, four damage/death cases and eight projectile lifetimes. The browser fixes the held first projectile frame as documented below. |
| Stage-four wall encounters | `CS:c368/c3ea` supplies hatching hunters with reset, chasing, health, hatch overlays and a 100-credit reward. `c1f3/c230/c2d5` supplies scenery rams with six-tile extension, retraction, animated tips and six-energy contact. DOS compares 40 isolated traces and 5,003 ticks, plus 500 shared-pool ticks covering burst guns, hunters and rams. At capacity a gun's shot can replace the ram and move on its firing tick. `CS:c746` flashes the gun's initial tile pose even during a burst; original VGA pixels match on both sides, and Drone hits flash one frame later in Chromium. |
| Stage-four timed corridor | `CS:b555` restricts reverse scroll and spawns attackers every 16 ticks, switching sides every 32. `b613/b6eb/b80d/b899` provide angled fire and pods that release path-following drones before exploding in place. DOS compares 1,798 corridor-only ticks, including linked addresses, retained shot fractions and launcher fire counters, the drone's 50-credit drop, and saturation with 12 available slots. Wall actors and foreground waves share those slots. |
| Stage-four foreground slots | `CS:3389/37ca/480b` constructs and updates linked waves and their attachments. DOS compares 520 ticks alongside the corridor and walls and checks attachment damage after the root becomes a hostile round, Cannon round, blast, supply reward or credit. A marked hostile round still flashes while linked, but an unlinked round does not. Lethal Drone hits preserve the already-painted formation and show drops next tick. Other root replacements, cross-list aim carry and reuse with arena parts remain approximate. |
| Stage-four ship contact | `CS:4311` checks the prior main-list bounds before steering and stops at the first overlap, even for marked slots or Shades. The burst guns retain the previous slot occupant's contact size; wall rams check the cached hull later. DOS compares 19 cases, and Chromium verifies palette-7 hull flashes, including the distinction between fatal main-list contact and fatal wall rams. Both arenas use the same linked bounds search. |
| Stage-four player rounds and mounts | Straight, Cannon, Laser, Flamer, Bomb, Mine and Homing Missile rounds share the transient pool with hostile rounds and drops. DOS verifies wall fire before mount fire, round reuse at capacity, persistent Cannon hits and the Laser's composite-target order, including resuming at a marked transient slot that a killing hit changes into a credit. A supply drop that takes the saved successor can inherit wall-gun, formation, hunter or corridor damage. Chromium verifies the wall-tile mask, formation attachment flash, the hunter's camera-relative reward and hatch, and the grouped drone's flash or suppressed credit. Specialist traces compare Flamer drift, Bomb and Mine fuse and blast reuse, the Mine's ten-charge cap, Homing's pre-corridor target count and retained locks, and Electro Ball steering and first-hit order. A 40-tick Nashwan trace checks linked mounts, mixed volleys, Cannon overlays, Drone and paid-loadout restoration. Chromium verifies linked weapon, blast and recycled credit paint and the final loan frame. Other inherited transient damage callbacks remain approximate. |
| Stage-four Z | `CS:2ad0` follows saved live addresses, exempts both arena types, and marks only hostile rounds in its transient pass. Twelve DOS fixtures cover normal filtering and slot reuse by wall guns, hunters, a corridor ship, a grouped drone and foreground waves. A recycled hunter credit resets to the hatch's world coordinates and expires on its next update. Corridor deaths mark whatever occupies the source address after blast and credit allocation. Chromium checks the fallback death tiles, the untouched trailing enemy, and the invisible hunter and corridor replacements. Other inherited callbacks remain open. |
| Stage-four miniboss | `CS:c12c/bdd5-c12b` appends twenty shared slots for articulated arms, aimed/ring fire, four guarded guns and the shared core, with tail-triggered reversal. `bcab-bdd4` marks the main list, allocates linked explosions and ten counted credits, clears the arena terrain and snaps the camera. DOS compares 1,000 ticks, both guard-death orders, and mixed firing and cleanup with 22, 23 and 120 available slots. Hits on the core gun follow the current previous slot, damaging it and flashing it and its live successor. DOS verifies relinked gun and core hits and lethal cleanup. Chromium verifies deferred arena paint, the normal and relinked flashes, and the unchanged lethal Drone impact frame. |
| Stage-four final boss | `CS:bc00/ba27-bbff` appends all nineteen parts to the shared main list: two 50-health turrets, a guarded 100-health core and a sixteen-part sweeping beam. Turret rounds share the transient slots with wall fire. `CS:b8f8/b930` clears the main list, appends twenty counted credits, and reads the old core slot to place the explosions. DOS compares 1,000 controller ticks, both turret-death orders, and mixed firing and cleanup with 21, 22 and 64 available slots. Chromium verifies deferred arena paint, the turret flash, unchanged pixels on a late Drone kill, and linked blast and credit paint on the next frame. |
| Stage-four arena limb reuse | `CS:bebc` follows the current previous main-list record. DOS verifies a miniboss limb following a foreground actor and a final-boss beam following a disabled turret after their original predecessor slots become explosions. Both cases compare fixed-point motion and the next aimed round; the controller traces also compare the `BX` register after each arena callback. Chromium verifies the beam's new paint position. Inherited damage callbacks and carry across other list transitions remain open. |
| Stage-four arena death reuse | `CS:bcab` destroys the miniboss tail and nine records reached through live previous links. DOS verifies the relinked chain and allocation when a limb slot has already been reclaimed and at capacity. `CS:b930` can replace a final turret with its blast, then install the turret's disabled update on that blast. DOS verifies both sides, including the fixed frame, movement and bounds. Chromium verifies the additional core-gun blast and pixel-for-pixel movement of the turret blast. |
| Stage-five barriers and turrets | `CS:dd7f` builds three-part barriers that collapse when either post is destroyed. `df97` supplies eight-way animated bursts, and `e138/e126` supplies swivel timing, aimed shots and the two tagged-turret death flags. Original execution compares 66 traces and 8,668 ticks, including damage, flashes and neighboring map tiles. |
| Stage-five formations and patrols | `CS:d0f1/d1b9` supplies paths, staggered formations and eight-way volleys. `d286/d38c/d3fa` supplies two-sided wall travel, homing spawns and timed expiry. Original execution compares 36 traces and 8,236 ticks. |
| Stage-five miniboss | `CS:d963-dd7e` supplies the moving body, independently damageable guns, core, extending beam and two homing spawns. Destroying the core clears the arena for 1,500 points and ten counted credits before the same-stage shop. Original execution compares 1,100 ticks, including attacks, death and rewards. |
| Stage-five final boss and victory | `CS:d4a8-d962` supplies the rebuilt arena, eighteen defenses, hatches, tracking enemies, upward beams and gated core. Destroying the core clears the room and releases twenty counted credits. Original execution compares 1,405 arena ticks through destruction. The victory presentation uses the three lines from `DS:3796/37b1/37d8` and the cross and blank holds from `CS:4c25-4c44`. |
| Boss credit burst | `CS:15e4/28df`: nine pairs of 50/100-credit globes after stage one, ten pairs after stage two, original homing/circling/falling states and countdown before the next-stage shop. Original-machine traces compare three complete reward trajectories. |
| Player controls and reverse scrolling | `CS:44f3-45f3` and `3e1a-3f00`: integer movement, speed upgrades, banking inertia, bottom-edge reversal and a moving 16-pixel backtracking ceiling. Supports the miniboss's negative default scroll, upper-edge forward scrolling and original acceleration relative to that default. Three speed settings independently match 256 original ticks each in both normal and forced-reverse modes. |
| Checkpoints, death and continues | `CS:35ce/195b` supplies checkpoint snapshots, the two distinct event re-entry bounds and Y=176 ship placement. `CS:c12c/d4a8` supplies the two arena overrides. `CS:1264/3c01` supplies the ship's death frames, and `CS:3f13/5c0f` supplies two timed continues with three lives and a reset score. The original executable verifies all 39 checkpoint snapshots, both arena overrides, the restore values, death frame sequence and 79 countdown updates. Chromium verifies deaths, checkpoint respawns, acceptance and expiry. |
| End-of-run screens | `CS:5926/59c8/5c0f` supplies the game-over scene, high-score entry and original countdown. DOS compares 66 indexed frames and shared RNG, including the return to attract mode after the last active player's 30-frame Game Over. The score board is available from the title screen. |
| Attract mode and selection | `CS:5863/5b21` supplies the planar logo, six timed credit pages, high-score loop and three menu rows. DOS compares 33 full indexed frames, the frontend palette, RNG, row wrapping and music state. Chromium verifies keyboard and fullscreen touch selection. The menu music option uses the same browser audio toggle as the toolbar. |
| Stage entry and campaign cycling | `CS:40a7-416f` advances the stage. Victory grants an extra continue, increases difficulty, and replaces the completed loadout with a fresh starter gun. `CS:1aaf/195b` clears the wallet and respawns at Y=176. DOS execution verifies four transitions and ordinary enemy health in rounds 1, 2 and 7. Chromium verifies automatic stage-one re-entry after the victory holds. |
| Alternating two-player play | `CS:1a19/1a65/40cb` switches player records and maps, restores the incoming checkpoint and gates stage advancement. Both players get their own victory credit; the campaign round advances once. DOS verifies player swapping, six handoff cases, stage/victory gates and 10 full get-ready frames. Chromium verifies controls, death and continue handoffs, both shop exits and synchronized stage progression. |
| Early rear gun | The first four stage-one pods give speed, speed, power, then rear shot. `CS:3835` supplies its `(0,+18)` muzzle offset and `(0,+9)` velocity. Original attachment sprite 72 replaces the incorrect mine artwork; `CS:12c4` selects dedicated projectile masks rendered in palette colour 7 by `0f29:114a`. |
| Rear attachment and first shop | `CS:3835-385a` anchors the rear gun to the ship, not 13 pixels forward, and advances the idle/firing sequence at `CS:12f8`. `CS:655b-658a` opens the stage-one shop once when camera plus player Y is below `0x0a80`, snapping camera/reverse ceiling to `0x09c0`. `CS:3fcc-403b` supplies stage-specific minimum credits plus the original random increment. These routines are independently compared against original 8086 execution. |
| Cannon | `CS:3246` uses four offsets from `1853:30a8` to mount the cannon along the side of the ship. `CS:246d/28b8` supply recoil, a one-tick firing delay and animated rounds that travel ten pixels per tick and deal two damage to the first overlapping target per tick. The purchased and Nashwan cannons share this implementation. Original execution verifies 200 paid-cannon ticks with held fire and taps, including projectile bounds and repeated hits. |
| Equipment mounts | Original constructors and updates supply the shared auxiliary offsets, on-ship sprite sequences, and trailing Drone and Electro Ball. Side Shot, Bomb and Homing Missile have no idle ship attachment. `CS:250b` supplies the Missile Launcher's opening animation and two animated rounds; `CS:4fe3` and the item constructors verify placement and eligibility across 24 purchase and pod loadouts. |
| Shop and inventory | Original labels, prices and mount flags at `1853:384d/3866/38ce`; seven weapon slots, power caps, health/speed/autofire upgrades, dive charges, temporary bonuses, advice and extra lives. `CS:5309-5311` gives `(base + 2000 * power) / 2` resale pricing; `CS:5231-5238` halves purchase prices in stage five. |
| Original graphical shop | `0f29:1955/1f4c` supplies the cabinet and framing; `1afa/1d01/1cc4` supplies Colin, four mouth strips and shutters. `CS:56b8/5835` supplies hatches, animated stock and seven portrait decorations; `5435/5488` supplies the cursor and original action buttons. `0f29:1ea2/1716` supplies the four-pixel font and seven-digit credit counter. `CS:4d38/4e29` supplies stock caps, wallet eligibility and pagination; `5154/4e78` supplies sell-then-buy interaction. `src/shop-screen.js` composes palette-zero pixels in the existing game canvas, with invisible accessible button hotspots. All pixels in 36 isolated complete shop frames and 120 stock/page states independently match original execution, including text, mouth variants, shutters, hatches, icons, both pages and button selection. Remaining sequencing limitations are below. |
| Laser and Drone | `CS:237e/23ed` supplies growing and detaching beams that deal 3/6/9 damage across widths of 8/12/16 pixels. `CS:221a` launches 4/8/12 radial shots at held-fire intervals from the three-position trailing Drone. Paid and Nashwan weapons share code. Original execution verifies 300 paid-weapon firing ticks and 18 beam lifetimes across all powers. |
| Electro Ball and Bomb | `CS:229b` uses held fire to steer the Electro Ball with the ship and returns it to its trailing mount on release. It deals four damage to the first overlapping target per active tick. `CS:3872/262d` sends a single Bomb up from the ship, then detonates it for eight damage in a 64×64 square with four randomized explosion sprites. Original execution verifies 480 Electro Ball ticks and 360 Bomb ticks. |
| Flamer | `CS:213c/399c` emits two animated plumes on every held-fire tick, independent of autofire. One plume deals 1/2/3 damage to the first overlapping target; the other is visual only. Original execution verifies 1,080 ticks of animation, RNG, fixed-point drift, bounds and damage. |
| Mine and Homing Missile | `CS:2697/275d` supplies the Mine's steerable mount, spaced charges and ordered detonation after release. `CS:3900/1ff3` supplies the Homing Missile's four rockets, pause, RNG target selection, discrete steering and point damage. Original execution verifies 960 Mine ticks and 480 Homing Missile ticks. Exact target selection still depends on shared actor order. |
| Foreground attacks | `CS:480b/1ed3/1f4d` supplies the byte fire counter, eight fixed-point trajectories, stage-specific sprites and projectile bounds. The browser corrects the original aimed branch's unrelated `BX` operand to use the player Y difference; see the intentional fixes below. Corrected DOS execution compares direction, ordered projectile records, fixed-point positions and RNG across mixed callbacks and 1,600 firing ticks. `CS:9a2b` chooses a directional entry pose in stage three. Six entry poses and 45 projectile flight cases are also verified. DOS and Chromium verify pre-steering ship contact in all five stages. |
| Foreground composites | `CS:37ca` animates the stage-one/stage-four attachments at the root position. `CS:99fb/9a03/9a0b` moves each stage-three worm segment along its delayed path and selects its heading sprite. `CS:3a39` routes part hits to the root and releases the whole group with one original explosion. Six formation traces verify pose, escape, death, score and credits. Chromium verifies the parts and death in all three stages. |
| Stage-one foreground slots | Formations and their attachments run in the shared main list. DOS verifies linked poses, cached bounds and retirement, including the saved successor becoming a shot that advances twice on its birth tick. A surviving attachment follows the root slot through a shot's flight, unlinking and reuse by a blast. Hits through the surviving attachment still deduct inherited health when a hostile round, blast, pod reward, credit or Cannon takes the root slot. DOS and Chromium verify that a marked hostile round flashes while linked, the freed round does not paint, and a killing hit still awards score and a credit. At capacity the credit can reuse the killing shot's slot. Other root replacements remain open. |
| Stage-one hit flashes and Drone paint | DOS verifies palette-7 flash masks for both parts of a composite and four boss tile poses, plus the normal draw callback reset. A Cannon round striking an arm is spent without flashing it. A Drone hit tests a point after the actor paint pass: its flash, death art and new drops first appear next tick. DOS compares the composite and wall-gun draw order; Chromium verifies that a lethal hit leaves the impact frame's playfield pixels unchanged for both targets and the boss. |
| Stage-one boss arm slots | DOS and Chromium verify that a surviving arm follows its parent's slot after reuse by a hostile round, explosion, pod reward, credit, forward or left shot, or Cannon. An explosion keeps the old motion budget, and an unlinked replacement leaves its last position. Straight shots write horizontal velocity into the heading word; an ordinary credit writes a raw RNG word. Both can index outside the sine table before the first heading wrap. The port reads those bytes from the on-disk executable; lookups that land on runtime-patched or relocated bytes are not matched. |
| Stage-one Z at capacity | Z follows the saved successor address into the transient list when a pod reward takes its slot. DOS and Chromium verify lethal and flashing hits for inherited single-part and composite formation callbacks, plus lethal hits for wall guns and patrols. The wall gun writes death tiles from the recycled blast's animation cursor. The trailing formation is skipped, and marked rewards and blasts do not paint. Other recycled target families remain open. |
| Pod and credit pickups | `CS:28df` moves each drop toward screen center, then through an orbit and out the bottom. Collection tests its animated sprite against the ship's pre-steering bounds and is disabled during a dive. DOS verifies flight, animation and expiry for all 19 pod rewards. DOS and Chromium verify collection edges in all five stages and both counted credit values. Pooled stage-one and stage-two pod and boss drops inherit the previous actor's direction when that field is tracked. Collecting any credit or letting a drop fall off-screen advances the global boss-credit countdown; collecting a pod reward or losing a globe to slot reuse does not. Reuse beyond stage two remains open. |
| Diving and resurfacing | `CS:3dbd/4311/4675` supplies four dive poses, a 136-tick timer before ascent, and early ascent on a second press. The fully submerged ship is drawn behind the terrain. The hull mask from `CS:1e29` determines whether resurfacing can rewind to a safe position or costs a life. Verified against six DOS input traces, two recovery outcomes, and 1,600 terrain samples. |
| Equipment posture | `CS:47a9` repositions mounts using signed sprite-center arithmetic and hides them at posture sixteen. Mount animation continues while hidden; mounted attacks wait for posture zero, whereas the basic gun uses the dive phase. Start and checkpoint restore use an eight-step posture (`CS:1831/1a87`). DOS compares 305 mount updates across five loadouts; Chromium verifies drawing, hiding, resurfacing and checkpoint fire gating. |
| Invulnerability and Shades | `CS:2b80/1fb4/47a9` supplies the two-frame ring; pickups add time without restarting it, and the timer pauses until the ship is fully exposed. `CS:4356` replaces normal ship contact with a first-target, 127-damage search when Shades is active and the ship is not diving. DOS verifies 580 ring ticks and six Shades cases; Chromium verifies the ring and in-game meters. |
| Protection | `CS:2abe/3c4f` enables persistent half damage, rounding down per hit. `CS:403e` clears Protection on entering the next shop. Ordinary hits no longer grant an invented immunity period. DOS execution verifies repeated hits, counted-credit immunity, the fatal boundary and the shop reset. |
| Super Nashwan | `CS:4f96` sets 170 ticks; `2b22` saves real equipment and constructs a seven-mount loan; `46e4/472d` expires it and restores that equipment. The loan uses animated cannons, nine-damage lasers and twelve-way Drone volleys. `src/nashwan.js` preserves shop/pause suspension and restoration. Original execution verifies 300 weapon-update ticks and three expiry/restoration cases. |
| Amiga audio | The BS1 executable's custom David Whittaker replay module supplies Megablast and source-mapped effects. Original 68000 routines are executed offline to generate browser-playable audio; no emulated CPU runs in the browser. See the audio section for mixing limitations. |
| PC-speaker reference | Segment `14b9`, offsets `0145-040c`: native two-channel sequencer, arpeggios, vibrato, slides and effect modulation. Both tunes and all 26 effect descriptors are checked against 221,184 original driver ticks. Retained in `src/audio.js` and tests for research; no longer used for game playback. |

`src/game.js` combines those recovered systems with the main game loop:
shooting, shields, lives, collision, diving and scoring.
`src/renderer.js` draws the decoded graphics without extracted image files.
`src/shop.js` manages inventory and transactions; `src/shop-screen.js` supplies
the graphical shop. `src/nashwan.js` implements the temporary Super Nashwan
loadout; `src/weapons.js` implements the recovered weapon behavior.

</details>

## Intentional fixes to original DOS bugs

The browser port corrects these three confirmed DOS bugs by default. These are
intentional differences from the supplied executable, not fidelity gaps. Original
game files remain untouched; equivalent bugs in the Amiga version have not been
established.

| Bug and original evidence | Browser correction |
| --- | --- |
| Stage-two boss death: the credit helper clobbers `DI`, so `CS:8762` reads a map word at `DS:11ce` instead of the boss's Y. All thirty large explosions appear offscreen. | Capture the boss's world Y before creating rewards and subtract the current camera position. The thirty explosions now cover the boss's body, retaining their original spread, allocation order and RNG calls. |
| Foreground aiming: `CS:4848` calculates the player Y difference in `DX`, but the direction helper reads unrelated `BX` state from earlier movement/drawing callbacks. | Aim using both actual player-coordinate differences in all five stages. Keep the original eight-direction quantization, firing cadence, random-fire branch and projectile speed. This can change combat difficulty. |
| Stage-three worm projectiles: `CS:9cbf` initializes the animation timer from the sprite pointer at `CS:971e`, rather than the following duration word. The first frame remains held. | Play the recovered four-frame sequence at two gameplay ticks per frame, looping every eight ticks. Movement, damage and expiry are unchanged. |

Regression tests cover boss/camera movement and unrelated map data, aiming above,
below and to either side regardless of earlier callbacks, and exact projectile
animation timing through a complete loop.

The browser also guards against a duplicate campaign reward. The DOS
elimination path at `CS:1a8e-1aad` sets the stage-five ending and completion flags,
which route the waiting winner back through the `CS:40a7` completion path. The
browser shows the ending but does not award that seat another continue.

Stage-three wall crawlers and terrain turrets also retain original flag-handling
quirks: upward crawler grid checks use the same zero boundary as downward checks,
and turret animation branches test the bounds-addition flags rather than their
phase values. The native port matches those observed routines rather than
silently correcting their apparent intent.

## Fidelity limits

The campaign is playable from start to finish, but some details still differ
from DOS. See [the remaining work](PLAN.md) for the development checklist.

<details>
<summary>Detailed fidelity notes</summary>

- Menu launch and stage changes show the recovered numbered loading frame
  followed by Get Ready.
  All scheduled background event types execute: stage one 0-4, stage two
  0-5, stage three 0-6, stage four 0-5, and stage five 0-9.
  Stage one's rotating terrain worms also run outside the scheduled events.
- Chromium verified one continuous input-only run through all five stages,
  the ending and flight in the harder round. Whole-run comparison against the
  original, shared actor-pool behavior and frame-by-frame parity are still
  incomplete.
- Some pickup effects still need auditing. Ordinary terrain contact and resurfacing both use the
  recovered hull mask and can rewind recent ship positions rather than simply
  deducting health.
  Ordinary foreground projectiles use original sprite boxes and flight;
  cross-list ordering, recycled actor state and shared player/terrain collision
  still lack whole-run parity.
- Some specialized animation and death callbacks are still unported. Ordinary
  foreground attachments and worm parts now have independent poses and use
  their shared root's health.
- Stage one spans `0x1200` down to zero with its recovered boss backscroll
  ceiling, limited normal backscroll and mid-shop trigger. Stage two initially
  stops at `0x09e0` until its miniboss dies, with forced backtracking up to `0x0b40`
  for the centre eye and the source post-death camera snap. It then continues to
  its final boss, with a 288-pixel arena reverse ceiling. Stage three initially
  locks at 2800 until both miniboss eyes die and the presence latch clears; its
  reverse ceiling then advances from 2608. Its final worm activates at camera
  208 and gates the stage-four shop on twenty counted rewards. Stage four
  locks at 2176 until the miniboss is defeated; its tail forces reverse
  up to 2480 and core destruction snaps the camera to 2208. Its final boss
  activates at camera 144. At camera zero in stage five, the final arena is
  rebuilt and the camera returns to 416 with full backtracking across that room.
- The graphical shop uses recovered stock caps, wallet eligibility, pagination
  and prices. Colin uses separate advice for the first and return visits,
  with the payment prompt and one-eye wink. The stage-five shop plays its
  three-part greeting, with 17-update holds after the first two panels, before
  accepting sell inputs. Ordinary and victory visits play Colin's 35-update
  hand gesture before dialogue, with Colin's eyes shut through the first
  pose hold. When quoting a resale price, Colin raises one eyebrow and
  plays a separate 47-update gesture before showing the offer. Each stock
  slot flickers independently and pauses its icon animation while showing
  static. Purchases charge and install the item after Colin's cash prompt;
  controls stay locked through the quote and result. To confirm a quote,
  select the same slot again or use Buy or Sell. The sell-to-buy
  transition matches the 32-update hatch sequence and unlocks after Colin's
  buy prompt. Ordinary and victory visits hold the closed cabinet on entry
  before opening both shutters and the stock hatches. Departure closes the
  hatches, then the shutters, and holds before leaving the shop. The three
  victory lines keep the original 30/30/17-update holds. The hand and shutter
  sounds and some transaction details remain incomplete.
  The resale list follows mount order. Selling the forward gun leaves the
  slot empty until a Cannon is installed or the ship leaves the shop. Departure
  saves purchases and sales before the Nashwan loan, without saving credits.
  The native shop checks Powerup eligibility using the actual upgrade target;
  the DOS purchase validator steps six bytes through four-byte mount entries and
  can refuse an eligible rear gun. Pod Powerups use the original slot order.
- The fixed simulation rate is approximately 18.2 Hz. The PIT divisor is
  `0x5555` at `CS:5eb1`, but `CS:6010-6028` increments the frame counter only
  every third interrupt. The VGA page flip (`0f29:131e`) waits on that counter.
  Rendering remains synchronized to the browser's refresh rate.
- Foreground constructors and path branches share the original LCG with other
  game systems, but differences in update order can still change its sequence.
  Scheduled foreground waves in all five stages share the original eight credit
  counters, grouped by enemy size and four-tick window. Their camera events
  run after the actor passes, so births don't change the already-painted
  frame, even when a new actor reuses an occupied slot. DOS checks mixed wave,
  gun, scenery and arena births; Chromium checks both the birth frame and
  subsequent paint. Stage five's final arena installs its terrain, snaps
  the camera and saves the checkpoint immediately, but the birth frame still
  shows the old viewport. Two stage-three worm waves in the same group award
  one 100-credit globe after both are destroyed.
  Separate foreground and background camera limits preserve file order and
  prevent replay while reversing. Checkpoint re-entry admits only its original
  foreground and background bands.
  Stage-two Drone impacts likewise leave the already-painted gun tiles intact;
  the palette-7 flash or the destruction tiles and blast show on the next frame.
- Stage-two hatchlings take their wobble phase from a reusable slot in the
  original 159-record address range. The two seats share the pool. Ship HUD,
  equipment and Cannon overlays use the original records; the DOS checks
  include sales, Nashwan swaps, and the reuse order on checkpoint restore.
  Stage-two foreground
  enemies, wall guns, patrols, their rounds, map hatches and hatchlings use it
  in play, as do credit globes, pod rewards and standard explosions. Stage two
  also reserves the boss and eye controllers up front and pools the miniboss
  waves and corpses, the final boss's eggs, crawlers, and rounds, and the
  player's forward, rear, side, double, Missile Launcher, and Cannon rounds,
  Laser beams, Bomb charges and blasts, both Flamer plumes, and Homing
  Missiles and their targetless bursts. DOS compares 1,176 ticks across these
  weapon scenes, including repeated Cannon hits, Laser area damage, Bomb
  blasts, Flamer drift, and Homing Missile locks, hits, and death cleanup.
  DOS and Chromium verify that existing missile locks follow a wall patrol
  into the transient list when it fires, without adding it to new searches.
  If a freed target slot becomes a boss crawler, the missile keeps its lock;
  if it becomes an egg, the missile searches again because eggs have no
  targetable bounds. A drifting miniboss corpse can keep its slot's old
  patrol bounds for an existing lock, but cannot be acquired by a fresh search.
  A corpse that reuses its own wave's slot at full capacity never draws or
  moves before the slot frees. DOS and Chromium verify these cases; bounds
  inherited from other actor types still need auditing.
  Chromium verifies Cannon animation, Laser growth and detachment, Bomb
  charges and blasts, the Flamer's separate visual and damaging plumes,
  and Homing Missile launches, turns, and bursts.
  At full capacity, the stage-two transient pass follows a recycled successor
  slot within the list. DOS and Chromium verify the targetless missile case:
  the replacement blast advances immediately, the spent missile's slot frees,
  and the following hostile round still moves. If the missile instead reuses
  its own slot, the burst is not drawn and the slot frees on the next visit.
  The main pass also follows a saved slot into the transient list: in a
  full-pool fixture, a boss round replacing a wall gun moves and animates
  in both passes. Traversal involving the other lists remains incomplete.
  Another 358 DOS ticks cover both stage-two Mine variants, including shared
  charge and blast slots, the ten-charge cap, staggered fuses, and the
  original count that survives checkpoint cleanup. Chromium verifies both
  Mine charge sprites and blast animations. A 42-tick DOS trace verifies
  the Electro Ball's mount-list callback, first overlapping target, and
  explosion allocation before the starter shot; Chromium verifies steering
  and return. Stage-two mounts run in list order; a 40-tick Super Nashwan
  trace compares mixed volleys, Drone flight, and the retired starter slot's
  reuse by a Cannon round. Chromium verifies all four shot families together.
  The same trace compares mounted weapon and transient draw order, including
  Cannon overlays, dead records that no longer paint, and the final loan frame
  with an empty meter before Drone flight. The paid loadout returns for the
  next tick. Chromium verifies the expiry artwork even during ship death.
  The stage-two ship and mounts draw before the main list; the 900-tick arena trace verifies
  the order of eggs, crawlers, and the boss core. Chromium confirms that
  the core draws over an overlapping ship and egg, and that a counted credit
  draws over an explosion. If a hatch reuses the egg's own slot at capacity,
  the crawler does not draw and its slot frees on the next visit, as in DOS.
  The four maneuver jets use the recovered artwork,
  bank offsets and dive gate; 48 DOS HUD ticks verify their animation and
  visibility, and Chromium verifies front and rear flame pixels. The dive and
  Shades meters paint in DOS order before the Drone; 229 original ticks verify
  the levels, empty frames and that ship death cancels only the dive timer.
  The stage-two invulnerability ring updates and draws in the transient list;
  its meter paints before the actors. DOS compares pickup birth, stacking,
  expiry and slot release, and Chromium verifies the overlapping layers.
  Stacked invulnerability uses a safe meter clamp; scenery paint timing and
  mount order in other stages are not yet matched. Firing
  patrols keep their record when moving to the transient list. That list's
  update order determines whether a Z pickup clears a hostile shot before it hits.
  Stage-two ship contact and Shades search the main list before movement,
  using the prior ship sprite bounds for contact. DOS verifies edge hits,
  marked blockers and that a fatal collision prevents a same-tick pickup.
  Stage-two enemy shots and pickups test their updated bounds against the
  ship's cached bounds, not its new position. DOS confirms the edge cases,
  including the final ascent tick, when the ship still uses its last exposed
  box. Chromium verifies shot visibility, energy loss and ring pickup.
  Stage-two swarms also test a point after moving: X is the bottom of the
  swarm's refreshed bounds and Y is twice its direction index. They test
  against the earlier ship bounds, not visible sprite overlap. Eight DOS
  cases cover this callback; Chromium verifies the remote hit, Protection
  damage, visible miss and energy bar.
  Stage-two hostile rounds, ramming and swarms flash the ship in palette
  color 7 for one tick. DOS and Chromium verify the silhouette mask and
  the flash on a fatal shot; fatal ramming and swarm contact leave the
  death sprite unflashed. Ordinary foreground shots also use the flash in
  the other stages; remaining contacts and specialist rounds are not yet matched.
  Other actors and frame-order differences can still shift slot phases relative
  to a complete DOS run.
- Drone rounds use a separate 80-entry table and keep moving during the ship's
  death animation. Ordinary rounds stop on death, including in stages three
  and five. The DOS VGA Drone routine reads `DS:3da8` instead of the
  one-point damage word in its code segment, so even one Drone hit defeats a
  full-health stage-two wall gun. Native execution matches 192 DOS ticks of
  three volley sizes, capacity, point hits, bounds, and death. Chromium
  verifies regular dots and the clipped VGA mask at byte boundaries.
- Stage-two waves and eyes update from the main list; destroyed segments get a
  separate corpse record in the transient list. Whole-frame ordering across
  player input, enemies, projectiles and map scripts is not yet identical to
  DOS, and final-boss population checks still approximate unported actors.
  Some sprite hit flashes still use opacity rather than the original white-mask
  drawing routine.
- Audio uses the recovered Amiga soundtrack and eight original effects, but
  does not reproduce Paula music-channel stealing or analogue filters. Specialized
  weapon effects, original shop audio flow and other unported events remain incomplete.

</details>

## Validate

```sh
npm test
npm run check
```

`npm test` requires the local DOS files listed above. GitHub Actions runs
syntax checks and the Python audio tests without game files; cases that need
the Amiga archive or extracted effects are skipped on a fresh checkout. To
run the same Python test command locally:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p 'amiga_test.py' -v
```

For the full local Python run, supply the Amiga archive, install `unicorn`,
and render the gameplay effects first.

Tests cover original-bank decompression hashes, binary formats and malformed
inputs, all five graphics/map banks, executable animation references, original
movement traces, formation timing, all 601 waves, shop transactions, weapon
projectiles, enemy-versus-pod drops and original audio traces.
Scene regressions cover map-gun damage/destruction across all stages, patrol
rendering and combat, fixed-point diagonal bullets, reverse-scroll limits,
event replay prevention, early rear-shot progression and the first boss's
weak point, stage-completion gate and counted-credit/shop transition.
Stage-two regressions cover the miniboss progression gate, opening-eye hits,
busy-state immunity, Z and contact callbacks, forced reversal, map destruction,
counted rewards and same-stage shop continuation. Final-boss regressions cover
activation, mouth-only damage, progression gating, single/ring shots, egg/crawler
lifecycle, wall damage/repair/contact, death cleanup and stage-three continuation.
Actor tests cover recycled hatchling slots, per-seat cleanup, pool exhaustion,
patrol list changes, Z pickup versus projectile contact order, arena
reservation and round subpixel reuse.
Stage-three regressions cover shared arm health/death, skater attacks/corridor
shots, crawler corners, two-stage turrets and Z, contact damage, and all supported
background triggers without replay on reversal. Miniboss regressions cover
event-driven construction, all seventeen components, camera gating, closed-eye
and first-opening-tick immunity, independent health, body/Z immunity,
sixteen-energy contact, chained death, delayed floor release and counted-credit
same-stage shop purchase/resume.
Stage-one terrain worm tests cover hatch animation, delayed segments, distinct
exit apertures, single-part shot damage and checkpoint cleanup.
Final-worm regressions cover delayed segments, head-only damage, reappearance,
the corrected projectile animation, death cleanup and stage-four continuation.
Graphical-shop tests cover stock, pagination, sell/buy flow, navigation,
independent slot flicker, composition and dialogue artwork. Super Nashwan
tests cover its temporary seven-mount loan, specialized attacks, trailing drone,
shop/death handling and timed restoration.
Stage-four regressions cover the wall actors, pre-steering hull contact, two
boss vulnerability gates, forced backtracking, rewards and both shop transitions.

The **331-test Node suite** includes a scripted campaign that dispatches all 601
foreground events, including legitimate replays after checkpoint restoration.
It completes the animated shop visits, buys a Cannon after stage two, uses it
against an opening stage-three formation, then verifies death and recovery with
the purchased equipment and saved wallet. It plays the actual victory sequence
and starts the harder loop. The script disables terrain collision, supplies
temporary immunity and boss hits, and places one pickup and hostile shots at the
ship for the death scenario. It is not an unassisted playthrough.

Separately, Chromium replayed 35,740 input frames from the opening through
all five stages and the ending, then flew stage one in round two to camera
4580. The score was 224,270, with 15 energy and two lives remaining. The run
used normal game inputs, including dives, shop purchases, and checkpoint
recovery. In the final arena it cleared all 18 defenses and destroyed the
exposed core, using Side Shot and the arena's backtracking room. Only the
frame clock was accelerated; no game state was injected.

Chromium checks cover keyboard and touch input, including fullscreen fire,
dive and surface. Initials entry was verified with windowed keyboard and
fullscreen touch input, with no visible HTML controls. Normal keyboard play
also reached a stage-one death,
showed the animation, played both Amiga death voices and handed off to Player
2. A separate Canvas fixture checks stage-one wall fire, Double Shot, Rear Shot
and a Cannon in two purchase orders. The wall gun allocates first, the player
mounts fire and paint newest first, and the Cannon overlay paints after the
linked rounds. The DOS comparison checks both setups over ten ticks.

For an **independent comparison against the original machine code**, install
`unicorn` in a separate Python environment and run:

```sh
python tools/verify-original.py
python tools/verify-audio.py
python tools/verify-scene.py
python tools/verify-stage-three.py
python tools/verify-stage-four.py
python tools/verify-stage-five-ground.py
python tools/verify-shop.py
```

These optional development tools execute isolated original decompression, motion,
speaker-driver, background gun/patrol, stage-one terrain worms and boss, stage-two miniboss/final-boss,
egg/crawler, arena-wall, reward and keyboard/camera routines in Unicorn, then
compare them with native JavaScript. The stage-three tool separately checks its
arms, skaters/projectiles, terrain crawlers, two-stage turrets, seventeen-part
miniboss and final worm. The stage-four tool compares wall actors, both boss
controllers, ship contact, damage and reward sequences with the DOS executable. The
stage-five tool checks barriers and both turret styles, moving wall patrols
and formations, the miniboss and final arena, and their camera triggers and
map changes. The shop tool compares 36 complete
indexed-color screens with original VGA output, 120 stock/page states,
40 advice purchases across both visits, the stage-five greeting's three
dialogue panels, holds and sell-menu entry, and 35 clipped hand sprite draws.
It also compares both 47-update resale gestures, their quote panels and prices.
Speedup purchases compare the quote, exact debit and installation frame,
receipt, and refusal in stages one and five.
The sell-to-buy transition compares all 32 hatch updates, sampled slot and
action-button pixels, the stock swap and the original buy prompt.
The cabinet entry compares 64 full draws across both visit types. Entry and
departure compare the nine-tick holds and shared RNG; departure also compares
sampled shutter and hatch pixels, and the victory cross and blank screens.
The three victory lines also compare all 99 text and portrait/RNG frames.
The hand and dialogue traces compare portrait state and shared RNG; 48 idle
shop ticks compare stock timers, icons and shared RNG.
Equipment comparisons include loadouts, paid-cannon ticks, Nashwan construction,
weapon updates, timed restoration and laser lifetimes.
For the three intentional bug fixes above, the affected tools compare against
explicitly corrected **in-memory** DOS instructions, not the unmodified behaviour:
`verify-scene.py` corrects foreground aiming at `CS:4848/484c` and reads boss Y
through preserved `SI` at `CS:8762`; `verify-stage-four.py` applies the same aiming
correction; `verify-stage-three.py` reads the duration at `BP+2` at `CS:9cbf`.
Each patch checks the original instruction bytes first. No on-disk executable is
patched, and these corrected comparisons must not be described as exact parity
with the unmodified DOS game.
Isolated routine parity is not proof of whole-game fidelity. These verification
tools are not runtime dependencies and write no extracted assets.

## License

The code and supporting files authored for this project are licensed under the
[MIT License](LICENSE). That license does not cover the original Xenon 2 game
code, graphics, music, sound effects or data, including anything extracted from
the DOS or Amiga files. Those remain the property of their respective rights
holders. Keep original and extracted game files local unless you have permission
to redistribute them.

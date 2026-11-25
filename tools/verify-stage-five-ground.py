"""Compare stage-five terrain defenses and mobile encounters with DOS execution."""

import json
from pathlib import Path
import struct
import subprocess

from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_CODE, UC_HOOK_INTR
from unicorn.x86_const import (
    UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_CS, UC_X86_REG_CX, UC_X86_REG_DI,
    UC_X86_REG_DS, UC_X86_REG_DX, UC_X86_REG_ES, UC_X86_REG_IP, UC_X86_REG_SI,
    UC_X86_REG_SP, UC_X86_REG_SS,
)

ROOT = Path(__file__).resolve().parent.parent
LOAD = 0x1000
DS = (LOAD + 0x1853) * 16
STOP = 0x1FF00
exe = (ROOT / "XENON2.EXE").read_bytes()
image = bytearray(exe[0x800:])
for index in range(struct.unpack_from("<H", exe, 6)[0]):
    offset, segment = struct.unpack_from("<HH", exe, 0x22 + 4 * index)
    position = segment * 16 + offset
    value = struct.unpack_from("<H", image, position)[0]
    struct.pack_into("<H", image, position, (value + LOAD) & 65535)


def word(cpu, offset, value=None, signed=False):
    if value is not None:
        cpu.mem_write(DS + offset, struct.pack("<H", value & 65535))
    return struct.unpack("<h" if signed else "<H", cpu.mem_read(DS + offset, 2))[0]


def call(cpu, address):
    cpu.reg_write(UC_X86_REG_SP, 0xFFFC)
    cpu.mem_write(0x9FFFC, b"\x00\xff")
    cpu.emu_start(LOAD * 16 + address, STOP, count=100000)
    assert cpu.reg_read(UC_X86_REG_IP) == 0xFF00, "Original routine did not return"


def signed(value):
    return value - 65536 if value > 32767 else value


def machine(case):
    cpu = Uc(UC_ARCH_X86, UC_MODE_16)
    cpu.mem_map(0, 0x100000)
    cpu.mem_write(LOAD * 16, bytes(image))
    for register, value in [(UC_X86_REG_CS, LOAD), (UC_X86_REG_DS, LOAD + 0x1853),
                            (UC_X86_REG_ES, LOAD + 0x1853), (UC_X86_REG_SS, 0x9000)]:
        cpu.reg_write(register, value)
    for actor in range(0xA000, 0xC000, 0x4C):
        cpu.mem_write(DS + actor, bytes(0x4C))
        word(cpu, actor + 8, actor + 0x4C)
    for sentinel in [0x8FB2, 0x8FFE, 0x904A, 0x9096, 0x90E2]:
        word(cpu, sentinel, 0)
        word(cpu, sentinel + 8, sentinel)
        word(cpu, sentinel + 0xA, sentinel)
    word(cpu, 0x8E7C, 0xA000)
    word(cpu, 0x9190, case["initialCamera"])
    word(cpu, 0x304A, case["initialSeed"])
    word(cpu, 0x9152, 0)
    word(cpu, 0x9154, 0)
    word(cpu, 0x923A, 0)
    for cell, tile in zip(case["cells"], case["before"]):
        word(cpu, cell * 2, tile)
    if case["event"][1] in (5, 6, 7, 8):
        cpu.mem_write((LOAD + 0x4489) * 16, (ROOT / "S5/SPRITES.VGA").read_bytes())
        paths = (ROOT / "S5/PATHS.BIN").read_bytes()
        cpu.mem_write(DS + 0xDE30, paths)
        for i, offset in enumerate(struct.unpack_from("<115H", paths)):
            word(cpu, 0xDE30 + 2 * i, 0xDE30 + 230 + offset)
        word(cpu, 0x8E80, 1)
    if case["event"][1] == 6:
        def audio_interrupt(_cpu, interrupt, _):
            assert interrupt == 0x80

        cpu.hook_add(UC_HOOK_INTR, audio_interrupt)
    if "constructor" not in case:
        return cpu
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
    cpu.reg_write(UC_X86_REG_DI, 0xF000)
    call(cpu, case["constructor"])
    return cpu


cases = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import { Game } from './src/game.js';
import { spawnStageFiveGround } from './src/stage-five-ground.js';
import { loadTestCampaign } from './test/helpers.js';
const campaign=loadTestCampaign(), cases=[];
const pointer=f=>(f.offset+8)|f.bank;
for(const event of campaign.stages[4].background.filter(e=>[1,3,4,9].includes(e[1]))){
  const barrier=event[1]===1, ring=event[1]===4;
  for(const mode of ['survive','left','right']){
    const game=new Game(campaign);
    game.start(5);
    const x=event[4]-8, y=event[5]-8, cell=(y/16)*20+x/16;
    const cells=barrier?[-1,0,1,2,3,4]:[-1,0,1,2,19,20,21,22];
    for(let i=0;i<cells.length;i++)cells[i]+=cell;
    if(!barrier&&mode==='left'){
      game.map[cell-1]=ring?0x2e41:0x2ec1;
      game.map[cell+2]=0x1001;
    }else if(!barrier&&mode==='right'){
      game.map[cell-1]=0x2001;
      game.map[cell+2]=ring?0x2e81:0x2f01;
    }
    const tiles=()=>cells.map(i=>game.map[i]);
    const before=tiles();
    const initialCamera=y+26, initialSeed=0x5845+x+y;
    game.camera=initialCamera;
    game.seed=initialSeed;
    const d=game.assets.groundLogic.get(event[1]);
    spawnStageFiveGround(event,d,game);
    const actors=game.ground.slice(), initialTiles=tiles(), states=[];
    for(let tick=1;tick<=210;tick++){
      game.camera=initialCamera-(tick<135?tick:270-tick);
      const {camera}=game, ceiling=tick===210?y-209:Math.max(camera+16,y-208);
      const player={x:Math.trunc(160+130*Math.sin(tick/14)), y:Math.trunc(110+65*Math.cos(tick/19))};
      const bullets=[], flashes=[];
      for(const actor of actors){
        const shot=actor.update(camera,ceiling,()=>game.randomWord(),player,tick);
        if(!actor.dead)game.patchGround(actor,actor.patches);
        for(const b of shot?(Array.isArray(shot)?shot:[shot]):[]){
          if(!game.sprite(b.frame))throw new Error('Unresolved bullet sprite');
          const direction=d.vectors.findIndex(([dx,dy])=>dx*d.bulletSpeed===b.dx&&dy*d.bulletSpeed===b.dy);
          bullets.unshift([b.x,b.y,direction,d.bulletSpeed,pointer(b.frame),
            b.frames?.[0].duration||0]);
        }
      }
      let damage=null;
      if(mode!=='survive'&&[90,91,92].includes(tick)){
        const index=barrier?(tick===90?1:mode==='left'?0:2):0;
        const actor=actors[index], amount=tick===90?1:tick===91?d.health-2:2;
        damage=[index,amount];
        if(!actor.indestructible){
          actor.health-=amount;
          if(actor.health<=0)game.destroy(actor);
          else {
            const r=actor.flashRegion(camera);
            flashes.push([r.width,r.tiles.length/r.width,r.x,r.y,r.tiles]);
          }
        }
      }
      states.push({camera,ceiling,tick,player,bullets,flashes,damage,seed:game.seed,tiles:tiles(),
        score:game.score,flags:[...game.stageFiveTurretFlags],effects:game.effects.map(e=>[e.x,e.y,e.large]),
        actors:actors.map(a=>{
          if(a.dead)return null;
          const b=a.bounds(camera);
          return [a.x,a.worldY,a.phase,a.direction??null,a.fireCounter??null,a.health,a.cell*2,
            [b.x,b.y,b.x+b.w-1,b.y+b.h-1]];
        })});
      if(actors.every(a=>a.dead))break;
    }
    cases.push({event,constructor:{1:0xdd7f,3:0xe138,4:0xdf97,9:0xe126}[event[1]],mode,
      initialCamera,initialSeed,cells,before,initialTiles,states});
  }
}
console.log(JSON.stringify(cases));
""",
], cwd=ROOT))


ticks = 0
for case in cases:
    event = case["event"]
    barrier = event[1] == 1
    cpu = machine(case)
    tiles = lambda: [word(cpu, cell * 2) for cell in case["cells"]]
    assert tiles() == case["initialTiles"], ("initial tiles", event, case["mode"], tiles())
    actors = [word(cpu, 0x9054)]
    if barrier:
        actors += [word(cpu, actors[-1] + 0xA)]
        actors += [word(cpu, actors[-1] + 0xA)]
    flashes = []

    def flash(uc, _address, _size, _data):
        width, height, x, y, tile_address = [
            uc.reg_read(reg) for reg in (UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_CX,
                                         UC_X86_REG_DX, UC_X86_REG_SI)]
        flash_tiles = struct.unpack_from(f"<{width * height}H", image, tile_address)
        flashes.append([width, height, signed(x) * 2, signed(y), list(flash_tiles)])
        sp = uc.reg_read(UC_X86_REG_SP)
        uc.reg_write(UC_X86_REG_IP, struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0])
        uc.reg_write(UC_X86_REG_SP, sp + 2)

    cpu.hook_add(UC_HOOK_CODE, flash, begin=LOAD * 16 + 0x0963, end=LOAD * 16 + 0x0963)
    for state in case["states"]:
        ticks += 1
        flashes.clear()
        for address, value in [(0x9190, state["camera"]), (0x91AA, state["ceiling"]),
                               (0x919C, state["tick"]), (0x9F12, state["player"]["x"]),
                               (0x9F16, state["player"]["y"])]:
            word(cpu, address, value)
        old_head = word(cpu, 0x90A0)
        for actor in actors:
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
        head = word(cpu, 0x90A0)
        bullets = []
        while head != old_head:
            assert word(cpu, head) == 0x14
            bullets.append([word(cpu, head + off, signed=off in (0x12, 0x16))
                            for off in (0x12, 0x16, 0x1C, 0x42, 0xC, 0xE)])
            next_actor = word(cpu, head + 0xA)
            cpu.reg_write(UC_X86_REG_SI, head)
            call(cpu, 0x07A0)
            head = next_actor
        before_damage = word(cpu, 0x90A0)
        if state["damage"]:
            index, amount = state["damage"]
            cpu.reg_write(UC_X86_REG_DI, actors[index])
            cpu.reg_write(UC_X86_REG_AX, amount)
            call(cpu, word(cpu, actors[index] + 6))
        effects = []
        new_head = word(cpu, 0x90A0)
        if new_head != before_damage:
            assert word(cpu, new_head) == 0xC
            frame = word(cpu, new_head + 0xC)
            assert frame in (0x28, 0x168C)
            effects.append([word(cpu, new_head + off, signed=True) for off in (0x12, 0x16)]
                           + [frame == 0x168C])
        actual = []
        for actor in actors:
            if word(cpu, actor) == 4:
                actual.append(None)
                continue
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 4))
            phase = word(cpu, actor + 0x1A)
            if barrier and word(cpu, actor) == 0x130:
                phase //= 4
            actual.append([
                word(cpu, actor + 0x12), word(cpu, actor + 0x16), phase,
                None if barrier else word(cpu, actor + 0x1C),
                None if barrier else word(cpu, actor + 0x48) & 255,
                word(cpu, actor + 0x24), word(cpu, actor + 0x38),
                [word(cpu, actor + off, signed=True) for off in range(0x28, 0x30, 2)],
            ])
        flags = [i for i, flag in enumerate(cpu.mem_read(DS + 0x923A, 2)) if flag]
        for key, value in [("actors", actual), ("tiles", tiles()), ("flashes", flashes),
                           ("bullets", bullets), ("effects", effects), ("flags", flags),
                           ("seed", word(cpu, 0x304A)), ("score", word(cpu, 0x9152))]:
            assert state[key] == value, (event, case["mode"], state["tick"], key, state[key], value)
    if event[1] == 9 and flags:
        free = word(cpu, 0x8E7C)
        cpu.reg_write(UC_X86_REG_DI, 0xF000)
        call(cpu, case["constructor"])
        assert word(cpu, 0x8E7C) == free, ("tagged turret respawned", flags)
        assert tiles() == state["tiles"]

print(f"PASS {len(cases)} stage-five defense traces, {ticks:,} ticks: animation, hit bounds, "
      "RNG, aiming, projectiles, flash draw calls, terrain, rewards and turret flags")


cases = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import { Game } from './src/game.js';
import { spawnStageFiveGround } from './src/stage-five-ground.js';
import { loadTestCampaign } from './test/helpers.js';
const campaign=loadTestCampaign(), cases=[];
const pointer=f=>(f.offset+8)|f.bank;
const ctor={'ring-wave':0xdc,'patrol-homing':0xe4};
const pack=(a,withBounds)=>{
  const {motion:m,definition:d}=a;
  const wave=d.kind==='ring-wave', patrol=d.kind==='wall-patrol';
  const b=a.bounds(), box=[b.x,b.y,b.x+b.w-1,b.y+b.h-1];
  if(!a.game.sprite(a.frame))throw new Error('Unresolved actor sprite');
  return [ctor[d.kind]??(a.side?0x104:0x100),m.xFixed??m.x*65536,m.yFixed??m.y*65536,
    a.age??(wave?m.remaining:0),wave?m.heading>>>16:patrol?(a.travel<0?-1:1):a.direction,
    pointer(a.frame),a.frameTicks??(a.frame.duration||0),a.fireCounter??null,a.health,
    withBounds&&b.w?box:null];
};
for(const event of campaign.stages[4].background.filter(e=>[7,8].includes(e[1]))){
  for(const mode of ['follow','reverse','damage']){
    const game=new Game(campaign);
    game.start(5);
    game.camera=event[0];game.seed=(0x5845+event[0])&65535;
    const initialCamera=game.camera,initialSeed=game.seed;
    const d=game.assets.groundLogic.get(event[1]);
    spawnStageFiveGround(event,d,game);
    const initial=game.ground.map(a=>pack(a,false)), states=[];
    for(let tick=1;tick<=300;tick++){
      const delta=mode==='reverse'?(tick<70?1:tick<260?-1:2):mode==='damage'?1:0;
      game.camera-=delta;
      game.control.delta=delta;
      game.player.x=Math.trunc(160+130*Math.sin(tick/14));
      game.player.y=Math.trunc(110+65*Math.cos(tick/19));
      game.bullets=[];game.effects=[];
      const bullets=[];
      for(const actor of game.ground.slice()){
        actor.step();
        bullets.unshift(...game.bullets.splice(0));
      }
      const damage=[];
      if(mode==='damage'&&tick===12){
        const a=game.ground[0];
        damage.push([0,a.health-1]);a.health=1;
      }
      if(mode==='damage'&&tick>=40&&tick%7===0){
        const index=game.ground.findIndex(a=>!a.dead);
        if(index!==-1){
          const a=game.ground[index];damage.push([index,a.health]);a.health=0;game.destroy(a);
        }
      }
      game.ground=game.ground.filter(a=>!a.dead);
      states.push({camera:game.camera,delta,player:[game.player.x,game.player.y],damage,
        actors:game.ground.map(a=>pack(a,true)),seed:game.seed,score:game.score,
        bullets:bullets.map(b=>[b.x,b.y,d.vectors.findIndex(([x,y])=>x*d.bulletSpeed===b.dx&&y*d.bulletSpeed===b.dy),
          d.bulletSpeed,pointer(b.frame)]),
        effects:game.effects.map(e=>[e.x,e.y,e.large]).reverse()});
      if(!game.ground.length)break;
    }
    cases.push({event,initialCamera,initialSeed,initial,states,cells:[],before:[],mode,
      constructor:event[1]===7?0xd0f1:0xd286});
  }
}
console.log(JSON.stringify(cases));
""",
], cwd=ROOT))


def members(cpu, sentinel):
    head = word(cpu, sentinel + 0xA)
    while head != sentinel:
        yield head
        head = word(cpu, head + 0xA)


def mobile_state(cpu, actor, with_bounds):
    kind = word(cpu, actor)
    values = [word(cpu, actor + off, signed=True) for off in (0x28, 0x2A, 0x2C, 0x2E)]
    return [kind, word(cpu, actor + 0x12, signed=True) * 65536 + word(cpu, actor + 0x14),
            word(cpu, actor + 0x16, signed=True) * 65536 + word(cpu, actor + 0x18),
            word(cpu, actor + 0x1A, signed=True),
            (1 if word(cpu, actor + 0x1C, signed=True) > 0 else -1)
            if kind in (0x100, 0x104) else word(cpu, actor + 0x1C),
            word(cpu, actor + 0xC), word(cpu, actor + 0xE),
            None if kind == 0xE4 else word(cpu, actor + 0x48) & 255,
            word(cpu, actor + 0x24), None if not with_bounds or values[0] == 1000 else values]


ticks = 0
for case in cases:
    event = case["event"]
    cpu = machine(case)
    initial = [mobile_state(cpu, actor, False) for actor in members(cpu, 0x904A)]
    assert case["initial"] == initial, (event, "constructor", case["initial"], initial)
    for tick, state in enumerate(case["states"], 1):
        ticks += 1
        for address, value in [(0x9190, state["camera"]), (0x9198, state["delta"]),
                               (0x9F12, state["player"][0]), (0x9F16, state["player"][1])]:
            word(cpu, address, value)
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
        call(cpu, 0x36FC)
        actors = list(members(cpu, 0x904A))
        for index, amount in state["damage"]:
            actor = actors[index]
            cpu.reg_write(UC_X86_REG_DI, actor)
            cpu.reg_write(UC_X86_REG_AX, amount)
            call(cpu, word(cpu, actor + 6))
        actual = []
        for actor in actors:
            if word(cpu, actor) == 4:
                cpu.reg_write(UC_X86_REG_SI, actor)
                call(cpu, 0x07A0)
            else:
                actual.append(mobile_state(cpu, actor, True))
        bullets, effects = [], []
        for actor in list(members(cpu, 0x9096)):
            x = word(cpu, actor + 0x12, signed=True)
            y = word(cpu, actor + 0x16, signed=True)
            frame = word(cpu, actor + 0xC)
            if word(cpu, actor) == 0x14:
                bullets.append([x, y, word(cpu, actor + 0x1C), word(cpu, actor + 0x42), frame])
            else:
                assert word(cpu, actor) == 0xC and frame in (0x28, 0x168C)
                effects.append([x, y, frame == 0x168C])
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, 0x07A0)
        for key, value in [("actors", actual), ("bullets", bullets), ("effects", effects),
                           ("seed", word(cpu, 0x304A)), ("score", word(cpu, 0x9152))]:
            assert state[key] == value, (event, case["mode"], tick, key, state[key], value)

print(f"PASS {len(cases)} stage-five mobile traces, {ticks:,} ticks: paths, ring volleys, both wall "
      "patrols, homing turns and expiry, animation, bounds and damage rewards")

cases = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import { Game } from './src/game.js';
import { stepStageFiveBeam } from './src/stage-five-miniboss.js';
import { loadTestCampaign } from './test/helpers.js';
const campaign=loadTestCampaign(), cases=[];
const pointer=f=>(f.offset+8)|f.bank;
for(const mode of ['follow','reverse','damage']){
  const game=new Game(campaign);
  game.start(5);
  const event=game.assets.background.find(e=>e[1]===5), initialCamera=event[0], initialSeed=game.seed;
  game.camera=initialCamera;
  game.miniboss.spawn(initialCamera,event);
  const boss=game.miniboss, d=boss.definition, states=[];
  const cells=Array.from({length:80},(_,i)=>(141+Math.floor(i/8))*20+6+i%8);
  const tiles=()=>cells.map(i=>game.map[i]);
  const before=tiles();
  let beams=[];
  for(let tick=1;tick<=425;tick++){
    const delta=mode==='reverse'?(tick<220?1:tick<380?-1:2):mode==='follow'?1:0;
    game.camera-=delta;
    game.control.delta=delta;game.control.ceiling=game.camera+16;
    game.player.x=Math.trunc(160+130*Math.sin(tick/14));
    game.player.y=Math.trunc(110+65*Math.cos(tick/19));
    game.bullets=[];game.effects=[];
    boss.update(game);
    const damage=mode==='damage'?({72:[0,1],90:[0,39],121:[3,40],150:[4,70],250:[4,130]})[tick]??null:null;
    const adds=game.ground.map(a=>[a.motion.x,a.motion.y,a.direction,a.age,pointer(a.frame)]);
    game.ground=[];
    if(damage){
      const a=boss.parts[damage[0]];a.health-=damage[1];a.hit=3;
      if(a.health<=0)game.destroy(a);
    }
    const bullets=[];
    for(const b of game.bullets){
      if(b.beamLength!==undefined)beams.unshift(b);
      else bullets.unshift([b.x,b.y,d.vectors.findIndex(([x,y])=>x*d.gunSpeed===b.dx&&y*d.gunSpeed===b.dy),
        d.gunSpeed,pointer(b.frame)]);
    }
    for(const b of beams)stepStageFiveBeam(b,delta);
    beams=beams.filter(b=>!b.dead);
    const actors=boss.parts.map(a=>{
      const b=a.box;
      return [a.motion.x,a.motion.y,pointer(a.frame),a.health,a.phase,a.counter,
        b.w?[b.x,b.y,b.x+b.w-1,b.y+b.h-1]:null];
    });
    states.push({camera:game.camera,delta,player:[game.player.x,game.player.y],damage,
      actors:boss.dead?[]:actors, adds,bullets,
      beam:boss.dead?null:[boss.y,boss.move,boss.beamPhase,boss.beamCounter,boss.homingCounter],
      beams:beams.map(b=>[b.x,b.y,b.beamLength,b.speed]),tiles:tiles(),
      score:game.score,seed:game.seed,effects:game.effects.map(e=>[e.x,e.y,e.large]).reverse(),
      credits:game.pickups.map(c=>[c.x,c.y,c.value])});
    if(boss.dead)break;
  }
  cases.push({event,initialCamera,initialSeed,states,cells,before,mode,constructor:0xd963});
}
console.log(JSON.stringify(cases));
""",
], cwd=ROOT))

ticks = 0
for case in cases:
    cpu = machine(case)
    for tick, state in enumerate(case["states"], 1):
        ticks += 1
        for address, value in [(0x9190, state["camera"]), (0x9198, state["delta"]),
                               (0x91AA, state["camera"] + 16),
                               (0x9F12, state["player"][0]), (0x9F16, state["player"][1])]:
            word(cpu, address, value)
        controller = word(cpu, 0x9054)
        cpu.reg_write(UC_X86_REG_SI, controller)
        call(cpu, 0x36FC)
        adds = []
        for actor in list(members(cpu, 0x904A)):
            if word(cpu, actor) != 0xE4:
                continue
            adds.append([word(cpu, actor + off, signed=off in (0x12, 0x16))
                         for off in (0x12, 0x16, 0x1C, 0x1A, 0xC)])
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, 0x07A0)
        actors = list(members(cpu, 0x904A))[1:]
        if state["damage"]:
            index, amount = state["damage"]
            cpu.reg_write(UC_X86_REG_DI, actors[index])
            cpu.reg_write(UC_X86_REG_AX, amount)
            call(cpu, word(cpu, actors[index] + 6))
        bullets, beams, effects, credits = [], [], [], []
        for actor in list(members(cpu, 0x9096)):
            kind = word(cpu, actor)
            x = word(cpu, actor + 0x12, signed=True)
            y = word(cpu, actor + 0x16, signed=True)
            frame = word(cpu, actor + 0xC)
            if kind == 0x110:
                cpu.reg_write(UC_X86_REG_SI, actor)
                call(cpu, 0xDCF5)
                if word(cpu, actor) != 4:
                    beams.append([x, word(cpu, actor + 0x16, signed=True),
                                  word(cpu, actor + 0x1A), word(cpu, actor + 0x1C, signed=True)])
                    continue
            elif kind == 0x14:
                bullets.append([x, y, word(cpu, actor + 0x1C), word(cpu, actor + 0x42), frame])
            elif kind in (0x60, 0x18):
                credits.append([x, y, 50 if kind == 0x60 else 100])
            else:
                assert kind == 0xC and frame in (0x28, 0x168C)
                effects.append([x, y, frame == 0x168C])
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, 0x07A0)
        actual = []
        for i, actor in enumerate(list(members(cpu, 0x904A))[1:]):
            bounds = [word(cpu, actor + off, signed=True) for off in (0x28, 0x2A, 0x2C, 0x2E)]
            actual.append([word(cpu, actor + 0x12, signed=True), word(cpu, actor + 0x16, signed=True),
                           word(cpu, actor + 0xC), word(cpu, actor + 0x24), word(cpu, actor + 0x1A),
                           word(cpu, actor + 0x48) & 255 if i < 4 else 0,
                           None if bounds[0] == 1000 else bounds])
        controller_state = None
        if actual:
            controller_state = [word(cpu, controller + off, signed=off in (0x16, 0x1C))
                                for off in (0x16, 0x1C, 0x1A)]
            controller_state.extend(cpu.mem_read(DS + controller + 0x48, 2))
        for key, value in [("actors", actual), ("adds", adds), ("bullets", bullets),
                           ("beam", controller_state), ("beams", beams), ("effects", effects),
                           ("tiles", [word(cpu, i * 2) for i in case["cells"]]),
                           ("credits", credits), ("seed", word(cpu, 0x304A)), ("score", word(cpu, 0x9152))]:
            assert state[key] == value, (case["mode"], tick, key, state[key], value)

print(f"PASS {len(cases)} stage-five miniboss traces, {ticks:,} ticks: body movement, nine components, "
      "guns, beam lifetimes, homing attacks and counted-credit destruction")

cases = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import { Game } from './src/game.js';
import { stepStageFiveBeam } from './src/stage-five-miniboss.js';
import { loadTestCampaign } from './test/helpers.js';
const campaign=loadTestCampaign(), cases=[];
const pointer=f=>f?(f.offset+8)|f.bank:0;
for(const mode of ['follow','reverse','damage']){
  const game=new Game(campaign);
  game.start(5);
  const event=game.assets.background.find(e=>e[1]===6), initialCamera=0, initialSeed=game.seed;
  const boss=game.boss, d=boss.definition, states=[], cells=Array.from({length:781},(_,i)=>i);
  game.map[780]=0x1001;
  const tiles=()=>cells.map(i=>game.map[i]);
  const before=tiles();
  boss.spawn(game);
  const initialTiles=tiles(), seekers=new Map();
  let beams=[];
  for(let tick=1;tick<=520;tick++){
    game.tick=tick;
    const delta=mode==='reverse'&&tick>180&&tick<300?-1:game.camera?1:0;
    game.camera-=delta;
    game.control.delta=delta;
    game.player.x=Math.trunc(160+130*Math.sin(tick/14));
    game.player.y=Math.trunc(110+65*Math.cos(tick/19));
    game.bullets=[];game.effects=[];
    for(const a of game.ground) a.step();
    boss.update(game);
    for(const a of game.ground) if(!seekers.has(a))seekers.set(a,tick);
    const adds=game.ground.map(a=>[a.motion.x,a.motion.y,a.direction,a.age,pointer(a.frame),a.frameTicks]);
    game.ground=game.ground.filter(a=>tick-seekers.get(a)<12);
    let damage=null;
    if(mode==='damage'){
      const target=tick>=130&&tick<310&&tick%10===0?(tick-130)/10+2:tick>=345&&tick<=365&&tick%10===5?20:-1;
      if(target>=0){
        const actor=boss.parts[target];
        const amount=target===20?(tick===365?8:6):actor.health;
        damage=[target,amount];actor.hit=3;boss.damage(actor,amount);
        if(actor.health<=0)game.destroy(actor);
      }
    }
    const bullets=[];
    for(const b of game.bullets){
      if(b.beamLength!==undefined)beams.unshift(b);
      else bullets.unshift([b.x,b.y,d.vectors.findIndex(([x,y])=>x*d.gunSpeed===b.dx&&y*d.gunSpeed===b.dy),
        d.gunSpeed,pointer(b.frame)]);
    }
    for(const b of beams)stepStageFiveBeam(b,delta);
    beams=beams.filter(b=>!b.dead);
    const actors=boss.parts.map(a=>{
      if(a.dead)return null;
      const b=a.box;
      return [a.motion.x,a.motion.y,pointer(a.frame),a.health,a.frameTicks,a.counter,
        b.w?[b.x,b.y,b.x+b.w-1,b.y+b.h-1]:null];
    });
    states.push({camera:game.camera,delta,player:[game.player.x,game.player.y],damage,
      actors:boss.dead?[]:actors,adds,bullets,controller:boss.dead?null:[boss.y,boss.hatch,boss.hatchCounter,boss.remaining],
      beams:beams.map(b=>[b.x,b.y,b.beamLength,b.speed]),tiles:boss.dead?tiles():null,
      score:game.score,seed:game.seed,effects:game.effects.map(e=>[e.x,e.y,e.large]).reverse(),
      credits:game.pickups.map(c=>[c.x,c.y,c.value])});
    if(boss.dead)break;
  }
  cases.push({event,initialCamera,initialSeed,states,cells,before,initialTiles,mode,constructor:0xd4a8});
}
console.log(JSON.stringify(cases));
""",
], cwd=ROOT))

ticks = 0
for case in cases:
    cpu = machine(case)
    map_tiles = lambda: [word(cpu, i * 2) for i in case["cells"]]
    assert case["initialTiles"] == map_tiles(), "Final arena initialization"
    assert word(cpu, 0x9190) == 416
    controller, *actors = members(cpu, 0x904A)
    seekers = {}
    dead_actors = set()
    for tick, state in enumerate(case["states"], 1):
        ticks += 1
        for address, value in [(0x9190, state["camera"]), (0x9198, state["delta"]), (0x919C, tick),
                               (0x9F12, state["player"][0]), (0x9F16, state["player"][1])]:
            word(cpu, address, value)
        cpu.reg_write(UC_X86_REG_SI, controller)
        call(cpu, 0x36FC)
        adds = []
        for actor in list(members(cpu, 0x904A)):
            if word(cpu, actor) != 0xEC:
                continue
            adds.append([word(cpu, actor + off, signed=off in (0x12, 0x16))
                         for off in (0x12, 0x16, 0x1C, 0x1A, 0xC, 0xE)])
            start = seekers.setdefault(actor, tick)
            if tick - start >= 12:
                cpu.reg_write(UC_X86_REG_SI, actor)
                call(cpu, 0x07A0)
                del seekers[actor]
        if state["damage"]:
            index, amount = state["damage"]
            cpu.reg_write(UC_X86_REG_DI, actors[index])
            cpu.reg_write(UC_X86_REG_AX, amount)
            call(cpu, word(cpu, actors[index] + 6))
        bullets, beams, effects, credits = [], [], [], []
        for actor in list(members(cpu, 0x9096)):
            kind = word(cpu, actor)
            x = word(cpu, actor + 0x12, signed=True)
            y = word(cpu, actor + 0x16, signed=True)
            frame = word(cpu, actor + 0xC)
            if kind == 0x110:
                cpu.reg_write(UC_X86_REG_SI, actor)
                call(cpu, 0xDCF5)
                if word(cpu, actor) != 4:
                    beams.append([x, word(cpu, actor + 0x16, signed=True),
                                  word(cpu, actor + 0x1A), word(cpu, actor + 0x1C, signed=True)])
                    continue
            elif kind == 0x14:
                bullets.append([x, y, word(cpu, actor + 0x1C), word(cpu, actor + 0x42), frame])
            elif kind in (0x60, 0x18):
                credits.append([x, y, 50 if kind == 0x60 else 100])
            else:
                assert kind == 0xC and frame in (0x28, 0x168C)
                effects.append([x, y, frame == 0x168C])
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, 0x07A0)
        finished = bool(cpu.mem_read(DS + 0x8F61, 1)[0])
        controller_state, actual = None, []
        if not finished:
            controller_state = [word(cpu, controller + off, signed=True) for off in (0x16, 0x1A)]
            controller_state.extend([word(cpu, controller + 0x48) & 255, word(cpu, 0x921A)])
            for i, actor in enumerate(actors):
                if actor in dead_actors:
                    actual.append(None)
                    continue
                if word(cpu, actor) == 4:
                    dead_actors.add(actor)
                    cpu.reg_write(UC_X86_REG_SI, actor)
                    call(cpu, 0x07A0)
                    actual.append(None)
                    continue
                bounds = [word(cpu, actor + off, signed=True) for off in (0x28, 0x2A, 0x2C, 0x2E)]
                actual.append([word(cpu, actor + 0x12, signed=True), word(cpu, actor + 0x16, signed=True),
                               word(cpu, actor + 0xC),
                               word(cpu, controller + 0x24) if i == 20 else word(cpu, actor + 0x24),
                               word(cpu, actor + 0xE), word(cpu, actor + 0x48) & 255,
                               None if bounds[0] == 1000 else bounds])
        for key, value in [("actors", actual), ("adds", adds), ("bullets", bullets),
                           ("controller", controller_state), ("beams", beams), ("effects", effects),
                           ("tiles", map_tiles() if finished else None), ("credits", credits),
                           ("seed", word(cpu, 0x304A)), ("score", word(cpu, 0x9152))]:
            assert state[key] == value, (case["mode"], tick, key, state[key], value)

print(f"PASS {len(cases)} stage-five final arena traces, {ticks:,} ticks: room construction, attacks, "
      "eighteen defenses, core damage, terrain cleanup and final credit release")

camera_cases = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {Game} from './src/game.js';
import {loadTestCampaign} from './test/helpers.js';
const campaign=loadTestCampaign(), assets=campaign.stages[4];
const path=[10,100,60,2,36,0,0,1000,0];
const xy=a=>[a.motion.x,a.motion.y];
const cases=[5,6].map(type=>{
 const game=new Game(campaign);game.start(5);
 const event=assets.background.find(e=>e[1]===type), camera=event[0], ceiling=camera+16;
 const events=type===5?[[camera,3,1,1,0,0,3]]:[];
 const barrier=[camera,1,0,0,120,camera+72,0];
 const ring=[camera,...assets.background.find(e=>e[1]===7).slice(1)];
 const background=type===5?[barrier,ring,event]:[event];
 const bytes=new Uint8Array(assets.paths.bytes.length+path.length*2);
 bytes.set(assets.paths.bytes);
 new Int16Array(bytes.buffer,assets.paths.bytes.length).set(path);
 const offsets=assets.paths.offsets.slice();offsets[0]=assets.paths.bytes.length;
 game.assets={...assets,events,background,paths:{bytes,offsets}};
 game.camera=game.control.camera=camera+1;game.control.ceiling=ceiling;
 game.foregroundEventLimit=game.backgroundEventLimit=camera+1;
 Object.assign(game.player,{x:300,y:24});
 Object.assign(game.checkpoint,{camera:4608,x:160,worldY:180,credits:700});
 game.credits=900;
 game.shipTouchesTerrain=()=>false;
 const cells=type===5?[0,1,2,3].map(i=>((barrier[5]-8)/16)*20+(barrier[4]-8)/16+i):
  [0,119,123,136,157,301,473,480,750];
 const states=Array.from({length:2},()=>{
  game.update();
  const arena=type===5?game.miniboss:game.boss, paint=game.actorPaint;
  const waves=game.ground.filter(a=>a.definition.kind==='ring-wave');
  const [enemy]=game.enemies;
  return {camera:game.camera,delta:game.control.delta,ceiling:game.control.ceiling,seed:game.seed,
   limits:[game.foregroundEventLimit,game.backgroundEventLimit],
   paintCamera:paint?.camera??game.camera,
   painted:[(paint?.enemies??game.enemies).length,
    (paint?.ground??game.ground).filter(a=>a.definition.kind==='ring-wave').length,
    (type===5?paint?.minibossParts:paint?.bossParts)?.length??arena.parts.length],
   paintTiles:cells.map(i=>paint?(paint.mapPatches.get(i)??assets.map[i]):game.map[i]),
   tiles:cells.map(i=>game.map[i]),count:arena.parts.length,body:arena.y,
   controller:type===5?arena.move:arena.hatchCounter,enemies:enemy?.age?[xy(enemy)]:[],
   waves:waves.map(a=>[...xy(a),a.fireCounter]),
   checkpoint:['camera','x','worldY','credits'].map(key=>game.checkpoint[key])};
 });
 return {event,initialCamera:camera+1,initialSeed:0x5845,ceiling,cells,before:cells.map(i=>assets.map[i]),
  events,background,states};
});
console.log(JSON.stringify({path,cases}));
""",
], cwd=ROOT))

for case in camera_cases["cases"]:
    cpu = machine(case)
    kind = case["event"][1]
    paint_kinds = (0xD0, 0xDC)
    # Both original arenas link a separate controller before the parts modeled in the port.
    controller_type = 0xFC if kind == 5 else 0x134
    paint_arena = (0x114, 0x120, 0x11C, 0x118) if kind == 5 else (0x144, 0x114, 0x13C, 0x140, 0x138, 0x50)
    painted = []

    def trace_draw(uc, _address, _size, _data):
        painted.append(word(uc, uc.reg_read(UC_X86_REG_SI)))
        uc.reg_write(UC_X86_REG_IP, 0x3716)

    cpu.hook_add(UC_HOOK_CODE, trace_draw, begin=LOAD * 16 + 0x3713, end=LOAD * 16 + 0x3713)
    for field, base in (("events", 0xD274), ("background", 0xDA9E)):
        cpu.mem_write(DS + base, b"".join(struct.pack("<7H", *event) for event in case[field]) + b"\xff\xff")
    for offset, value in [(0x9192, case["initialCamera"]), (0x9194, case["initialCamera"]),
                          (0x91AC, 1), (0x991A, 1), (0x991C, 5), (0xDE30, 0xF000),
                          (0x9F12, 300), (0x9F16, 24), (0x91A6, 4608), (0x91A2, 160),
                          (0x91A4, 180), (0x9166, 700), (0x9168, 0), (0x915A, 900)]:
        word(cpu, offset, value)
    call(cpu, 0xE4AF)
    cpu.mem_write(DS + 0xF000, struct.pack("<9h", *camera_cases["path"]))
    tiles = lambda: [word(cpu, i * 2) for i in case["cells"]]
    for tick, state in enumerate(case["states"], 1):
        painted.clear()
        word(cpu, 0x9190, state["paintCamera"])
        word(cpu, 0x9198, state["delta"])
        word(cpu, 0x919A, 1)
        word(cpu, 0x91AA, case["ceiling"] if tick == 1 else state["ceiling"])
        cpu.emu_start(LOAD * 16 + 0x3D26, LOAD * 16 + 0x3D47)
        call(cpu, 0xE4AC)
        call(cpu, 0x3682)
        paint_camera, paint_tiles = word(cpu, 0x9190), tiles()
        call(cpu, 0x36D3)
        call(cpu, 0x3615)
        main = list(members(cpu, 0x904A))
        controller = next(a for a in main if word(cpu, a) == controller_type)
        xy = lambda a: [word(cpu, a + offset, signed=True) for offset in (0x12, 0x16)]
        actual = {
            "camera": word(cpu, 0x9190), "delta": word(cpu, 0x9198), "ceiling": word(cpu, 0x91AA),
            "limits": [word(cpu, offset) for offset in (0x9192, 0x9194)],
            "seed": word(cpu, 0x304A), "paintCamera": paint_camera,
            "painted": [painted.count(t) for t in paint_kinds] + [sum(t in paint_arena for t in painted)],
            "paintTiles": paint_tiles, "tiles": tiles(),
            "count": sum(word(cpu, a) in paint_arena for a in main), "body": xy(controller)[1],
            "controller": word(cpu, controller + (0x1C if kind == 5 else 0x48)) & 255,
            "enemies": [xy(a) for a in main if word(cpu, a) == 0xD0] if tick > 1 else [],
            "waves": [xy(a) + [cpu.mem_read(DS + a + 0x48, 1)[0]] for a in main if word(cpu, a) == 0xDC],
            "checkpoint": [word(cpu, offset) for offset in (0x91A6, 0x91A2, 0x91A4, 0x9166)],
        }
        for key, value in actual.items():
            assert value == state[key], ("camera events", kind, tick, key, value, state[key])
print("PASS stage-five camera events: mixed wave and barrier births, miniboss entry, and deferred final-arena camera and tiles")

"""Compare native scenes with DOS, applying the documented bug fixes in memory."""

import base64
import json
from pathlib import Path
import struct
import subprocess

from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_CODE, UC_HOOK_INSN, UC_HOOK_MEM_WRITE, UC_HOOK_INTR
from unicorn.x86_const import (
    UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_BP, UC_X86_REG_CS, UC_X86_REG_CX,
    UC_X86_REG_DI, UC_X86_REG_DS, UC_X86_REG_DX, UC_X86_REG_ES, UC_X86_REG_IP,
    UC_X86_REG_SI, UC_X86_REG_SP, UC_X86_REG_SS, UC_X86_INS_OUT, UC_X86_REG_EFLAGS,
)

ROOT = Path(__file__).resolve().parent.parent
LOAD = 0x1000
DS = (LOAD + 0x1853) * 16
STOP = 0x1FF00
exe = (ROOT / "XENON2.EXE").read_bytes()
image = bytearray(exe[0x800:])
for index in range(struct.unpack_from("<H", exe, 6)[0]):
    offset, segment = struct.unpack_from("<HH", exe, 0x22 + index * 4)
    position = segment * 16 + offset
    value = struct.unpack_from("<H", image, position)[0]
    struct.pack_into("<H", image, position, (value + LOAD) & 65535)

# Intentional fixes from README.md; the on-disk executable remains unchanged.
assert image[0x4848:0x484F] == bytes.fromhex("8b 16 16 9f 2b 54 16")
image[0x4848:0x484F] = bytes.fromhex("8b 1e 16 9f 2b 5c 16")  # Aim with the player Y difference.
assert image[0x8762:0x8765] == bytes.fromhex("8b 5d 16")
image[0x8763] = 0x5C  # Read boss Y through preserved SI instead of clobbered DI.


def machine():
    cpu = Uc(UC_ARCH_X86, UC_MODE_16)
    cpu.mem_map(0, 0x100000)
    cpu.mem_write(LOAD * 16, bytes(image))
    for register, value in [(UC_X86_REG_CS, LOAD), (UC_X86_REG_DS, LOAD + 0x1853),
                            (UC_X86_REG_ES, LOAD + 0x1853), (UC_X86_REG_SS, 0x9000)]:
        cpu.reg_write(register, value)
    return cpu


def word(cpu, offset, value=None, signed=False):
    if value is not None:
        cpu.mem_write(DS + offset, struct.pack("<H", value & 65535))
    return struct.unpack("<h" if signed else "<H", cpu.mem_read(DS + offset, 2))[0]


def call(cpu, address):
    cpu.reg_write(UC_X86_REG_SP, 0xFFFC)
    cpu.mem_write(0x9FFFC, b"\x00\xff")
    cpu.emu_start(LOAD * 16 + address, STOP, count=100000)
    assert cpu.reg_read(UC_X86_REG_IP) == 0xFF00, "Original routine did not return"


def skip_calls(cpu, offsets):
    def skip(uc, address, _size, _data):
        if address - LOAD * 16 not in offsets:
            return
        sp = uc.reg_read(UC_X86_REG_SP)
        ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
        uc.reg_write(UC_X86_REG_SP, sp + 2)
        uc.reg_write(UC_X86_REG_IP, ip)
    cpu.hook_add(UC_HOOK_CODE, skip)


def sprite_draw_trace(cpu):
    seen = []

    def trace(uc, _address, _size, _data):
        seen.append([uc.reg_read(reg) for reg in (UC_X86_REG_SI, UC_X86_REG_CX, UC_X86_REG_DX)])
        sp = uc.reg_read(UC_X86_REG_SP)
        uc.reg_write(UC_X86_REG_SP, sp + 2)
        uc.reg_write(UC_X86_REG_IP, struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0])

    cpu.hook_add(UC_HOOK_CODE, trace, begin=LOAD * 16 + 0x875, end=LOAD * 16 + 0x875)
    return seen


def startup_pool(players, stage_two=False):
    cpu = machine()
    skip_calls(cpu, {0xE6F, 0xE91, 0xBA5, 0xF5A})
    cpu.mem_write(DS + 0x8F5E, bytes([255 if players == 2 else 0]))
    call(cpu, 0x1869)
    if stage_two:
        word(cpu, 0x8E70, players)
        word(cpu, 0x991C, 2)
        word(cpu, 0x991A, 1)
        call(cpu, 0x1B43)
    return cpu


native = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {readFileSync} from 'node:fs';
import {decodeGroundLogic,unpack} from './src/formats.js';
import {GroundGun,GroundPatrol,GroundHatch,GroundCreature} from './src/ground.js';
import {movePlayer,scrollMap} from './src/controls.js';
import {Game,frameAt} from './src/game.js';
import {ActorList,ActorPool} from './src/actor-pool.js';
import {Renderer} from './src/renderer.js';
import {buy,grantReward,sell} from './src/shop.js';
import {fireWeapons,weaponAttachment} from './src/weapons.js';
import {activateNashwan,suspendNashwan} from './src/nashwan.js';
import {loadTestCampaign} from './test/helpers.js';
import {StageOneBoss,moveCredit} from './src/boss.js';
const defs=decodeGroundLogic(readFileSync('XENON2.EXE'),1);
const guns=[];
for(const type of [1,2,3])for(const side of [0,1]){
 const event=[4352,type,0,0,side?248:72,4328,side];
 const gun=new GroundGun(event,defs), map=new Array(22).fill(0);
 const patch=tiles=>tiles.forEach((v,i)=>map[(i%2)+Math.floor(i/2)*20]=v);
 patch(gun.patches);let seed=0x5845;const states=[];
 for(let i=0;i<128;i++){
  const b=gun.update(4300-i,4316-i,()=>seed=(seed*0x6255+0x3619)&65535);
  patch(gun.patches);
  states.push({actor:[gun.x,gun.worldY,gun.cell*2,gun.health,gun.phase,gun.fireCounter],
   tiles:[map[0],map[1],map[20],map[21]],
   bullet:b?[b.x,b.y,side?6:2,defs.get(type).bulletSpeed,
    (b.frame.offset+8)|b.frame.bank]:null});
 }
 patch(gun.definition.death[side]);guns.push({event,states,death:[map[0],map[1],map[20],map[21]]});
}
const controls=[];
for(const speed of [0,1,2]){
 const player={x:160,y:174,speed}, c={camera:4608,ceiling:4607,bank:0,reverseTicks:0};
 const states=[];
 for(let i=0;i<256;i++){
  const bits=i<16?4:i<40?8:i<60?0:i<130?2:i<210?1:3;
  const result=movePlayer(player,{up:bits&1,down:bits&2,left:bits&4,right:bits&8},c);
  scrollMap(c,result.scroll,result.down,224);
  states.push({bits,state:[player.x,player.y,c.camera,c.ceiling,c.bank,c.reverseTicks,c.delta]});
 }
 controls.push({speed,states});
}
const campaign=loadTestCampaign();
const bossTraces=[];
for(const hurt of [false,true]){
 const game=new Game(campaign);game.start();
 const boss=game.boss,randomWord=()=>game.randomWord();
 const states=[];
 for(let tick=1;tick<=1200;tick++){
  const camera=Math.max(0,650-tick),control={ceiling:camera+16};
  if(hurt&&tick===700)boss.health=7;
  let aimOperand=0x5a5a;
  const operands=[];
  const bullets=boss.arms.map(arm=>{
   const state=boss.updateArm(arm,camera,randomWord,{x:tick%280+20,y:160},game.run.actorPool,aimOperand);
   operands.push(aimOperand=state.aimOperand);
   return state.bullet;
  }).filter(Boolean);
  operands.push(boss.updateCore(camera,control,tick,()=>boss.activate(game),aimOperand));
  states.push({camera,ceiling:control.ceiling,seed:game.seed,
   core:[boss.worldY,boss.phase,boss.speed,boss.dy,boss.wait,boss.heading,boss.turn,
    boss.acceleration,boss.mouthAge],
   arms:boss.arms.map(a=>[a.xFixed,a.yFixed,a.heading||0,a.turn||0,a.fireCounter,
    (a.frame.offset+8)|a.frame.bank]),
   operands,bullets:bullets.map(b=>[b.x,b.y,b.dx,b.dy,(b.frame.offset+8)|b.frame.bank])});
 }
 bossTraces.push({hurt,states});
}
const bossHits=[];
for(const point of [false,true])for(const [x,y] of [[151,84],[152,83],[152,84],[167,98],[168,98],[160,99],[160,90]]){
 const shot={x,y,point},boss=new StageOneBoss(campaign.logic.boss,campaign.logic.sine,
  f=>campaign.lookup[f.bank].get(f.offset));
 boss.weakY=84;
 bossHits.push({shot,accepted:boss.acceptsHit(shot)});
}
const deadBossGame=new Game(campaign);deadBossGame.start();deadBossGame.destroy(deadBossGame.boss);
const bossBurst={credits:deadBossGame.pickups.map(p=>[p.x,p.y,p.value]),
 effects:deadBossGame.effects.map(e=>[e.x,e.y]),seed:deadBossGame.seed};
const credits=[];
for(const position of [[10,6],[309,185],[160,100]]){
 const p={x:position[0],y:position[1],state:7,direction:0},states=[];
 for(let tick=0;tick<256;tick++){
  moveCredit(p,campaign.logic.credits);
  states.push([p.x,p.y,p.state,p.direction,!!p.dead]);
  if(p.dead)break;
 }
 credits.push({position,states});
}
const patrols=[];
for(const stage of [1,2])for(const side of [0,1])for(const scenario of ['patrol','fire','reverse','expire']){
 const assets=campaign.stages[stage-1],type=stage===1?4:3;
 const event=[1120,type,1,1,side?248:72,1108,side];
 const gun=new GroundPatrol(event,assets.groundLogic.get(type),1000,
  f=>assets.lookup[f.bank].get(f.offset));
 let seed=0x5845;const states=[];
 for(let tick=0;tick<128;tick++){
  const camera=scenario==='reverse'?1000+(tick<32?-tick:tick-64):1000-tick;
  const ceiling=scenario==='expire'?850:camera+16;
  const playerY=scenario==='fire'?100:10;
  const bullets=gun.update(camera,ceiling,()=>seed=(seed*0x6255+0x3619)&65535,{y:playerY})||[];
  if(gun.dead){states.push({camera,ceiling,playerY,dead:true,seed});break;}
  const f=gun.frame,b=gun.bounds();
  states.push({camera,ceiling,playerY,dead:gun.dead,seed,
   actor:[gun.x,gun.motion.y,gun.direction,gun.travel,gun.remaining,gun.health,
    (f.offset+8)|f.bank,f.duration-gun.frameTicks],
   box:[b.x,b.y,b.x+b.w-1,b.y+b.h-1],
   bullets:bullets.map(b=>[b.x,b.y,b.dx,b.dy,(b.frame.offset+8)|b.frame.bank])});
 }
 let death=null;
 if(!gun.dead){
  const g=new Game(campaign);g.start(stage);g.camera=states.at(-1).camera;g.destroy(gun);
  death={effect:[g.effects[0].x,g.effects[0].y,g.effects[0].large],score:g.score};
 }
 patrols.push({stage,side,scenario,event,states,death});
}
const randomGuns=[];
for(const stage of [2,3,4,5])for(const side of [0,1]){
 const assets=campaign.stages[stage-1],type={2:1,3:4,4:1,5:2}[stage];
 const event=[1120,type,0,0,side?248:72,1108,side];
 const gun=new GroundGun(event,assets.groundLogic);let seed=0x5845;const states=[];
 for(let tick=0;tick<256;tick++){
  const b=gun.update(1000,1016,()=>seed=(seed*0x6255+0x3619)&65535);
  if(gun.dead)break;
  states.push({phase:gun.phase,counter:gun.fireCounter,seed,patches:gun.patches,
   bullet:b?[b.x,b.y,b.dx,b.dy,(b.frame.offset+8)|b.frame.bank]:null});
 }
 randomGuns.push({stage,event,states,death:gun.definition.death[side]});
}
const weapons=[];
for(const id of [1,8,10,14])for(const power of [0,1,2]){
 const game=new Game(campaign);game.start();game.resetDive();
 game.inventory=[{id,power},null,null,null,null,null,null];
 fireWeapons(game);
 weapons.push({id,power,shots:game.shots.map(s=>
  [s.dx,s.dy,s.x,s.y,s.originalSprite.pointer,s.damage-1])});
}
const rear=[];
const rearGame=new Game(campaign);rearGame.start();rearGame.resetDive();
rearGame.inventory[5]={id:8,power:0};rearGame.player.y=100;
rearGame.assets={...rearGame.assets,events:[],background:[]};
for(let tick=0;tick<40;tick++){
 rearGame.invincible=2;rearGame.sounds=[];
 rearGame.update({fire:tick<12?tick===2:tick%3!==0});
 const frame=rearGame.assets.logic.rearAttachment[rearGame.rearFrame];
 rear.push({fired:rearGame.sounds.includes('shot'),
  state:[rearGame.player.x,rearGame.player.y,(frame.offset+8)|frame.bank]});
}
const shops=[];
for(const [camera,y,visited] of [[2514,174,false],[2513,174,false],
 [2672,16,false],[2671,16,false],[2513,174,true]]){
 const g=new Game(campaign);g.start();g.camera=g.control.camera=camera;
 g.control.ceiling=camera+16;g.player.y=y;g.shopVisited=visited;g.checkShop();
 shops.push({camera,y,visited,state:[g.camera,g.control.ceiling,g.shopVisited,g.status==='shop']});
}
const shopCredits=[];
for(let stage=1;stage<=5;stage++)for(const camera of [1000,224]){
 for(const balance of [0,600,70000]){
  const g=new Game(campaign);g.start(stage);g.camera=camera;g.credits=balance;g.openShop(stage);
  shopCredits.push({stage,camera,balance,state:[g.credits,g.seed]});
 }
}
const health=campaign.stages.flatMap(stage=>[1,2,7].map(round=>{
 const g=new Game(campaign);g.start(stage.number);g.campaignRound=round;
 return {stage:stage.number,round,cases:[...stage.logic.templates].filter(([type])=>type).map(([type,parts])=>{
  g.enemies=[];
  g.spawn([4608,type,1,1,0,0,3]);
  return {type,parts:[g.enemies[0].health,...parts.slice(1).map(p=>p.health)]};
 })};
}));
const shopArt={raw:Buffer.from(unpack(readFileSync('GR.DAT'))).toString('base64'),
 pixels:[...campaign.shopArt.pixels],alpha:[...campaign.shopArt.alpha]};
const podOpenings=campaign.rewards.map((definition,reward)=>{
 const g=new Game(campaign);g.start();g.spawn(g.assets.events.find(e=>e[1]===0));
 const pod=g.enemies[0];pod.reward=reward;pod.motion.xFixed=137*65536;pod.motion.yFixed=81*65536;
 g.destroy(pod);return {reward,actor:definition.actor,pickup:g.pickups[0]};
});
const recycledPickups=(()=>{
 const g=new Game(campaign);g.start(2);g.eventStreamsClosed=true;
 g.camera=g.endCamera=1000;g.shipTouchesTerrain=()=>false;g.divePhase=4;
 g.spawn(g.assets.events.find(e=>e[1]===0));
 const pod=g.enemies[0],shot={x:80,y:60,dx:-3,dy:-6,dead:true};
 g.addPlayerRound(shot);g.update();
 pod.reward=16;pod.motion.xFixed=80*65536;pod.motion.yFixed=60*65536;
 g.destroy(pod);
 const drop=g.pickups[0];
 const trace=(pickup,ticks)=>{
  const states=[];
  for(let tick=0;tick<=ticks;tick++){
   const frame=g.pickupFrame(pickup);
   states.push([pickup.actorAddress,pickup.x,pickup.y,pickup.state,pickup.direction,(frame.offset+8)|frame.bank]);
   if(tick!==ticks)g.update();
  }
  return states;
 };
 const podTrace=trace(drop,2);
 drop.dead=true;g.update();g.seed=0x5845;
 g.destroy(g.boss);
 return {shot:shot.actorAddress,pod:podTrace,credit:trace(g.pickups[0],12)};
})();
const actorPools = [1,2].flatMap(players=>[1,2].map(stage=>{
 const g=new Game(campaign);g.start(stage,players);
 const pool=g.run.actorPool, addresses=(seat,list)=>(seat.actorLists.get(list)||[]).map(slot=>slot.address);
 return {players,stage,free:[...pool.free].reverse(),seats:[g,...(g.partner?[g.partner]:[])].map(seat=>
  [addresses(seat,ActorList.hud),addresses(seat,ActorList.mounts),addresses(seat,ActorList.main)])};
}));
const mountPools = [1,2].map(players=>{
 const game=new Game(campaign);game.start(2,players);
 if(players===2)game.continueRun();
 game.camera=game.endCamera=1000;game.eventStreamsClosed=true;
 game.shipTouchesTerrain=()=>false;
 game.credits=100000;game.openShop(2);
 const script=[['buy',14],['buy',15],['buy',15],['buy',18],['buy',17],['buy',8],
  ['buy',8],['buy',21],['sell',6],['buy',23],['sell',5],['sell',1],['sell',0],['exit'],['tick'],['save'],['loan'],['tick'],
  ['return'],['loan'],['restore'],['return']];
 const pool=game.run.actorPool,states=[];
 for(const [action,value] of script){
  if(action==='buy'&&!buy(game,value).ok)throw Error('Mount purchase failed: '+value);
  if(action==='sell'&&!sell(game,value).ok)throw Error('Mount sale failed: '+value);
  if(action==='exit')game.continueRun();
  if(action==='tick')game.update();
  if(action==='save')game.saveCheckpointEquipment();
  if(action==='loan'){game.player.nashwan=170;activateNashwan(game);}
  if(action==='return'){suspendNashwan(game);game.player.nashwan=0;}
  if(action==='restore')game.restoreCheckpoint();
  const mount=(game.actorLists.get(ActorList.mounts)||[]).map(({address,type,actor})=>
   actor.dead?[address,4]:[address,type,actor.slot,actor.weapon.id,actor.weapon.power]);
  const overlays=(game.actorLists.get(ActorList.transient)||[]).map(({address,type,actor})=>
   actor.dead?[address,4]:[address,type,actor.mount.actorAddress]);
  states.push({mount,overlays,free:pool.free.toReversed()});
 }
 return {players,script,states};
});
const stageOneMountFire = [[14,8,15],[15,8,14]].map(orders=>{
 const game=new Game(campaign);
 game.start();
 game.camera=game.endCamera=4300;game.control.ceiling=4316;
 game.player.y=96;game.shopVisited=true;game.shipTouchesTerrain=()=>false;
 game.assets={...game.assets,events:[],background:[]};
 game.eventStreamsClosed=true;
 game.credits=100000;game.openShop(1);
 for(const item of orders)if(!buy(game,item).ok)throw Error('Missing stage-one weapon');
 game.continueRun();game.posture=0;
 const event=[4300,1,0,0,72,4340,0];
 const gun=new GroundGun(event,game.assets.groundLogic), pool=game.run.actorPool;
 pool.allocate(game.actorLists,ActorList.main,0xec,gun);
 game.ground.push(gun);gun.fireCounter=255;
 const states=[];
 for(let tick=0;tick<10;tick++){
  const fire=tick===0||tick===5;
  game.update({fire});
  const mounts=game.actorLists.get(ActorList.mounts).map(({address,actor})=>[address,actor.weapon.id]);
  const transient=game.actorLists.get(ActorList.transient).map(({address,type,actor})=>
   type===0x40?[address,type,actor.mount.actorAddress]:
   [address,actor.dead?4:type,actor.x,actor.y,actor.originalSprite?.pointer??((actor.frame.offset+8)|actor.frame.bank)]);
  states.push({fire,mounts,transient,seed:game.seed,free:pool.free.at(-1)});
 }
 return {orders,event,states};
});
const actorReclaims = [
 [[0x9096,0xc],[0x9096,0x14],[0x90e2,0xf8]],
 [[0x9096,0x14],[0x90e2,0xf8],[0x904a,0xe0]],
 [[0x90e2,0xf8],[0x904a,0xe0]],
 [[0x904a,0xe0],[0x904a,0x8000],[0x904a,0x64]],
 [[0x904a,4],[0x904a,0x8000],[0x904a,0x64]],
 [[0x904a,0x8000],[0x904a,0x64]],
].map(records=>{
 const pool=new ActorPool(),seat=new Map();
 for(let i=0;i<159-records.length;i++)pool.allocate(seat,ActorList.hud,0xc4);
 for(const [list,type] of records)pool.allocate(seat,list,type);
 return {records,address:pool.allocate(seat,ActorList.mounts,0x94).address};
});
const stageTwoPoolScenes = [0,1].flatMap(side=>[false,true].map(clear=>{
 const game=new Game(campaign);game.start(2,side+1);
 if(side)game.continueRun();
 game.seed=0x5845;
 game.camera=game.endCamera=1000;
 game.player.x=300;game.player.y=100;
 game.shipTouchesTerrain=()=>false;
 game.boss=game.miniboss=undefined;
 const background=[[1000,1,0,0,72,1108,side],[1000,3,3,0,248,1108,1-side],
  [1000,5,0,0,56,1108,0]];
 game.assets={...game.assets,events:[],background};
 game.dispatchCameraEvents();
 const states=[];
 for(let i=0;i<48;i++){
  game.update();
  if(i===0&&clear)grantReward(game,18);
  const lists=[ActorList.main,ActorList.transient,ActorList.scenery].map(list=>
   (game.actorLists.get(list)||[]).map(({address,type,actor})=>[address,actor.dead?4:type,
    ...(!actor.dead&&[0x0c,0x14].includes(type)?[actor.x,actor.y]:[]),
    ...(!actor.dead&&type===0x0c?[(actor.frames[actor.age].offset+8)|actor.frames[actor.age].bank]:[])]));
  states.push({lists,seed:game.seed,free:game.run.actorPool.free.at(-1),score:game.score});
 }
 return {players:side+1,background,clear,states};
}));
const rect=b=>b.x===1000?[1000]:[b.x,b.y,b.x+b.w-1,b.y+b.h-1];
const stageTwoCameraEvents=[1,2].map(players=>{
 const game=new Game(campaign);game.start(2,players);
 if(players===2)game.continueRun();
 const path=[10,100,60,2,36,0,0,1000,0];
 const events=[[1000,1,1,1,0,0,3]];
 const background=[[1000,1,0,0,72,1108,0],[1000,3,3,0,248,1108,1],[1000,4,0,0,120,1120,0]];
 game.assets={...game.assets,events,background,paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
 game.camera=1001;game.endCamera=1000;game.control.ceiling=1016;
 game.player.x=300;game.player.y=24;game.seed=0x5845;
 game.shipTouchesTerrain=()=>false;
 const cells=[1364,1365,1384,1385,1387,1388,1407,1408];
 const initialTiles=cells.map(i=>game.map[i]);
 const read=records=>records.map(({address,type,actor})=>[address,actor.dead?4:type]);
 const states=Array.from({length:6},()=>{
  game.update();
  const paint=game.actorPaint?.tick===game.tick?game.actorPaint:undefined;
  const main=game.actorLists.get(ActorList.main);
  return {painted:(paint?.main??main).filter(({type,actor})=>type!==0x50&&type!==0x54
    &&!actor.dead&&!(actor instanceof GroundGun)).map(({address})=>address),
   paintTiles:cells.map(i=>paint?(paint.mapPatches.get(i)??game.assets.map[i]):game.map[i]),
   tiles:cells.map(i=>game.map[i]),main:read(main),scenery:read(game.actorLists.get(ActorList.scenery)),
   motion:game.tick===1?null:[...game.ground.filter(actor=>actor.spriteActor),...game.enemies]
    .map(({motion:{x,y}})=>[x,y]),
   gun:game.ground[0].contactBox?rect(game.ground[0].contactBox):null,
   hatch:game.scenery[0].phase,seed:game.seed,free:game.run.actorPool.free.at(-1)};
 });
 return {players,path,events,background,cells,initialTiles,states};
});
const stageTwoPickupOrder = [true,false].map(first=>{
 const game=new Game(campaign);game.start(2);game.eventStreamsClosed=true;
 game.shipTouchesTerrain=()=>false;
 const round={x:160,y:170,dx:0,dy:0,fixed:true,damage:4,frame:game.assets.logic.foregroundShot.frame};
 const pickup={kind:'reward',reward:18,x:0,y:0,state:-2,direction:0,age:0};
 const b=game.bounds(game.sprite(game.pickupFrame(pickup)),0,0);
 pickup.x=160-b.x-Math.floor(b.w/2);pickup.y=172-b.y-Math.floor(b.h/2);
 if(!first)game.addPickup(pickup);
 game.addPooledHostileRound(round);
 if(first)game.addPickup(pickup);
 game.update();
 return {first,x:pickup.x,y:pickup.y+2,frame:(round.frame.offset+8)|round.frame.bank,
  health:game.player.health,roundDead:round.dead,pickupDead:pickup.dead};
});
const homingPatrolLocks=[true,false].map(locked=>{
 const game=new Game(campaign);game.start(2);game.eventStreamsClosed=true;
 game.camera=game.endCamera=1000;game.shipTouchesTerrain=()=>false;
 game.player.x=300;game.player.y=100;game.seed=0x5845;
 const event=[1000,3,3,0,72,1108,0];
 const patrol=new GroundPatrol(event,game.assets.groundLogic.get(3),game.camera,f=>game.sprite(f));
 game.addStageTwoBossActor(patrol,0x104);
 game.ground.push(patrol);
 const rocket={x:110,y:60,homing:true,direction:7,launch:true,phase:0,age:0,
  targetAddress:locked?patrol.actorAddress:undefined};
 game.addPlayerRound(rocket,0x48);
 game.update();
 const transient=game.actorLists.get(ActorList.transient);
 const b=patrol.bounds();
 return {locked,event,patrol:patrol.actorAddress,rocket:rocket.actorAddress,expected:{
  lists:[ActorList.main,ActorList.transient].map(list=>game.actorLists.get(list).map(({address,type,actor})=>
   [address,actor.dead?4:type])),
  position:[rocket.x,rocket.y,rocket.direction,rocket.phase,(rocket.frame.offset+8)|rocket.frame.bank],
  box:[b.x,b.y,b.x+b.w-1,b.y+b.h-1],target:rocket.targetAddress??0,seed:game.seed,
  effects:transient.filter(({type})=>type===0x0c).length}};
});
const miniCorpseSelfReuse=(()=>{
 const game=new Game(campaign);game.start(2);
 const wave={wave:true,part:0,side:0,type:0x114,motion:{x:280,y:100}};
 game.addStageTwoBossActor(wave,wave.type);
 const pool=game.run.actorPool,reserved=new Map();
 while(pool.free.length)pool.allocate(reserved,ActorList.hud,0xc4);
 game.miniboss.destroy(wave,game);
 const [record]=game.actorLists.get(ActorList.transient);
 const {actor:corpse,address}=record;
 const before=[address,corpse.dead?4:record.type,corpse.x,corpse.y,corpse.angle,game.seed];
 game.updateTransientActor(record);
 return {wave:wave.actorAddress,before,after:[pool.free.at(-1),corpse.x,corpse.y]};
})();
for(const hatch of [false,true]){
 const game=new Game(campaign);game.start(2);game.camera=100;
 const event=[100,3,3,0,72,208,0];
 const patrol=new GroundPatrol(event,game.assets.groundLogic.get(3),game.camera,f=>game.sprite(f));
 const record=game.addStageTwoBossActor(patrol,0x104);
 const rocket={x:110,y:60,homing:true,direction:7,launch:true,phase:0,age:0,targetAddress:record.address};
 game.addPlayerRound(rocket,0x48);
 game.run.actorPool.release(game.actorLists,ActorList.main,record);
 const allocate=(actor,type)=>game.addStageTwoBossActor(actor,type);
 if(hatch)game.boss.spawnCrawler({motion:{x:160,y:124},direction:2},allocate);
 else game.boss.spawnEgg(game.camera,()=>game.randomWord(),allocate);
 game.updatePlayerRound(rocket,1);
 homingPatrolLocks.push({hatch,event,patrol:record.address,rocket:rocket.actorAddress,expected:{
  lists:[ActorList.main,ActorList.transient].map(list=>game.actorLists.get(list).map(({address,type,actor})=>
   [address,actor.dead?4:type])),
  position:[rocket.x,rocket.y,rocket.direction,rocket.phase,(rocket.frame.offset+8)|rocket.frame.bank],
  target:rocket.targetAddress,seed:game.seed,effects:game.effects.map(({x,y})=>[x,y])}});
}
for(const prior of ['patrol','egg'])for(const locked of [false,true]){
 const game=new Game(campaign);game.start(2);game.camera=100;
 const event=[100,3,3,0,72,208,0];
 const patrol=new GroundPatrol(event,game.assets.groundLogic.get(3),game.camera,f=>game.sprite(f));
 const record=game.addStageTwoBossActor(patrol,0x104);
 const rocket={x:110,y:60,homing:true,direction:7,launch:true,phase:0,age:0,
  targetAddress:locked?record.address:undefined};
 game.addPlayerRound(rocket,0x48);
 const pool=game.run.actorPool;
 pool.release(game.actorLists,ActorList.main,record);
 if(prior==='egg'){
  game.boss.spawnEgg(game.camera,()=>game.randomWord(),(actor,type)=>game.addStageTwoBossActor(actor,type));
  const [egg]=game.actorLists.get(ActorList.main);
  pool.release(game.actorLists,ActorList.main,egg);
 }
 game.miniboss.destroy({wave:true,part:0,side:0,type:0x114,motion:{x:280,y:100}},game);
 const [corpse]=game.miniboss.corpses;
 game.miniboss.updateCorpse(corpse);
 game.updatePlayerRound(rocket,1);
 homingPatrolLocks.push({prior,locked,event,patrol:record.address,rocket:rocket.actorAddress,expected:{
  lists:[ActorList.main,ActorList.transient].map(list=>game.actorLists.get(list).map(({address,type,actor})=>
   [address,actor.dead?4:type])),
  position:[rocket.x,rocket.y,rocket.direction,rocket.phase,(rocket.frame.offset+8)|rocket.frame.bank],
  target:rocket.targetAddress??0,seed:game.seed,effects:game.effects.map(({x,y})=>[x,y]),
  corpse:[corpse.actorAddress,corpse.x,corpse.y,corpse.angle,(corpse.frame.offset+8)|corpse.frame.bank]}});
}
const transientReuse=[true,false].map(successorBlast=>{
 const game=new Game(campaign);game.start(2);game.eventStreamsClosed=true;
 game.camera=game.endCamera=1000;game.shipTouchesTerrain=()=>false;
 game.seed=0x5845;
 const {actorPool:pool}=game.run,frame=game.assets.logic.foregroundShot.frame;
 const round={x:30,y:40,dx:2,dy:0,fixed:true,frame};
 game.addPooledHostileRound(round);
 if(successorBlast)game.explode(40,50);
 const rocket={x:80,y:60,homing:true,direction:7,launch:true,phase:0,age:0};
 game.addPlayerRound(rocket,0x48);
 const reserved=new Map();
 while(pool.free.length)pool.allocate(reserved,ActorList.hud,0xc4);
 const records=game.actorLists.get(ActorList.transient);
 const before=records.map(({address,type})=>[address,type]);
 const states=[];
 for(let i=0;i<2;i++){
  game.update();
  const list=records.map(({address,type,actor})=>{
   const sprite=type===0x0c?actor.frames[actor.age]:actor.frame;
   return [address,actor.dead?4:type,actor.x,actor.y,(sprite.offset+8)|sprite.bank];
  });
  states.push({list,free:pool.free.at(-1)??0,seed:game.seed});
 }
 return {successorBlast,before,states,frame:(frame.offset+8)|frame.bank};
});
const mixedDropCountdown=[
 ['credit',174,-2],['reward',196,0],['reward',174,-2],
 ['credit',174,-2,true],
].map(([kind,y,state,evict=false])=>{
 const game=new Game(campaign);game.start(2);game.eventStreamsClosed=true;
 game.camera=game.endCamera=1000;game.shipTouchesTerrain=()=>false;
 game.miniboss.shopPending=true;game.credits=5000;
 const bossCredit={kind:'credit',counted:true,value:100,x:50,y:30,age:0,state:-2,direction:0};
 const ordinary={kind,reward:0,value:50,x:160,y,age:0,state,direction:0};
 const frame=game.assets.logic.foregroundShot.frame;
 const round={x:160,y:170,dx:0,dy:0,fixed:true,frame};
 game.addPickup(bossCredit);
 const snapshot=()=>({count:game.countedCredits,shop:game.status==='shop',health:game.player.health,
  credits:game.credits,ordinaryDead:Boolean(ordinary.dead),bossDead:Boolean(bossCredit.dead)});
 if(evict){
  const {actorPool:pool}=game.run,reserved=new Map();
  while(pool.free.length)pool.allocate(reserved,ActorList.hud,0xc4);
 }
 game.addPooledHostileRound(round);
 let afterEviction=null;
 if(evict){
  game.update();
  afterEviction={...snapshot(),reused:round.actorAddress===bossCredit.actorAddress,
   roundDead:Boolean(round.dead),flash:game.shipHitFlash};
 }
 game.addPickup(ordinary);
 game.update();
 return {kind,y,state,afterEviction,frame:(frame.offset+8)|frame.bank,expected:snapshot()};
});
const hostileContacts=[];
for(const [stage,oldEdge,newEdge] of [[1,183,155],[2,187,165],[3,186,158],[4,186,159],[5,187,158]]){
 const cases=[['round',oldEdge,0],['round',newEdge,0],['reward',197,0],['reward',151,0]];
 if(stage===2)cases.push(['round',187,1],['reward',197,4],['round',187,0,4],
  ['round',187,0,39,6],['round',187,0,39,0,1]);
 if(stage===4)cases.push([50,185,0],[50,154,0]);
 if(stage===5)cases.push([100,191,0],[100,158,0]);
 for(const [kind,y,dive,health=39,invincible=0,counted=0] of cases){
  const game=new Game(campaign);game.start(stage);game.eventStreamsClosed=true;
  game.camera=game.endCamera=1000;game.shipTouchesTerrain=()=>false;game.shopVisited=true;
  game.update();game.divePhase=dive;game.diveStep=dive===1?-1:0;
  game.player.health=health;game.invincible=invincible;game.countedCredits=counted;
  const frame=game.assets.logic.foregroundShot.frame,actor={x:160,y},wallet=game.credits;
  if(kind==='round'){
   Object.assign(actor,{dx:0,dy:0,fixed:true,foreground:true,frame});
   if(stage===2)game.addPooledHostileRound(actor);
   else game.bullets.push(actor);
  }else{
   Object.assign(actor,{age:0,state:-2,direction:0},kind==='reward'?{kind,reward:16}
    :{kind:'credit',value:kind,counted:true});
   game.addPickup(actor);
  }
  game.update({up:true});
  const dying=game.status==='dying',flash=game.shipHitFlash;
  const sprite=dying?game.sprite(game.assets.logic.playerDeath[0]):game.shipSprite(game.divePose);
  const paint=flash?{x:game.player.x-sprite.originX,y:game.player.y-sprite.originY,
   width:sprite.width,mask:Buffer.from(sprite.alpha).toString('base64')}:null;
  hostileContacts.push({stage,kind,y,dive,health,invincible,counted,paint,frame:(frame.offset+8)|frame.bank,expected:{
   shipY:game.player.y,divePhase:dying?null:game.divePhase,y:actor.y,dead:Boolean(actor.dead),
   health:game.player.health,invincible:game.invincible,flash,
   wallet:game.credits-wallet,count:game.countedCredits}});
 }
}
const stageTwoShipContacts=['ram','fatal','marked','steer-in','shades'].map(mode=>{
 const game=new Game(campaign);game.start(2);game.camera=game.endCamera=1000;
 game.shipTouchesTerrain=()=>false;
 const event=[1000,1,0,0,160,1174,0];
 game.assets={...game.assets,events:[],background:[event,event]};
 game.player.x=240;game.update();game.update();
 game.eventStreamsClosed=true;game.resetDive();
 const x=game.player.x=mode==='steer-in'?175:mode==='shades'?225:174;
 const health=game.player.health=mode==='fatal'?8:39;
 const shades=game.player.shades=Number(mode==='shades');
 if(mode==='marked')game.ground[1].dead=true;
 let pickup=null;
 if(mode==='ram'||mode==='fatal'){
  const drop={kind:'reward',reward:16,x:0,y:0,state:-2,direction:0,age:0};
  const b=game.bounds(game.sprite(game.pickupFrame(drop)),0,0);
  pickup=[drop.x=177-b.x-Math.floor(b.w/2),drop.y=174-b.y-Math.floor(b.h/2)];
  game.addPickup(drop);
 }
 game.update({left:mode==='steer-in',right:mode!=='steer-in'});
 const lists=[ActorList.main,ActorList.transient].map(list=>(game.actorLists.get(list)||[])
  .map(({address,actor,type})=>[address,actor.dead?4:type]));
 return {mode,event,x,health,shades,pickup,expected:{lists,x:game.player.x,health:game.player.health,
  score:game.score,invincible:game.invincible,dying:game.status==='dying',
  flash:game.shipHitFlash,free:game.run.actorPool.free.at(-1)}};
});
const stageTwoRing=(()=>{
 const game=new Game(campaign);game.start(2);game.eventStreamsClosed=true;
 game.shipTouchesTerrain=()=>false;game.camera=game.endCamera=1000;game.resetDive();
 const frame=game.assets.logic.foregroundShot.frame;
 const addRound=(x,y)=>game.addPooledHostileRound({x,y,dx:0,dy:0,fixed:true,damage:4,frame});
 const pickup={kind:'reward',reward:16,x:0,y:0,state:-2,direction:0,age:0};
 const b=game.bounds(game.sprite(game.pickupFrame(pickup)),0,0);
 const x=pickup.x=160-b.x-Math.floor(b.w/2),y=pickup.y=172-b.y-Math.floor(b.h/2);
 addRound(9,160);game.addPickup(pickup);
 const sprites=new Map(game.assets.logic.nashwan.meter.map(f=>[game.sprite(f),(f.offset+8)|f.bank]));
 const paint=[];
 const renderer=Object.assign(Object.create(Renderer.prototype),{
  assets:game.assets,map:game.map,mapRevision:game.mapRevision,
  world:{getContext:()=>({drawImage(){}})},tileImages:[],
  context:Object.fromEntries(['drawImage','save','beginPath','rect','clip','restore','fillText','fillRect']
    .map(name=>[name,()=>{}])),
  drawSprite(sprite,x,y){if(sprites.has(sprite))paint.push([sprites.get(sprite),x,y]);},
  drawEnemyRound(_,round){paint.push(round.actorAddress);},
  drawInvulnerabilityRing(_,ring){paint.push(ring.actorAddress);},
 });
 const states=Array.from({length:4},(_,tick)=>{
  if(tick===1){game.invincible=1;grantReward(game,16);}
  if(tick===2){game.invincible=1;addRound(160,170);}
  game.update();
  paint.length=0;renderer.draw(game);
  const records=game.actorLists.get(ActorList.transient).map(({address,type,actor})=>
   [address,actor.dead?4:type,...(!actor.dead&&type===0x5c?[(actor.frame.offset+8)|actor.frame.bank,actor.x,actor.y]:[])]);
  return {records,paint:paint.slice(),remaining:game.invincible,health:game.player.health,
   free:game.run.actorPool.free.at(-1)};
 });
 return {x,y,frame:(frame.offset+8)|frame.bank,states};
})();
const hatchStage=campaign.stages[1],hatches=[],creatures=[];
for(const type of [2,4,5])for(const side of (type===2?[0,1]:[0])){
 for(const profile of ['forward','reverse','freeze','expire']){
  const event=[1080,type,0,0,side?264:40,1008,side];
  const hatch=new GroundHatch(event,hatchStage.groundLogic.get(type));
  const game=new Game(campaign);game.start(2,side ? 2 : 1);
  const pool=game.run.actorPool,seat=game.actorLists;
  const hatchSlot=pool.allocate(seat,ActorList.scenery,
    type===2?(side?0xf0:0xf4):type===4?0xfc:0xf8,hatch).address;
  const map=new Array(22).fill(0),patch=tiles=>{
   if(tiles)tiles.forEach((v,i)=>map[i%2+Math.floor(i/2)*20]=v);
  };
  patch(hatch.patches);let seed=0x5845;const states=[];
  for(let tick=0;tick<280&&!hatch.dead;tick++){
   pool.collect(seat,ActorList.main);
   const camera=profile==='freeze'?800:profile==='expire'?500:
    profile==='reverse'&&tick>=190?890+tick-190:1080-tick;
   const ceiling=profile==='expire'?600:camera+16;
   const spawned=hatch.update(camera,ceiling,tick,()=>seed=(seed*0x6255+0x3619)&65535);
   patch(hatch.patches);
   states.push({camera,ceiling,tick,seed,actor:[hatch.phase,hatch.repeats,hatch.dead],
    tiles:[map[0],map[1],map[20],map[21]],spawned:spawned.map(s=>{
     const actorType=s.definition.kind==='swarm'?0x108:s.definition.large?0xe0:0xe4;
     const actor={};
     const slot=pool.allocate(seat,ActorList.main,actorType,actor);
     if(type!==2) actor.dead=true;
     const f=(s.frames||s.definition.frames)[0];return [slot.address,actorType,
      (f.offset+8)|f.bank,f.duration,s.x,s.y,s.age||0,s.direction||0,
      s.definition.health,s.definition.large?255:0];
    })});
  }
  hatches.push({event,profile,states,hatchSlot,players:game.playerCount});
 }
}
for(const type of [4,5])for(const phase of [0,4,8,12]){
 const definition=hatchStage.groundLogic.get(type).creature;
 const creature=new GroundCreature({definition,x:130,y:140},
  f=>hatchStage.lookup[f.bank].get(f.offset),phase),states=[];
 for(let tick=1;tick<=320;tick++){
  const player={x:80+tick*3%160,y:170};
  creature.update(1000-tick,1100,()=>0,player,tick,1);
  const b=creature.bounds();
  states.push({tick,player,state:[creature.motion.x,creature.motion.y,creature.state,
   (creature.frame.offset+8)|creature.frame.bank,
   creature.frame.duration-creature.frameTicks,b.x,b.y,b.x+b.w-1,b.y+b.h-1]});
 }
 creatures.push({type,phase,states});
}
for(const direction of [0,1,2,3,4,5,6,7])for(const delta of [-1,0,1]){
 const definition=hatchStage.groundLogic.get(2).creature,spawn=definition.spawns[7-direction];
 const creature=new GroundCreature({definition,frames:spawn.frames,direction,x:160,y:90},
  f=>hatchStage.lookup[f.bank].get(f.offset)),states=[];
 for(let tick=1;tick<=80&&!creature.dead;tick++){
  const player={x:160,y:96};creature.update(1000,1100,()=>0,player,tick,delta);
  const b=creature.bounds();
  states.push({tick,player,delta,state:[creature.motion.x,creature.motion.y,creature.age,
   creature.direction,(creature.frame.offset+8)|creature.frame.bank,
   creature.frame.duration-creature.frameTicks,b.x,b.y,b.x+b.w-1,b.y+b.h-1],
   dead:creature.dead,expired:creature.expired});
 }
 creatures.push({type:2,direction,delta,states});
}
const swarmContacts=['remote','protection','invincible','diving','fatal','visible','ram','timeout'].map(mode=>{
 const game=new Game(campaign);game.start(2);game.eventStreamsClosed=true;
 game.camera=game.endCamera=1000;game.shipTouchesTerrain=()=>false;game.resetDive();
 const near=mode==='visible'||mode==='ram',direction=near?4:6;
 const shipY=game.player.y=near?174:16;
 const health=game.player.health=mode==='fatal'?4:39;
 const shield=game.player.protection=mode==='protection',invincible=game.invincible=mode==='invincible'?6:0;
 const dive=mode==='diving'?4:0;
 if(dive){game.shipContactBox=game.bounds(game.shipSprite(),game.player.x,shipY);game.divePhase=dive;}
 const x=mode==='ram'?160:near?151:240,y=mode==='ram'?174:160,age=mode==='timeout'?79:0;
 const definition=game.assets.groundLogic.get(2).creature;
 const actor=new GroundCreature({definition,x,y,age,direction,frames:definition.spawns[7-direction].frames},
  f=>game.sprite(f));
 game.addStageTwoBossActor(actor,0x108);game.ground.push(actor);
 game.update();
 return {mode,x,y,age,direction,shipY,health,shield,invincible,dive,expected:{
  health:game.player.health,dead:actor.dead,score:game.score,dying:game.status==='dying',flash:game.shipHitFlash,
  position:[actor.motion.x,actor.motion.y],free:game.run.actorPool.free.at(-1),
  effects:game.effects.map(e=>[e.actorAddress,e.x,e.y])}};
});
const miniEyes=[],miniWaves=[],miniDamage=[],miniControls=[],miniHits=[];
for(let phase=0;phase<8;phase++)for(let busy=0;busy<4;busy++){
 const g=new Game(campaign);g.start(2);g.miniboss.busy=busy;
 const eye=g.miniboss.eyes[0];eye.phase=phase;
 miniHits.push({phase,busy,accepted:eye.acceptsHit({point:true,x:152,y:72})});
}
for(const remaining of [3,2,1]){
 const g=new Game(campaign);g.start(2);g.camera=2700;
 const m=g.miniboss;m.remaining=remaining;m.lights.fill(24);
 g.control.ceiling=2716;g.control.scrollDirection=remaining===1?-1:1;
 const states=[];
 for(let tick=1;tick<=64;tick++){
  g.tick=tick;g.player.x=tick%4<2?159:160;m.busy=(tick>>3)&3;
  for(const eye of m.eyes.toReversed())m.updateEye(eye,g);
  states.push({tick,x:g.player.x,busy:m.busy,ceiling:g.control.ceiling,
   eyes:m.eyes.map(e=>[e.phase,e.box.x===1000?[1000]:
    [e.box.x,e.box.y,e.box.x+15,e.box.y+15],g.map[e.cell]]),
   lights:[...m.lights],tiles:m.definition.lights.map(l=>
    [g.map[l.cell],g.map[l.cell+1],g.map[l.cell+20],g.map[l.cell+21]])});
 }
 miniEyes.push({remaining,states});
}
for(let entry=0;entry<16;entry++){
 const g=new Game(campaign);g.start(2);g.camera=entry<8?2800:2528;
 const m=g.miniboss,side=entry&1,scroll=[-2,-1,1,2][entry&3];m.initial=entry<8?2:0;
 m.selectors[side]=((entry&6)<<5);m.spawn(g,side,g.camera,scroll);
 const initial=m.waves.toReversed().map(a=>[a.motion.x,a.motion.y,a.motion.remaining,
  a.health,(a.frame.offset+8)|a.frame.bank]);
 const actors=[...m.waves],states=[];
 for(let tick=1;tick<=250;tick++){
  g.tick=tick;g.control.delta=tick%3-1;m.presence.fill(false);
  for(const actor of actors)if(!actor.dead)m.updateWave(actor,g);
  for(const eye of m.eyes.toReversed())m.updateEye(eye,g);
  states.push({delta:g.control.delta,actors:actors.map(a=>a.dead?null:[
   a.motion.xFixed,a.motion.yFixed,a.motion.heading,a.motion.turn,a.motion.acceleration,
   a.motion.remaining,a.motion.cursor-a.motion.base,(a.frame.offset+8)|a.frame.bank,
   a.drawMode,a.box.x,a.box.y,a.box.x+a.box.w-1,a.box.y+a.box.h-1]),
   lights:[...m.lights],presence:[...m.presence]});
  if(actors.every(a=>a.dead))break;
 }
 miniWaves.push({entry,camera:g.camera,scroll,initial,states});
}
for(const part of [0,1,2]){
 const g=new Game(campaign);g.start(2);const m=g.miniboss;m.spawn(g,0,2800,1);
 const a=m.waves.find(a=>a.part===part);a.motion.xFixed=160*65536;a.motion.yFixed=90*65536;
 g.destroy(a);const corpse=m.corpses[0],states=[];
 for(let tick=0;tick<64&&!corpse.dead;tick++){
  m.updateCorpse(corpse);states.push([corpse.x,corpse.y,corpse.age,!!corpse.dead,
   (corpse.frame.offset+8)|corpse.frame.bank]);
 }
 miniDamage.push({part,busy:m.busy,score:g.score,seed:g.seed,angle:corpse.angle,states});
}
const miniDeathGame=new Game(campaign);miniDeathGame.start(2);
miniDeathGame.miniboss.remaining=1;
const lastEye=miniDeathGame.miniboss.eyes[0];lastEye.box={x:144,y:64,w:16,h:16};
miniDeathGame.destroy(lastEye);
const miniBurst={effects:miniDeathGame.effects.map(e=>[e.x,e.y,e.large]),
 credits:miniDeathGame.pickups.map(p=>[p.x,p.y,p.value]),seed:miniDeathGame.seed,
 count:miniDeathGame.countedCredits};
for(const speed of [0,1,2]){
 const player={x:160,y:174,speed},c={camera:2600,ceiling:2880,bank:0,
  reverseTicks:0,scrollDirection:-1},states=[];
 for(let i=0;i<256;i++){
  const bits=i<32?0:i<110?1:i<180?2:i<220?0:3;
  const r=movePlayer(player,{up:bits&1,down:bits&2},c);scrollMap(c,r.scroll,r.down,2528);
  states.push({bits,state:[player.x,player.y,c.camera,c.ceiling,c.bank,c.reverseTicks,c.delta]});
 }
 miniControls.push({speed,states});
}
const bossTwoTraces=[],bossEggs=[],bossCrawlers=[],bossTerrain=[],bossTwoDeaths=[];
const pointer=f=>(f.offset+8)|f.bank;
for(const population of [0,16])for(const playerY of [16,174]){
 const g=new Game(campaign);g.start(2);const b=g.boss;let seed=0x5845;const states=[];
 for(let tick=1;tick<=1800;tick++){
  const camera=Math.max(0,500-tick),control={ceiling:camera+16,delta:1};
  b.children=[];
  const bullets=b.update(camera,control,()=>seed=(seed*0x6255+0x3619)&65535,
   {x:160,y:playerY},tick,population);
  states.push({camera,ceiling:control.ceiling,seed,
   core:[b.worldY,b.wait,b.dy,b.moveTicks,b.hatching,b.mouthPhase*2,b.fireCounter],
   box:rect(b.bodyBox),tiles:[...b.tiles],
   bullets:bullets.map(s=>[s.x,s.y,s.direction,7,pointer(s.frame),s.frame.duration]),
   eggs:b.children.map(e=>[e.motion.x,e.motion.y,e.state,e.direction,pointer(e.frame),e.frameTicks])});
 }
 bossTwoTraces.push({population,playerY,states});
}
for(const direction of [0,1,2,3,4,5,6,7])for(const camera of [0,200]){
 const g=new Game(campaign);g.start(2);const b=g.boss,e=b.spawnEgg(camera,()=>direction);
 let seed=0x5845;const states=[];
 for(let tick=1;tick<=300&&!e.dead;tick++){
  const delta=tick%3-1;b.updateEgg(e,camera,delta,()=>seed=(seed*0x6255+0x3619)&65535);
  const crawler=b.children.find(a=>a.kind==='crawler');
  states.push({delta,seed,state:[e.motion.x,e.motion.y,e.state,e.direction,pointer(e.frame),e.frameTicks,!!e.dead],
   crawler:crawler?[crawler.motion.x,crawler.motion.y,crawler.direction,crawler.health,
    pointer(crawler.frame),crawler.frameTicks,...rect(crawler.box)]:null});
 }
 bossEggs.push({direction,camera,states});
}
for(const direction of [0,1,2,3,4,5,6,7])for(const turning of [false,true]){
 const g=new Game(campaign);g.start(2);const b=g.boss,camera=100;
 b.terrain.flat().forEach(t=>t.intact=false);
 const a=b.spawnCrawler({motion:{x:116,y:108-camera},direction});
 if(turning)a.turnTarget=(direction+4)&7;
 let seed=0x5845;const states=[];
 for(let tick=1;tick<=500;tick++){
  const patches=[],bullets=b.updateCrawler(a,camera,{delta:0},
   ()=>seed=(seed*0x6255+0x3619)&65535,{x:160,y:170},tick,(cell,tile)=>patches.push([cell,tile]));
  states.push({tick,seed,patches,state:[a.motion.x,a.motion.y,a.turnTarget,a.direction,
   pointer(a.frame),a.frameTicks,a.fireCounter,...rect(a.box)],
   flags:b.terrain.flat().map(t=>t.intact),bullets:bullets.map(s=>
    [s.x,s.y,s.direction,8,pointer(s.frame)])});
 }
 bossCrawlers.push({direction,turning,states});
}
for(const tile of campaign.stages[1].logic.boss.terrain.flat())for(const dx of [0,15,16]){
 const g=new Game(campaign);g.start(2);g.camera=0;const box={x:tile.x+dx,y:tile.worldY,w:1,h:1};
 const target=g.boss.terrainTarget(box,0);if(target)g.boss.destroyTerrain(target,g);
 bossTerrain.push({box,hit:target?{cell:target.cell,tile:g.map[target.cell],
  effects:g.effects.map(e=>[e.x,e.y])}:null});
}
for(const camera of [0,73]){
 const g=new Game(campaign);g.start(2);g.camera=camera;g.destroy(g.boss);
 bossTwoDeaths.push({camera,credits:g.pickups.map(p=>[p.x,p.y,p.value]),
  effects:g.effects.map(e=>[e.x,e.y]),seed:g.seed,count:g.countedCredits,
  order:g.actorLists.get(ActorList.transient).map(({address,type})=>
   [(address-g.pickups[0].actorAddress)/0x4c,type])});
}
const bossTwoMap=Buffer.from(campaign.stages[1].map.buffer).toString('base64');
const mainToTransient=(()=>{
 const game=new Game(campaign);game.start(2);game.eventStreamsClosed=true;
 game.camera=game.endCamera=100;game.player.x=game.player.y=16;
 game.miniboss=undefined;game.shipTouchesTerrain=()=>false;
 const {boss}=game,event=[100,1,0,0,72,200,0];
 Object.assign(boss,{moveTicks:2,fireCounter:255,wait:340});
 const {actorPool:pool}=game.run,reserved=new Map();
 const main=game.actorLists.get(ActorList.main),core=main.find(({actor})=>actor===boss);
 const gun=new GroundGun(event,game.assets.groundLogic);
 pool.allocate(game.actorLists,ActorList.main,0xec,gun,core);
 while(pool.free.length)pool.allocate(reserved,ActorList.hud,0xc4);
 game.seed=0x5845;
 game.update();
 const round=game.bullets[0];
 return {event,address:gun.actorAddress,expected:{round:[round.actorAddress,round.xFixed,round.yFixed,
  pointer(round.frame)],main:main.map(({address,type})=>[address,type]),seed:game.seed,free:pool.free.at(-1)??0}};
})();
const saturatedHatch=(()=>{
 const game=new Game(campaign);game.start(2);game.eventStreamsClosed=true;
 game.camera=game.endCamera=1000;game.shipTouchesTerrain=()=>false;
 const boss=game.boss,egg=boss.spawnEgg(game.camera,()=>2,(actor,type)=>game.addStageTwoBossActor(actor,type));
 egg.motion={x:164,y:90};egg.state=2;egg.frames=boss.definition.egg.hatch;
 egg.frameIndex=4;egg.frame=egg.frames[egg.frameIndex];egg.frameTicks=1;
 const {actorPool:pool}=game.run,reserved=new Map();
 while(pool.free.length)pool.allocate(reserved,ActorList.hud,0xc4);
 const main=game.actorLists.get(ActorList.main),{actorAddress:address}=egg,states=[];
 for(let i=0;i<2;i++){
  game.update();
  const actor=main.find(slot=>slot.address===address)?.actor;
  states.push({record:actor?[actor.dead?4:0x110,actor.motion.x,actor.motion.y,actor.direction,
   pointer(actor.frame),actor.frameTicks,...rect(actor.box)]:null,free:pool.free.at(-1)??0});
 }
 return {address,states};
})();
const bossArenaPool=(()=>{
 const game=new Game(campaign);game.start(2);game.eventStreamsClosed=true;
 game.camera=game.endCamera=100;game.player.x=game.player.y=16;
 game.miniboss=undefined;game.shipTouchesTerrain=()=>false;
 const states=[],renderer=Object.create(Renderer.prototype);
 const pointers=new Map(game.assets.lookup.flatMap((bank,i)=>[...bank].map(([offset,sprite])=>[sprite,(offset+8)|i])));
 let painted;
 renderer.drawSprite=(sprite,x,y)=>painted.push([pointers.get(sprite),x,y]);
 renderer.drawOverlay=()=>painted.push([0x50]);
 for(let tick=0;tick<900;tick++){
  game.invincible=999;
  game.update();
  const lists=[ActorList.main,ActorList.transient].map(list=>(game.actorLists.get(list)||[])
   .map(({address,type,actor})=>[address,actor.dead?4:type,
    ...(!actor.dead&&type===0x14?[actor.xFixed,actor.yFixed,pointer(actor.frame)]:[]),
    ...(!actor.dead&&[0x10c,0x110].includes(type)?[
     actor.motion.x,actor.motion.y,actor.direction,pointer(actor.frame),actor.frameTicks]:[])]));
  painted=[];renderer.drawStageTwoMain(game,game.actorLists.get(ActorList.main));
  states.push({lists,painted,seed:game.seed,free:game.run.actorPool.free.at(-1)});
 }
 return states;
})();
const miniArenaPool=[1,2].map(players=>{
 const game=new Game(campaign);game.start(2,players);
 if(players===2)game.continueRun();
 game.seed=0x5845;
 game.eventStreamsClosed=true;
 game.camera=game.endCamera=2672;game.player.x=game.player.y=16;
 game.shipTouchesTerrain=()=>false;
 const m=game.miniboss,states=[],clear=88;
 for(let tick=1;tick<=520;tick++){
  game.invincible=999;
  game.divePhase=4;game.diveTime=999;
  game.update();
  if(tick===clear){
   game.addPooledHostileRound({x:20,y:20,dx:1,dy:0,direction:2,fixed:true,frame:game.assets.logic.foregroundShot.frame});
   grantReward(game,18);
  }
  const lists=[ActorList.main,ActorList.transient].map(list=>(game.actorLists.get(list)||[])
   .map(({address,type,actor})=>[address,actor.dead?4:type,
    ...(!actor.dead&&actor.wave?[actor.motion.xFixed,actor.motion.yFixed,actor.motion.remaining,
     {hidden:0x761,masked:0x897,normal:0x853}[actor.drawMode],
     actor.drawMode==='hidden'?0:pointer(actor.frame)]:[]),
    ...(!actor.dead&&list===ActorList.transient?[actor.x,actor.y,actor.angle,pointer(actor.frame)]:[])]));
  states.push({lists,seed:game.seed,free:game.run.actorPool.free.at(-1),busy:m.busy,
   selectors:[...m.selectors],lights:[...m.lights],presence:[...m.presence]});
 }
 m.remaining=1;m.busy=0;
 m.eyes[1].dead=m.eyes[2].dead=true;
 m.eyes[0].box={x:144,y:64,w:16,h:16};
 game.destroy(m.eyes[0]);
 const lastEye={lists:[ActorList.main,ActorList.transient].map(list=>game.actorLists.get(list)
  .map(({address,type,actor})=>[address,actor.dead?4:type])),
  seed:game.seed,free:game.run.actorPool.free.at(-1),count:game.countedCredits};
 return {players,clear,states,lastEye};
});
const linkedPlayerShots=[[1],[14],[15],[18,0],[18,1],[18,2],[21],[20,0],[20,1],[20,2],
 [23,0],[23,1],[23,0,4],[23,1,4],[23,0,4,1]].map(([id,power,stage=2,capacity])=>{
 const game=new Game(campaign), camera=stage===2?1000:3900;
 game.start(stage);game.camera=game.endCamera=camera;
 game.shipTouchesTerrain=()=>false;
 const worldY=camera+(id===21?78:id===23?86:120);
 const background=id===23&&!power?[]:
  [[camera,1,0,0,160,worldY,0],[camera,1,0,0,160,worldY,0],[camera,1,0,0,232,worldY,1]];
 game.assets={...game.assets,events:[],background};
 if([15,18,20,21,23].includes(id)){
  game.credits=100000;game.openShop(stage);
  for(let i=0;i<({15:4,18:2,20:1,21:1,23:1}[id]);i++)if(!buy(game,id).ok)throw Error('Missing weapon');
  if(id===18)for(const weapon of game.inventory.slice(1).filter(Boolean))weapon.power=power;
  if(id===20)game.inventory[0].power=power;
  game.continueRun();if(id!==20)game.inventory[0]=null;
  if(id===15||id===18)game.player.x=186;
 }else game.inventory=[{id,power:1},{id:17,power:0},null,null,null,{id:8,power:0},{id:10,power:2}];
 const {free}=game.run.actorPool, freeHead=free.at(-1);
 if(capacity)free.splice(0,free.length-capacity);
 game.dispatchCameraEvents();
 const states=[], playerTypes=[0x10,0x24,0x28,0x30,0x48,0xb4];
 for(let tick=1;tick<=98;tick++){
  if(tick===97)game.killPlayer();
  game.invincible=999;game.posture=0;
  if(id===20&&tick>=32&&tick<90){
   game.player.x=[8,311,160][Math.floor(tick/10)%3];
   game.player.y=tick%5===1?52:174;
  }
  if(id===23&&tick<97){
   game.player.x=power?160:tick<47?12:174;
   game.player.y=power?150:174;
  }
  const fire=tick<97&&(id===18?tick%8===0:id===20?tick%12<8||tick>=90:
   id===23?[1,25,49,96].includes(tick):tick%6===1);
  game.update({fire});
  const lists=[ActorList.main,ActorList.transient].map(list=>(game.actorLists.get(list)||[])
   .map(({address,type,actor})=>[address,actor.dead?4:type,
    ...(playerTypes.includes(type)||(!actor.dead&&[0x0c,0x14].includes(type))
      ?[actor.x-(actor.beam?.inset||0),actor.y]:[]),
    ...(capacity&&actor.dead&&type===0x0c?[actor.x,actor.y,pointer(actor.frames[0])]:[]),
    ...(!actor.dead&&type===0x0c&&[21,23].includes(id)?[pointer(frameAt(actor.frames,actor.age))]:[]),
    ...(!actor.dead&&type===0x10?[actor.originalSprite?.pointer??pointer(actor.frame),actor.damage-1]:[]),
    ...(!actor.dead&&type===0x24?[actor.beam.length,actor.damage/3-1]:[]),
    ...(!actor.dead&&type===0x28?[pointer(actor.frame),actor.fuse]:[]),
    ...(!actor.dead&&type===0x30?[pointer(actor.frame),...rect(game.bounds(game.sprite(actor.frame),actor.x,actor.y))]:[]),
    ...(type===0x48?[actor.phase,actor.direction,pointer(actor.frame),actor.targetAddress||0]:[]),
    ...(type===0xb4?[actor.xFixed&65535,...(!actor.dead?[pointer(actor.frame),actor.dxFixed/1024,
      Number(actor.damaging),...(actor.damaging?rect(game.bounds(game.sprite(actor.frame),actor.x,actor.y)):[])]:[])]:[]),
    ...(!actor.dead&&[0xe8,0xec,0xd4,0xd0].includes(type)?[actor.health]:[])]));
  states.push({fire,x:game.player.x,y:game.player.y,lists,seed:game.seed,free:free.at(-1)??0,score:game.score});
 }
 return {stage,id,power,capacity,freeHead,background,camera,states};
});
const linkedMines=[2,4].flatMap(stage=>[9,13].map(id=>{
 const game=new Game(campaign), camera=stage===2?1000:3900;
 game.start(stage);game.camera=game.endCamera=camera;
 game.shipTouchesTerrain=()=>false;
 const event=[camera,1,0,0,171,camera+13,0], background=[event,event];
 game.assets={...game.assets,events:[],background};
 game.credits=100000;game.openShop(stage);
 if(!buy(game,id).ok)throw Error('Missing Mine');
 game.continueRun();game.inventory[0]=null;
 game.player.y=96;game.invincible=1000;
 game.dispatchCameraEvents();
 const states=[];
 for(let tick=1;tick<=179;tick++){
  if(tick===178)game.killPlayer();
  game.posture=0;
  const fire=tick<178&&(tick<=82||tick>=130);
  const right=tick<35||tick>=65&&tick<79,left=tick>=41&&tick<65;
  const down=tick>=35&&tick<45,up=tick>=50&&tick<59;
  game.update({fire,up,down,left,right});
  const [main,transient]=[ActorList.main,ActorList.transient].map(list=>(game.actorLists.get(list)||[])
   .map(({address,type,actor})=>[address,actor.dead?4:type,
    ...([0x38,0x3c].includes(type)?[actor.x,actor.y,actor.fuse,pointer(actor.frame)]:[]),
    ...(!actor.dead&&type===0x0c?[actor.x,actor.y,pointer(frameAt(actor.frames,actor.age))]:[]),
    ...(!actor.dead&&stage===4&&type===0x14?[actor.x,actor.y,pointer(actor.frame)]:[]),
    ...(!actor.dead&&[0xec,0xd4].includes(type)?[actor.health]:[])]));
  const {x,y,phase}=game.mine;
  states.push({x:game.player.x,y:game.player.y,input:(fire?128:0)|(up?1:0)|(down?2:0)|(left?4:0)|(right?8:0),
   pose:[x,y,phase,pointer(frameAt(game.assets.logic.mountFrames[id],game.weaponAges.get(game.inventory[5])))],
   main,transient,count:game.run.mineChargeCount,seed:game.seed,free:game.run.actorPool.free.at(-1),score:game.score});
 }
 game.restoreCheckpoint();
 return {stage,id,background,states,checkpointCount:game.run.mineChargeCount};
}));
const stageTwoDrone=[0,1,2].map(power=>{
 const game=new Game(campaign);game.start(2);game.camera=game.endCamera=1000;
 game.shipTouchesTerrain=()=>false;
 const event=[1000,1,0,0,160,1120,0], background=[event,event];
 game.assets={...game.assets,events:[],background};
 game.credits=100000;game.openShop(2);
 if(!buy(game,19).ok)throw Error('Missing Drone');
 game.inventory[5].power=power;game.continueRun();game.inventory[0]=null;
 // Keep the ship out of contact range without moving the trailing Drone out of shot range.
 game.player.y=88;game.playerTrail=Array.from({length:3},()=>({x:160,y:88}));
 const initial=power===2?Array.from({length:78},()=>[250,50,0,0]):[];
 for(const [slot,[x,y,dx,dy]] of initial.entries())if(slot!==1)game.droneShots[slot]={x,y,dx,dy,age:0};
 game.dispatchCameraEvents();
 const toughHealth=power===0?0x5442:0;
 if(toughHealth)game.ground.at(-1).health=toughHealth;
 const cell=game.ground[0].cell,cells=[cell,cell+1,cell+20,cell+21];
 const initialTiles=cells.map(i=>game.assets.map[i]);
 const renderer=Object.create(Renderer.prototype);
 let flashes;
 renderer.drawOverlay=(r,mask)=>{if(mask==='vga-hit')flashes.push([r.x,r.y,r.width,r.tiles]);};
 const states=[];
 for(let tick=1;tick<=64;tick++){
  if(tick===7)for(let i=0;i<initial.length;i++)if(i!==1)game.droneShots[i]=null;
  if(tick===63)game.killPlayer();
  game.invincible=999;game.posture=0;
  const fire=tick<63;
  game.update({fire,right:tick%16<6,left:tick%16>=8&&tick%16<14});
  const paint=game.actorPaint?.tick===game.tick?game.actorPaint:undefined;
  const main=game.actorLists.get(ActorList.main)||[];
  const transients=game.actorLists.get(ActorList.transient)||[];
  flashes=[];renderer.drawStageTwoMain(game,paint?.main??main);
  states.push({fire,anchor:game.playerTrail[0],x:game.player.x,y:game.player.y,
   table:game.droneShots.map(s=>s?[s.x,s.y,s.dx,s.dy]:null),
   guns:main.filter(r=>r.type===0xec)
    .map(({address,actor})=>[address,actor.dead?4:0xec,actor.dead?0:actor.health]),
   flashes,
   paintTiles:cells.map(i=>paint?(paint.mapPatches.get(i)??game.assets.map[i]):game.map[i]),
   tiles:cells.map(i=>game.map[i]),
   blasts:(paint?.transient??transients).filter(({type,actor})=>type===0x0c&&!actor.dead)
     .map(({address,actor})=>[address,pointer(actor.frames[actor.age])]),
   seed:game.seed,free:game.run.actorPool.free.at(-1),score:game.score});
 }
 return {power,background,initial,initialTiles,cells,toughHealth,states};
});
const linkedElectro=[2,4].map(stage=>{
 const game=new Game(campaign), camera=stage===2?1000:3900;
 game.start(stage);game.camera=game.endCamera=camera;
 game.shipTouchesTerrain=()=>false;
 const event=[camera,1,0,0,160,camera+118,0], background=[event,event];
 game.assets={...game.assets,events:[],background};
 game.player.y=90;game.credits=100000;game.openShop(stage);
 if(!buy(game,11).ok)throw Error('Missing Electro Ball');
 game.continueRun();game.invincible=999;
 game.playerTrail=Array.from({length:3},()=>({x:160,y:90}));
 game.dispatchCameraEvents();
 const weapon=game.inventory[5], states=[];
 for(let tick=1;tick<=42;tick++){
  game.posture=0;
  const fire=tick===1||tick>=7&&tick<=15||tick>=32;
  const before=[game.player.x,game.player.y];
  game.update({fire,right:tick>=8&&tick<16,left:tick>=18&&tick<26,up:tick>=33&&tick<39});
  const {x,y,phase}=game.electroBall;
  const frame=frameAt(game.assets.logic.mountFrames[11],game.weaponAges.get(weapon));
  const lists=[ActorList.main,ActorList.transient].map(list=>(game.actorLists.get(list)||[])
   .map(({address,type,actor})=>[address,actor.dead?4:type,
    ...(!actor.dead&&[0xec,0xd4].includes(type)?[actor.health]:[]),
    ...(!actor.dead&&[0x0c,0x10,0x14].includes(type)?[actor.x,actor.y]:[]),
    ...(!actor.dead&&type===0x0c?[pointer(frameAt(actor.frames,actor.age))]:[])]));
  states.push({fire,pulse:fire&&game.fireCooldown===game.firePeriod,
   before,player:[game.player.x,game.player.y],trail:game.playerTrail[0],
   pose:[x,y,{idle:0,active:1,returning:65535}[phase],pointer(frame)],
   box:phase==='active'?rect(game.bounds(game.sprite(frame),x,y)):null,
   lists,seed:game.seed,free:game.run.actorPool.free.at(-1),score:game.score});
 }
 return {stage,camera,background,states};
});
const stageTwoNashwan=[2,4].map(stage=>{
 const game=new Game(campaign);game.start(stage);game.camera=game.endCamera=1000;
 game.assets={...game.assets,events:[],background:[]};
 game.shipTouchesTerrain=()=>false;game.invincible=999;game.player.y=144;
 game.playerTrail=Array.from({length:3},()=>({x:160,y:144}));
 game.player.nashwan=38;activateNashwan(game);
 const states=[],renderer=Object.create(Renderer.prototype);
 renderer.assets=game.assets;
 const meterSprites=new Map(game.assets.logic.nashwan.meter.map(frame=>[game.sprite(frame),pointer(frame)]));
 let meter;
 renderer.drawSprite=(sprite,x,y)=>meter=[meterSprites.get(sprite),x,y];
 let painted,positions;
 renderer.drawPlayerRound=(_,shot)=>painted.push(shot.actorAddress);
 renderer.drawMountFrame=(_,frame,x,y)=>painted.push(positions.get(`${x},${y}`));
 for(let tick=1;tick<=40;tick++){
  game.posture=0;
  const fire=tick<=13||tick>=22&&tick!==39;
  game.update({fire,right:tick>=5&&tick<14,left:tick>=18&&tick<26,up:tick>=28&&tick<33});
  const records=game.actorLists.get(ActorList.transient)||[];
  const transient=records.map(({address,type,actor})=>
   [address,actor.dead?4:type,
    ...(!actor.dead&&type!==0x40?[actor.x,actor.y]:[]),
    ...(!actor.dead&&type===0x10?[actor.originalSprite.pointer]:[]),
    ...(!actor.dead&&type===0x24?[actor.beam.length]:[]),
    ...(!actor.dead&&type===0x30?[pointer(actor.frame)]:[])]);
  const mounts=game.actorLists.get(ActorList.mounts);
  const expiry=game.nashwanExpiryFrame;
  const paintedMounts=expiry?.mounts??mounts, paintedRecords=expiry?.transient??records;
  painted=[];positions=new Map();
  for(const {address,actor:{slot,weapon}} of paintedMounts){
   const mount=weaponAttachment(game,slot,weapon);
   if(mount)positions.set(`${mount.x},${mount.y}`,address);
  }
  renderer.drawMounts(game,paintedMounts,expiry?.inventory);
  const mountPainted=painted;
  painted=[];positions=new Map();
  for(const {address,actor:{mount}} of paintedRecords.filter(r=>r.type===0x40)){
   const {x,y}=weaponAttachment(game,mount.slot,mount.weapon).overlayPosition;
   positions.set(`${x},${y}`,address);
  }
  renderer.drawTransient(game,paintedRecords);
  meter=null;renderer.drawTimer(game,game.nashwanMeterTime,0xaa,152,160);
  states.push({fire,pulse:fire&&game.fireCooldown===game.firePeriod,player:[game.player.x,game.player.y],
   trail:game.playerTrail[0],transient,painted,mountPainted,free:game.run.actorPool.free.at(-1),
   mounts:mounts.map(({address,type})=>[address,type]),remaining:game.player.nashwan,meter,
   drone:game.droneShots.map(s=>s?[s.x,s.y,s.dx,s.dy]:null)});
 }
 return states;
});
const maneuverJets=(()=>{
 const game=new Game(campaign);game.start(2);game.eventStreamsClosed=true;
 game.shipTouchesTerrain=()=>false;game.miniboss=undefined;
 game.camera=game.endCamera=1000;game.player.y=96;game.resetDive();
 const renderer=Object.create(Renderer.prototype);renderer.assets=game.assets;
 const pointers=new Map(game.assets.logic.maneuverJets.flatMap(({frames})=>
  frames.map(frame=>[game.sprite(frame),pointer(frame)])));
 let painted;renderer.drawSprite=(sprite,x,y)=>painted.push([pointers.get(sprite),x,y]);
 return Array.from({length:48},(_,tick)=>{
  const up=tick%8<3,down=tick%6>=3,left=tick<12,right=tick>=16&&tick<32;
  if(tick===44)game.killPlayer();
  game.update({up,down,left,right,dive:tick===16||tick===26});
  painted=[];renderer.drawManeuverJets(game);
  return {input:(up?1:0)|(down?2:0),dive:tick===16?0:game.divePhase,bank:game.control.bank,
   player:[game.player.x,game.player.y],painted};
 });
})();
const checkpoints=[];
for(const stage of campaign.stages){
 const g=new Game(campaign);g.start(stage.number);
 for(const [index,event] of stage.background.filter(e=>e[1]===0).entries()){
  g.credits=70000+stage.number*100+index;
  g.player.nashwan=index%3===1?150:0;
  g.inventory=[{id:0x14,power:index%3},null,{id:0x34,power:0},null,
   {id:0x3c,power:stage.number%3},null,null];
  g.saveCheckpoint(event);
  const {camera,x,worldY,credits,inventory}=g.checkpoint;
  checkpoints.push({stage:stage.number,index,event,timer:g.player.nashwan,
   balance:g.credits,inventory:g.inventory.map(w=>w?[w.id,w.power]:[0,0]),
   saved:[camera,x,worldY,credits,...inventory.map(w=>w?[w.id,w.power]:[0,0])]});
 }
}
const game=new Game(campaign);game.start();game.assets={...game.assets,events:[],background:[]};
game.player.lives=1;game.damage(39);
const deathFrames=[];
while(game.status==='dying'){
 deathFrames.push(pointer(frameAt(game.assets.logic.playerDeath,game.deathAge)));
 game.update();
}
const countdown=[];
while(game.status==='continue'){countdown.push(game.continueTicks>>3);game.update();}
const foreground=[],foregroundBullets=[],composites=[],rewards=[],stageTransitions=[],protection=[];
const ship = new Game(campaign);
for(let stage=1;stage<=5;stage++){
 for(const [type,rate,x,y,heading] of [[1,30,-32,-20,32],[1,120,100,65,112],
  [1,255,200,40,0],[1,100,260,90,64],
  ...(stage===3?[[-30,-12],[-12,-30],[-12,200],[342,-12],[342,-40],[342,220]]
   .map(([x,y])=>[4,105,x,y,0]):[])]){
  ship.start(stage);
  const path=new Uint8Array(Int16Array.of(10,x,y,2,heading,0,0,1000,0).buffer);
  ship.assets={...ship.assets,paths:{bytes:path,offsets:[0]}};
  ship.spawn([0,type,1,1,0,rate,type===4?0:3]);
  ship.seed=0x5845;
  const enemy=ship.enemies[0];
  enemy.fireCounter=250;
  let operand=0;
  const states=[];
  for(let tick=0;tick<(type===4?1:80);tick++){
   ship.bullets.length=0;
   operand=ship.updateForeground(enemy,operand);
   states.push([enemy.motion.xFixed,enemy.motion.yFixed,enemy.fireCounter,ship.seed,operand,
    pointer(ship.enemyFrame(enemy)),...ship.bullets.map(b=>[b.x,b.y,b.direction,pointer(b.frame)])]);
  }
  foreground.push({stage,type,rate,x,y,heading,states});
 }
 for(const [x,y,direction,scroll,dive] of [[45,30,3,1,false],[300,22,7,-1,false],
  [1,40,6,1,false],[316,40,2,-1,false],[80,2,0,0,false],[80,187,4,0,false],
  [160,150,4,1,false],[160,150,4,1,true],[153,164,2,-1,false]]){
  ship.start(stage);
  ship.eventStreamsClosed=true;
  ship.map.fill(0);
  ship.control.scrollDirection=scroll||1;
  if(!scroll)ship.endCamera=ship.camera=ship.control.ceiling=4000;
  else ship.camera=4000;
  if(dive)ship.divePhase=4;
  const {frame,vectors}=ship.assets.logic.foregroundShot;
  const [dx,dy]=vectors[direction];
  const bullet={x,y,dx:dx*6,dy:dy*6,direction,frame,fixed:true,foreground:true,damage:4};
  ship.bullets.push(bullet);
  const states=[];
  for(let tick=0;tick<18&&!bullet.dead;tick++){
   if(scroll<0)ship.control.ceiling=ship.camera+16;
   ship.update();
   states.push([bullet.xFixed,bullet.yFixed,bullet.dead??false,ship.player.health,pointer(bullet.frame)]);
  }
  foregroundBullets.push({stage,x,y,direction,scroll,dive,states});
 }
}
for(const [stage,type] of [[1,7],[3,3],[4,1]]){
 ship.start(stage);
 const events=ship.assets.events.filter(e=>e[1]===type);
 for(const event of [events[0],events.at(-1)]){
  ship.start(stage);
  ship.spawn(event);
  const actors=ship.enemies.flatMap(actor=>[actor,...actor.children]);
  const updates=ship.enemies.slice().reverse().flatMap(actor=>[actor,...actor.children]);
  const state=()=>[ship.seed,actors.map(a=>[a.motion.xFixed,a.motion.yFixed,a.motion.heading>>>16,
   a.motion.remaining||0,a.fireCounter,Number(Boolean(a.dead)),a.dead?0:pointer(ship.enemyFrame(a))])];
  const states=[state()];
  for(let tick=0;tick<(event===events[0]?48:80)&&!actors.some(a=>a.dead);tick++){
   let operand=0;
   for(const a of updates)operand=ship.updateForeground(a,operand);
   states.push(state());
  }
  const death=actors.some(a=>a.dead)?null:{};
  if(death){
   for(const root of ship.enemies){
    ship.hitWithWeapon(root.children.at(-1),{damage:127});
   }
   Object.assign(death,{seed:ship.seed,score:ship.score,
    dead:actors.map(a=>a.dead),effects:ship.effects.map(e=>[e.x,e.y,e.large,e.frames.map(pointer)]),
    credits:ship.pickups.map(p=>[p.x,p.y,p.value,p.state,p.direction&7])});
  }
  composites.push({stage,event,states,death});
 }
}
for(const reward of campaign.rewards)for(const [x,y] of [[15,10],[-12,220]]){
 ship.start();
 ship.eventStreamsClosed=true;
 ship.divePhase=4;
 ship.spawn([0,0,1,1,0,0,reward.id]);
 const pod=ship.enemies[0];
 pod.motion.xFixed=x*65536;pod.motion.yFixed=y*65536;
 ship.destroy(pod);
 const drop=ship.pickups[0],states=[];
 for(let tick=0;tick<240&&!drop.dead;tick++){
  states.push([drop.x,drop.y,drop.state,drop.direction,pointer(ship.pickupFrame(drop))]);
  ship.update();
 }
 rewards.push({id:reward.id,x,y,states,removed:drop.dead===true});
}
for(const [stage,round] of [[1,1],[4,2],[5,1],[5,2]]){
 ship.start(stage);ship.campaignRound=round;
 ship.player.x=137;ship.player.health=17;ship.player.lives=2;
 ship.status='shop';ship.credits=100000;
 if(!buy(ship,15).ok)throw Error('Missing transition mount');
 ship.score=70020;ship.credits=70245;ship.continues=1;ship.inventory[0].power=2;
 if(stage===5)ship.status='ending';
 ship.shopStage=stage+1;
 if(stage===5)ship.finishVictory();else ship.continueRun();
 stageTransitions.push({stage,round,state:[ship.stage,ship.campaignRound,ship.continues,
  ship.score,ship.credits,ship.checkpoint.credits,ship.player.x,ship.player.y,
  ship.player.health,ship.player.lives,ship.inventory[0].power,ship.camera,ship.control.ceiling,ship.posture,
  ship.inventory[1]?.id||0]});
}
for(const [shield,counted,energy,hits] of [[false,0,39,[4,8,7]],[true,0,39,[4,8,7,1]],
 [true,0,5,[7,5]],[false,1,39,[30]]]){
 ship.start();
 Object.assign(ship.player,{protection:shield,health:energy});ship.countedCredits=counted;
 const states=hits.map(hit=>{ship.damage(hit);return [ship.player.health,ship.player.protection,ship.status==='dying'];});
 protection.push({shield,counted,energy,hits,states});
}
const diveTraces=[];
for(const presses of [[0],[0,2],[0,4],[0,10,14],[0,8,18],[0,141]]){
 ship.start();
 ship.map.fill(0);
 ship.eventStreamsClosed=true;
 ship.camera=ship.endCamera=ship.control.ceiling=4000;
 ship.resetDive();
 const states=[];
 for(let tick=0;tick<(presses.at(-1)>20?148:presses.length===1?145:26);tick++){
  const pickup={kind:'reward',reward:0,x:141,y:158,age:0,state:0,direction:0};
  ship.pickups=[pickup];
  ship.update({dive:presses.includes(tick)});
  states.push([ship.divePhase,ship.diveStep,ship.diveTime,ship.terrainRecovery,ship.posture,
   ship.divePose?pointer(ship.assets.logic.diveFrames[ship.divePose]):0,ship.diveMasked,ship.player.dives,
   !!pickup.dead]);
 }
 diveTraces.push({presses,states});
}
const timedMeters=[[220,222],[3,7]].map(([shades,ticks])=>{
 ship.start();
 ship.map.fill(0);
 ship.eventStreamsClosed=true;
 ship.camera=ship.endCamera=ship.control.ceiling=4000;
 ship.resetDive();
 ship.player.shades=shades;
 const sprites=new Map(ship.assets.logic.nashwan.meter.map(frame=>[ship.sprite(frame),pointer(frame)]));
 const draws=[];
 const renderer=Object.assign(Object.create(Renderer.prototype),{
  assets:ship.assets,map:ship.map,mapRevision:ship.mapRevision,world:{},
  context:Object.fromEntries(['drawImage','save','beginPath','rect','clip','restore','fillText','fillRect']
    .map(name=>[name,()=>{}])),
  drawSprite(sprite,x,y){if(sprites.has(sprite))draws.push([sprites.get(sprite),x,y]);},
 });
 const states=Array.from({length:ticks},(_,tick)=>{
  const kill=ticks===7&&tick===2, request=tick===0||ticks===7&&tick<4;
  if(kill)ship.killPlayer();
  ship.update({dive:request});
  draws.length=0;renderer.draw(ship);
  return {kill,request,draws:draws.slice(),remaining:[ship.player.shades,ship.diveTime,ship.diveStep,ship.posture]};
 });
 return {shades,states};
});
const terrainHull=[];
for(let stage=1;stage<=5;stage++){
 ship.start(stage);
 const states=[];
 for(let i=0;i<320;i++){
  ship.camera=1200+i*9;
  ship.player.x=16+(i%16)+Math.floor(i/16)%18*16;
  ship.player.y=16+i*29%161;
  states.push([ship.camera,ship.player.x,ship.player.y,ship.shipTouchesTerrain()]);
 }
 terrainHull.push({stage,map:Array.from(ship.map),states});
}
const diveRecoveries=[];
for(const escape of [true,false]){
 ship.start();
 ship.map.fill(0);
 ship.eventStreamsClosed=true;
 ship.camera=ship.endCamera=ship.control.ceiling=4000;
 ship.player.x=155;
 ship.resetDive();
 for(let row=259;row<=261;row++)for(let col=escape?12:9;col<=12;col++){
  ship.map[row*20+col]=1<<6;
 }
 ship.assets={...ship.assets,terrainMasks:[new Array(16).fill(0),new Array(16).fill(65535)]};
 const states=[];
 for(let tick=0;tick<13;tick++){
  ship.update({right:tick>0&&tick<12,dive:tick===0||tick===4});
  states.push([ship.player.x,ship.player.y,ship.terrainRecovery,ship.status==='dying']);
 }
 diveRecoveries.push({escape,states});
}
const terrainRecoveries=[];
for(const mode of ['brush','clear','fatal','counted','lower-limit','upper-limit']){
 ship.start();
 ship.map.fill(0);
 ship.eventStreamsClosed=true;
 ship.camera=ship.control.ceiling=4000;
 ship.endCamera=3900;
 ship.player.x=['fatal','counted','lower-limit','upper-limit'].includes(mode)?162:159;
 ship.player.y=mode==='upper-limit'?16:174;
 ship.resetDive();
 const row=Math.floor((4000+ship.player.y)/16);
 for(let r=row-2;r<=row+2;r++)ship.map[r*20+11]=64;
 ship.assets={...ship.assets,terrainMasks:[new Array(16).fill(0),new Array(16).fill(65535)]};
 if(mode==='counted')ship.countedCredits=1;
 const states=[];
 for(let tick=0;tick<23;tick++){
  if(mode==='clear'&&tick===1)ship.map.fill(0);
  const bits=(tick===0?8:4)|(mode==='lower-limit'?2:mode==='upper-limit'?1:0);
  ship.update({left:bits&4,right:bits&8,up:bits&1,down:bits&2});
  states.push({bits,state:[ship.player.x,ship.player.y,ship.camera,ship.control.ceiling,
    ship.control.bank,ship.terrainRecovery,ship.status==='dying']});
  if(ship.status==='dying')break;
 }
 terrainRecoveries.push({mode,states});
}
const ringTrace=[];
ship.start();
ship.map.fill(0);
ship.eventStreamsClosed=true;
ship.camera=ship.endCamera=ship.control.ceiling=4000;
ship.resetDive();
for(let tick=0;tick<580;tick++){
 const grant=[0,12,37].includes(tick), dive=tick===4||tick===25;
 const right=tick>5&&tick<19, left=tick>27&&tick<40;
 if(grant)ship.grantInvulnerability();
 ship.update({left,right,dive});
 const ring=ship.invulnerabilityRing;
 ringTrace.push({grant,dive,left,right,state:[ship.invincible,ship.posture,
  ring?[pointer(ring.frame),ring.x,ring.y]:null]});
}
const shadeTraces=[];
for(const [timer,phase,boxes] of [
 [220,0,[[225,90],[224,90],[112,90]]],
 [220,0,[[94,90],[96,154],[200,90]]],
 [220,0,[[224,155],[200,25],[224,26]]],
 [220,4,[[224,90],[112,90]]],
 [1,0,[[225,90],[224,90]]],
 [0,0,[[224,90],[225,90]]],
]){
 ship.start();
 ship.map.fill(0);
 ship.eventStreamsClosed=true;
 ship.camera=ship.endCamera=ship.control.ceiling=4000;
 ship.player.y=90;
 ship.player.shades=timer;
 ship.divePhase=phase;
 ship.ground=boxes.map(([x,y])=>({ground:true,spriteActor:true,health:1000,update(){},
  bounds:()=>({x,y,w:1,h:1})}));
 ship.update();
 shadeTraces.push({timer,phase,boxes,countdown:ship.player.shades,
  damage:ship.ground.map(actor=>1000-actor.health)});
}
const terrainWormTraces=[];
for(const [route,seeded] of [...Array.from({length:17},(_,i)=>[i-1,false]),[14,true]]){
 ship.start();
 ship.run.actorPool=new ActorPool();
 ship.actorLists.clear();
 const pool=ship.run.actorPool;
 if(seeded){
  pool.subpixels.set(0x9f98,[0xf000,0x9000]);
  pool.headings.set(0x9f98,96);
  pool.headings.set(0x9fe4,192);
 }
 const worms=ship.terrainWorms;
 const {openings}=worms.data;
 const origin=route<0?3345:Math.min(3344,openings[route].y-80);
 if(route>=0)worms.rotations[0]=route<<3;
 const states=[];
 for(let tick=0;tick<(route<0?750:670);tick++){
  const camera=route<0?origin-tick:origin-Math.min(tick,30)+Math.max(0,Math.min(30,tick-30));
  const delta=route<0||tick<30?1:tick<60?-1:0;
  ship.control.ceiling=camera+16;
  if(route>=0)worms.present.fill(true,1);
  worms.dispatch(ship,camera);
  const aimOperand=worms.update(ship,delta,0x5a5a);
  const groups=worms.groups.map(g=>!g||!g.driver.active&&!g.parts.length?null:
   [g.parts.map(p=>{
    const box=ship.bounds(ship.sprite(p.frame),0,0);
    return [p.motion.x,p.motion.y,p.heading,p.remaining,pointer(p.frame),!p.hidden,
     [box.x,box.y,box.w,box.h]];
   }),
    g.driver.active?[g.driver.xFixed,g.driver.yFixed,g.driver.heading>>>16,g.driver.remaining]:null]);
  states.push({camera,delta,aimOperand,scene:[ship.control.ceiling,worms.rotations.slice(),worms.openTicks.slice(),
   openings.map(o=>ship.map[o.cell]),groups,worms.order.filter(slot=>groups[slot]),
   (ship.actorLists.get(ActorList.main)||[]).map(({address,actor,type})=>[address,actor.dead?4:type]),
   pool.free.at(-1)??0]});
  if(route>=0&&!groups[0]&&tick>0)break;
 }
 terrainWormTraces.push({route,seeded,states});
}
const terrainWormDeaths=[];
const wormHits=[160,96,39], wormEdges=[[319,96,0],[160,191,64],[0,96,128],[160,0,192]];
for(const [body,[x,y,angle],reuse] of [
 ...[false,true].flatMap(body=>[wormHits,...wormEdges].map(hit=>[body,hit,null])),
 [true,wormHits,"self"],[false,wormHits,"segment"],[false,wormHits,"transient"],
]){
 ship.start();
 ship.run.actorPool=new ActorPool();
 ship.actorLists.clear();
 const pool=ship.run.actorPool,transient=ActorList.transient;
 const worms=ship.terrainWorms,camera=3240;
 worms.rotations[0]=9<<3;
 worms.present.fill(true,1);
 worms.dispatch(ship,camera);
 worms.update(ship,1);
 const parts=worms.groups[0].parts;
 const part=reuse==="self"?parts.at(-1):parts[Number(body)];
 part.motion={x,y};
 const seed=ship.seed=((angle-25)*253)&255;
 if(reuse==="transient")pool.allocate(ship.actorLists,transient,0xc,{});
 if(reuse)pool.free.length=0;
 ship.hitWithWeapon(part,{damage:1});
 const [record]=ship.actorLists.get(transient);
 const corpse=record.actor;
 const snapshot=()=>{
  const list=ship.actorLists.get(transient);
  return [pool.free.at(-1)??0,list.includes(record)?corpse.dead?4:record.type:0,
   corpse.x,corpse.y,pointer(corpse.frame),list.filter(r=>!r.actor.dead).map(r=>r.address)];
 };
 const main=ship.actorLists.get(ActorList.main).map(({address,actor,type})=>[address,actor.dead?4:type]);
 const first=[ship.seed,ship.score,corpse.heading,record.address,main,snapshot()];
 const states=[];
 for(let tick=0;tick<48;tick++){
  for(const [,slot] of pool.walk(ship.actorLists,transient))ship.updateTransientActor(slot);
  states.push(snapshot());
  if(!ship.actorLists.get(transient).includes(record))break;
 }
 terrainWormDeaths.push({body,x,y,seed,reuse,first,states});
}
const terrainWormClear=[false,true].map(full=>{
 ship.start();
 ship.run.actorPool=new ActorPool();
 ship.actorLists.clear();
 const pool=ship.run.actorPool,worms=ship.terrainWorms;
 ship.camera=ship.control.camera=3240;
 worms.rotations[0]=9<<3;
 worms.present.fill(true,1);
 worms.dispatch(ship,ship.camera);
 worms.update(ship,1);
 if(full)pool.free.length=0;
 grantReward(ship,18);
 const main=ActorList.main,transient=ActorList.transient;
 const state=()=>({
  main:ship.actorLists.get(main).map(({address,actor,type})=>[address,actor.dead?4:type]),
  corpses:ship.actorLists.get(transient).map(({address,actor,type})=>
   [address,actor.dead?4:type,actor.x,actor.y,pointer(actor.frame),actor.heading]),
  free:pool.free.at(-1)??0,seed:ship.seed,score:ship.score,
 });
 const states=[state()];
 worms.update(ship,0);
 for(const [,slot] of pool.walk(ship.actorLists,transient))ship.updateTransientActor(slot);
 states.push(state());
 return {full,states};
});
const mixedGunEvent=[3240,1,0,0,118,3324,0];
function wormContactScene(groundOrder){
 ship.start();
 ship.run.actorPool=new ActorPool();
 ship.actorLists.clear();
 ship.assets={...ship.assets,events:[],background:[]};
 ship.camera=ship.control.camera=ship.endCamera=3240;
 ship.shipTouchesTerrain=()=>false;
 const addGun=()=>{
  const gun=new GroundGun(mixedGunEvent,ship.assets.groundLogic);
  ship.run.actorPool.allocate(ship.actorLists,ActorList.main,0xec,gun);
  ship.ground.push(gun);
  ship.updateGroundActor(gun);
 };
 if(groundOrder==='worm-first')addGun();
 const worms=ship.terrainWorms;
 worms.rotations[0]=9<<3;
 worms.present.fill(true,1);
 worms.dispatch(ship,ship.camera);
 worms.update(ship,1);
 if(groundOrder==='gun-first')addGun();
 ship.eventStreamsClosed=true;
 return worms;
}
const terrainWormContacts=['ram','steer-in','fatal','hidden','marked','protected','invincible','counted','gun','gun-edge'].map(mode=>{
 const gun=mode.startsWith('gun');
 const worms=wormContactScene(gun?'gun-first':null);
 if(mode==='marked')worms.groups[0].parts.at(-1).dead=true;
 const right=Math.max(...worms.targets.filter(p=>!p.hidden).map(p=>p.contactBox.x+p.contactBox.w-1));
 const hull=ship.bounds(ship.shipSprite(),0,0);
 const x=ship.player.x=mode==='gun-edge'?138-hull.x:['hidden','marked','gun'].includes(mode)?120:
  right-hull.x+Number(mode==='steer-in');
 const y=ship.player.y=mode==='gun-edge'?104-hull.y:80;
 const health=ship.player.health=mode==='fatal'?8:39;
 const protectedShip=ship.player.protection=mode==='protected';
 const invincible=ship.invincible=mode==='invincible'?6:0;
 const counted=ship.countedCredits=Number(mode==='counted');
 const seed=ship.seed;
 const shipFrame=pointer(ship.assets.logic.playerBank[6]);
 ship.update({left:mode==='steer-in',right:mode!=='steer-in'});
 const corpses=(ship.actorLists.get(ActorList.transient)||[]).map(({address,actor,type})=>[
  address,actor.dead?4:type,actor.x,actor.y,
  pointer(type===0x0c?actor.frames[actor.age]:actor.frame),...(type===0x0c?[]:[actor.heading])]);
 return {mode,x,y,gunEvent:gun?mixedGunEvent:null,health,protectedShip,invincible,counted,seed,shipFrame,expected:{
  x:ship.player.x,health:ship.player.health,score:ship.score,seed:ship.seed,flash:ship.shipHitFlash,
  dying:ship.status==='dying',corpses}};
});
const terrainWormWeapons=[
 ...['straight','point-miss','cannon','saturated','drone','shades','marked-shades','shades-gate'].map(mode=>[mode,null]),
 ...['gun-first','worm-first'].flatMap(order=>['straight','cannon','drone','shades'].map(mode=>[mode,order])),
 ['marked-gun-shades','gun-first'],
].map(([mode,groundOrder])=>{
 const worms=wormContactScene(groundOrder);
 const tail=worms.groups[0].parts.at(-1), usesShades=mode.includes('shades');
 const x=mode==='point-miss'||mode==='shades-gate'?220:120;
 const cannon=mode==='cannon', drone=mode==='drone';
 const frame=cannon?ship.assets.logic.cannon.shot[0]:null;
 const rounds=Array.from({length:usesShades?0:2},(_,i)=>({x:mode==='saturated'&&!i?220:x,
  y:cannon?90:80,dx:0,dy:cannon?-10:mode==='saturated'&&!i?-1:0,
  point:!cannon,cannon,piercing:cannon,frame,damage:cannon?2:1,age:0}));
 const pool=ship.run.actorPool, transient=ActorList.transient;
 if(usesShades){
  ship.player.x=x;ship.player.y=80;ship.player.shades=5;
  if(mode==='marked-shades')tail.dead=true;
  if(mode==='marked-gun-shades')ship.ground[0].dead=true;
  if(mode==='shades-gate')tail.contactBox={...tail.contactBox,x:220};
 }else if(drone)ship.droneShots.splice(0,2,...rounds);
 else for(const round of rounds)ship.addPlayerRound(round,cannon?0x30:0x10);
 if(mode==='saturated')pool.free.length=0;
 const seed=ship.seed, shipFrame=pointer(ship.assets.logic.playerBank[6]);
 ship.update();
 const expected={
  main:ship.actorLists.get(ActorList.main).map(({address,actor,type})=>[address,actor.dead?4:type]),
  score:ship.score,seed:ship.seed,spent:rounds.map((r,i)=>drone?!ship.droneShots[i]:Boolean(r.dead))};
 const snapshot=()=>{
  const records=ship.actorLists.get(transient)||[];
  return {free:pool.free.at(-1)??0,draw:records.filter(({actor})=>!actor.dead).map(({address})=>address),
   records:records.map(({address,actor,type})=>[address,actor.dead?4:type,actor.x,actor.y,
    type===0x0c?pointer(actor.frames[actor.age]):actor.frame?pointer(actor.frame):0])};
 };
 if(!drone&&!usesShades){
  expected.transient=[snapshot()];
  ship.update();
  expected.transient.push(snapshot());
 }
 return {mode,groundOrder,gunEvent:groundOrder?mixedGunEvent:null,x,seed,shipFrame,frame:frame?pointer(frame):null,expected};
});
const stageOneGunPool=[false,true].map(recycle=>{
 ship.start();
 ship.run.actorPool=new ActorPool();
 ship.actorLists.clear();
 const pool=ship.run.actorPool;
 ship.camera=ship.control.camera=ship.endCamera=4300;
 ship.control.ceiling=4316;
 ship.boss=undefined;
 ship.player.x=300;
 ship.shipTouchesTerrain=()=>false;
 const background=recycle?[[4300,1,0,0,72,4340,0]]:
  [1,2,3].flatMap((kind,i)=>[0,1].map(side=>[4300,kind,0,0,72+side*144,4340+i*48,side]));
 ship.assets={...ship.assets,events:[],background};
 ship.update();
 const states=[];
 for(let i=0;i<(recycle?3:130);i++){
  if(i===1&&recycle){
   const expired={x:260,y:80,dx:0,dy:0,point:true,damage:1,age:0};
   ship.addPlayerRound(expired);
   expired.dead=true;
   pool.subpixels.set(expired.actorAddress,[0xc000,0x9000]);
   pool.free.length=0;
   ship.ground[0].fireCounter=255;
  }
  if(i===128){
   ship.camera=ship.control.camera=ship.endCamera=4000;
   ship.control.ceiling=4016;
  }
  ship.update();
  const main=(ship.actorLists.get(ActorList.main)||[]).map(({address,actor,type})=>{
   const {x,y,w,h}=actor.contactBox;
   return [address,actor.dead?4:type,actor.phase,actor.fireCounter,x,y,x+w-1,y+h-1];
  });
  const transient=(ship.actorLists.get(ActorList.transient)||[]).map(({address,actor,type})=>[
   address,actor.dead?4:type,actor.xFixed,actor.yFixed,pointer(actor.frame),actor.direction]);
  states.push({main,transient,seed:ship.seed,free:pool.free.at(-1)??0,camera:ship.camera,ceiling:ship.control.ceiling});
 }
 return {recycle,background,states};
});
const stageOneGroundDeaths=[1,4].flatMap(kind=>['free','shot','self'].map(mode=>{
 ship.start();
 ship.run.actorPool=new ActorPool();
 ship.actorLists.clear();
 const pool=ship.run.actorPool;
 ship.camera=ship.control.camera=ship.endCamera=4300;
 ship.control.ceiling=4316;
 ship.boss=undefined;
 ship.player.x=300;
 ship.player.y=24;
 ship.shipTouchesTerrain=()=>false;
 const event=kind===1?[4300,1,0,0,72,4340,0]:[4300,4,0,3,72,4408,0];
 ship.assets={...ship.assets,events:[],background:[event]};
 ship.update();
 ship.update();
 const [target]=ship.ground, box=target.bounds(ship.camera);
 const x=box.x+(box.w>>1),y=box.y+(box.h>>1);
 const cell=target.cell??Math.floor(target.worldY/16)*20+Math.floor(target.x/16);
 if(mode!=='self')ship.addPlayerRound({x,y,dx:0,dy:0,point:true,damage:2,age:0});
 if(mode!=='free')pool.free.length=0;
 if(mode==='self')ship.hitWithWeapon(target,{damage:2});
 const states=[];
 for(let tick=0;tick<(mode==='self'?2:7);tick++){
  if(tick||mode!=='self')ship.update();
  const main=ship.actorLists.get(ActorList.main)||[];
  const transient=ship.actorLists.get(ActorList.transient)||[];
  states.push({main:main.map(({address,actor,type})=>[address,actor.dead?4:type]),
   transient:transient.map(({address,actor,type})=>[address,actor.dead?4:type,actor.x,actor.y,
    actor.frames?pointer(actor.frames[Math.min(actor.age,actor.frames.length-1)]):0]),
   draw:transient.filter(({actor})=>!actor.dead).map(({address})=>address),
   free:pool.free.at(-1)??0,score:ship.score,
   tiles:[0,1,20,21].map(offset=>ship.map[cell+offset])});
 }
 return {mode,event,x,y,states};
}));
const stageOnePatrols=[0,1].flatMap(side=>['free','self','marked'].map(mode=>{
 ship.start();
 ship.run.actorPool=new ActorPool();
 ship.actorLists.clear();
 const pool=ship.run.actorPool;
 ship.camera=ship.control.camera=ship.endCamera=4300;
 ship.control.ceiling=4316;
 ship.boss=undefined;
 ship.player.x=160;
 ship.shipTouchesTerrain=()=>false;
 const event=[4300,4,0,3,side?248:72,4408,side];
 ship.assets={...ship.assets,events:[],background:[event]};
 ship.player.y=24;
 ship.update();
 const states=[];
 for(let tick=0;tick<10;tick++){
  ship.player.y=tick?100:24;
  if(tick===1&&mode!=='free'){
   let victim=ship.ground[0];
   if(mode==='marked'){
    victim={x:160,y:40,dx:0,dy:0,damage:1,point:true,age:0};
    ship.addPlayerRound(victim);
    victim.dead=true;
   }
   pool.subpixels.set(victim.actorAddress,[0xc000,0x9000]);
   pool.free.length=0;
  }
  ship.update();
  const lists=[ActorList.main,ActorList.transient].map(list=>ship.actorLists.get(list)||[]);
  states.push({seed:ship.seed,free:pool.free.at(-1)??0,
   draw:lists.map(list=>list.filter(({actor})=>!actor.dead).map(({address})=>address)),
   lists:lists.map(list=>list.map(({actor,address,type})=>{
    const header=[address,actor.dead?4:type];
    if(type===0x14)return [...header,actor.xFixed,actor.yFixed,pointer(actor.frame),actor.direction];
    const frames=actor.frames,b=actor.box;
    return [...header,actor.x,actor.motion.y,pointer(frames[Math.min(actor.frameIndex,frames.length-1)]),
     ...[b.x,b.y,b.x+b.w-1,b.y+b.h-1]];
   }))});
 }
 return {event,mode,states};
}));
const stageOneHostileRounds=['foreground','boss','boss-death','boss-mixed','boss-aimed','boss-parent',
 'boss-parent-blast','boss-parent-round-blast','boss-parent-reward','boss-parent-counted',
 'boss-parent-credit','boss-parent-credit-wrap',
 'boss-parent-forward','boss-parent-left','boss-parent-cannon'].flatMap(source=>
 (source==='boss-mixed'||source==='boss-aimed'||source.startsWith('boss-parent')?[false]:[false,true]).map(recycle=>{
 const boss=source!=='foreground', camera=boss?32:4300, birth=boss?12:1;
 const aimed=source==='boss-aimed', mixed=source==='boss-mixed'||aimed;
 const parentReuse=source.startsWith('boss-parent')?14:0;
 const roundParent=source==='boss-parent'||source==='boss-parent-round-blast';
 const blastParent=source==='boss-parent-blast'?parentReuse:source==='boss-parent-round-blast'?parentReuse+2:0;
 const death=source==='boss-death'?14:0;
 ship.start();
 ship.run.actorPool=new ActorPool();
 ship.actorLists.clear();
 const pool=ship.run.actorPool;
 if(boss)ship.boss.allocateCore(ship);
 ship.camera=ship.control.camera=ship.endCamera=camera;
 ship.control.ceiling=camera+16;
 ship.shopVisited=ship.eventStreamsClosed=true;
 ship.shipTouchesTerrain=()=>false;
 ship.player.x=300;
 ship.player.y=boss?24:174;
 const event=[0,1,1,1,0,aimed?105:30,3], gunEvent=[camera,1,0,0,72,4340,0];
 const path=[10,aimed?260:100,60,2,64,0,0,1000,0];
 const shipFrame=pointer(ship.assets.logic.playerBank[6]);
 const weapon=source.split('-').at(-1);
 const cannon=weapon==='cannon';
 const playerParent=cannon||weapon==='forward'||weapon==='left';
 const shotFrames=cannon?ship.assets.logic.cannon.shot:undefined;
 const originalSprite=playerParent&&!cannon?ship.assets.playerShots[weapon][0]:undefined;
 const shot=playerParent?{type:cannon?0x30:0x10,frame:cannon?pointer(shotFrames[0]):originalSprite.pointer,
  x:130,y:130,dx:weapon==='left'?-9:0,dy:cannon?-10:weapon==='left'?0:-9}:null;
 let gun;
 if(!boss||mixed){
  ship.assets={...ship.assets,paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
  ship.spawn(event);
  if(aimed)ship.enemies[0].motion.remaining=-1200;
 }
 if(!boss){
  ship.boss=undefined;
  gun=new GroundGun(gunEvent,ship.assets.groundLogic);
  pool.allocate(ship.actorLists,ActorList.main,0xec,gun);
  ship.ground.push(gun);
 }
 const states=[];
 for(let tick=1;tick<=birth+59;tick++){
  if(tick===birth&&recycle){
   const spent={x:290,y:80,dx:0,dy:0,point:true,damage:1,age:0};
   ship.addPlayerRound(spent);
   spent.dead=true;
   pool.subpixels.set(spent.actorAddress,[0xc000,0x9000]);
   pool.free.length=0;
  }
  const counter=tick===birth&&!parentReuse?255:0;
  if(boss&&ship.boss.active)ship.boss.arms.at(-1).fireCounter=counter;
  if(mixed||!boss)ship.enemies[0].fireCounter=aimed&&(tick===11||tick===14)?255:counter;
  if(gun)gun.fireCounter=counter;
  if(tick===parentReuse){
   pool.free.length=0;
   if(roundParent)ship.addPooledHostileRound({x:130,y:80,dx:6,dy:0,direction:2,
     frame:ship.assets.logic.foregroundShot.frame,fixed:true},6);
   if(source==='boss-parent-reward')ship.addPickup({x:130,y:130,kind:'reward',reward:16,age:0,state:7});
   if(source==='boss-parent-counted'){
    for(const value of [50,100])ship.addPickup({kind:'credit',counted:true,value,age:0,state:7,
     x:ship.randomWord()%300+10,y:ship.randomWord()%180+6});
   }
   if(source.startsWith('boss-parent-credit')){
    if(source.endsWith('-wrap'))ship.seed=0x324b;
    ship.addPickup({x:130,y:130,kind:'credit',value:50,age:0,state:7,direction:ship.randomWord()});
   }
   if(shot)ship.addPlayerRound({x:shot.x,y:shot.y,dx:shot.dx,dy:shot.dy,
    point:!cannon,cannon,damage:cannon?2:1,originalSprite,frame:shotFrames?.[0],frames:shotFrames,age:0},shot.type);
  }
  if(tick===blastParent)ship.explode(130,130,true,true);
  if(tick===death){
   const x=160,y=ship.boss.weakY;
   ship.hitWithWeapon(ship.boss,{x,y,point:true,damage:30},{x,y,w:1,h:1});
  }
  ship.update();
  const main=ship.actorLists.get(ActorList.main)||[];
  const records=ship.actorLists.get(ActorList.transient)||[];
  states.push({seed:ship.seed,free:pool.free.at(-1)??0,count:ship.countedCredits,
   ...(boss?{main:main.map(({address,type,actor})=>{
    if(actor===ship.boss)return [address,type,actor.worldY,actor.phase,actor.speed];
    if(actor.stageOneBoss)return [address,type,actor.parent.actorAddress,actor.xFixed,actor.yFixed,
     pointer(actor.frame),actor.fireCounter,actor.speed??0,...(actor.box.w?[actor.box.x,actor.box.y,
      actor.box.x+actor.box.w-1,actor.box.y+actor.box.h-1]:[1000])];
    return [address,type,actor.motion.xFixed,actor.motion.yFixed];
   }),mainDraw:main.filter(({actor})=>!actor.dead).map(({address})=>address)}:{}),
   draw:records.filter(({actor})=>!actor.dead).map(({address})=>address),
   records:records.map(({address,type,actor})=>{
    if(actor.dead&&(death||type!==0x14))return [address,4];
    if(type===0x14)return [address,actor.dead?4:type,actor.xFixed,actor.yFixed,pointer(actor.frame),actor.direction];
    if(type===0x10||type===0x30)return [address,type,actor.x,actor.y,actor.originalSprite?.pointer??pointer(actor.frame)];
    const frame=type===0x0c?actor.frames[actor.age]:ship.pickupFrame(actor);
    return [address,type,actor.x,actor.y,pointer(frame),...(type===0x0c?[]:[actor.state,actor.direction])];
   })});
 }
 return {source,recycle,camera,birth,death,parentReuse,roundParent,blastParent,shot,event,gunEvent,path,shipFrame,states};
}));
const stageOneAimCarry=[1,2,3,4].flatMap(type=>[0,1].flatMap(side=>
 ['idle','fire',...(type===1?['culled','moving','bank',...(!side?['worm']:[])]:type===4?['preserve','recycled']:[])].map(mode=>{
 ship.start();
 const bank=mode==='bank'?(side?5:-5):0;
 const recycled=mode==='recycled';
 const worm=mode==='worm',camera=worm?3240:4300;
 if(!bank){
  ship.run.actorPool=new ActorPool();
  ship.actorLists.clear();
  ship.boss=undefined;
 }
 const pool=ship.run.actorPool;
 ship.camera=ship.control.camera=ship.endCamera=camera;
 ship.control.ceiling=camera+16;
 ship.shopVisited=ship.eventStreamsClosed=true;
 ship.shipTouchesTerrain=()=>false;
 ship.player.x=bank?120-Math.sign(bank)*3:recycled?280:160;
 ship.control.bank=bank;
 ship.player.y=150;
 const event=[0,1,1,1,0,105,3],groundEvent=[camera,type,0,3,side?248:72,
  worm?camera+400:mode==='culled'||bank?4608:recycled?4368:type===4?4408:4388,side];
 const leadEvent=mode==='preserve'?[4300,1,0,0,40,4388,0]:null;
 const path=[10,100,60,2,64,0,0,1000,0];
 const shipFrame=pointer(ship.assets.logic.playerBank[6]);
 ship.assets={...ship.assets,paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
 ship.spawn(event);
 const [enemy]=ship.enemies;
 enemy.motion.remaining=mode==='moving'?0:-80;
 enemy.fireCounter=255;
 const ground=type===4?new GroundPatrol(groundEvent,ship.assets.groundLogic.get(type),4300,f=>ship.sprite(f))
  :new GroundGun(groundEvent,ship.assets.groundLogic);
 pool.allocate(ship.actorLists,ActorList.main,type===4?0xd0+4*side:[0xec,0xe4,0xdc][type-1]-4*side,ground);
 ship.ground.push(ground);
 if(worm){
  ship.terrainWorms.rotations[0]=9<<3;
  ship.terrainWorms.present.fill(true,1);
  ship.terrainWorms.dispatch(ship,camera);
 }
 if(leadEvent){
  const lead=new GroundGun(leadEvent,ship.assets.groundLogic);
  pool.allocate(ship.actorLists,ActorList.main,0xec,lead);
  ship.ground.push(lead);
 }
 const firing=mode==='fire'||mode==='moving'||recycled;
 if(type===4)ship.player.y=recycled?80:firing?120:174;
 else{
  ground.fireCounter=firing?255:0;
  ground.phase=type===3&&firing?23:[3,3,22][type-1];
 }
 const seed=ship.seed=0x5845;
 if(recycled)pool.free.length=0;
 const player=[ship.player.x,ship.player.y];
 ship.update({left:bank<0,right:bank>0});
 const shots=(ship.actorLists.get(ActorList.transient)||[]).filter(({type})=>type===0x14)
  .map(({address,actor})=>[address,actor.direction,actor.xFixed,actor.yFixed,pointer(actor.frame)]);
 return {event,groundEvent,leadEvent,path,shipFrame,player,bank,seed,mode,camera,
  expected:{seed:ship.seed,shots}};
})));
const cameraWatermarks=(()=>{
 const game=new Game(campaign);game.start(4);
 const events=[1995,2001,2000,1997].map(y=>[y,8,1,1,0,0,0]);
 const background=[1999,2192,2000,2191,1997,1995].map(y=>[y,0,0,0,160,0,0]);
 const seen=[];
 game.assets={...game.assets,events,background};
 game.spawn=([y])=>seen.push([0,y]);game.saveCheckpoint=([y])=>seen.push([1,y]);
 const limits=()=>[game.foregroundEventLimit,game.backgroundEventLimit];
 const startLimits=limits();
 game.checkpoint.camera=2000;game.restoreCheckpoint();
 const restoredLimits=limits();
 const states=[2001,2000,2003,2000,1995,1997,1994].map(camera=>{
  game.camera=camera;game.dispatchCameraEvents();
  return {camera,seen:seen.splice(0),limits:limits()};
 });
 return {events,background,startLimits,restoredLimits,states};
})();
const stageOneCameraEvents=(()=>{
 ship.start();
 ship.run.actorPool=new ActorPool();
 ship.actorLists.clear();
 const main=ActorList.main,transient=ActorList.transient;
 const path=[10,100,60,4,90,0],hit=[100,50];
 const events=[[4296,1,1,1,0,0,3],[4295,2,1,1,0,0,3]];
 const background=[[4296,1,0,0,72,4340,0],[4296,4,0,3,248,4408,1]];
 ship.assets={...ship.assets,events,background,
  paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
 ship.camera=ship.control.camera=4300;ship.endCamera=4200;ship.control.ceiling=4316;
 ship.player.x=300;ship.player.y=24;ship.boss=undefined;
 ship.shipTouchesTerrain=()=>false;
 for(let i=0;i<3;i++)ship.update();
 ship.addDroneVolley(...hit,[[0,0,0,0]]);
 const cell=270*20+4,cells=[cell,cell+1,cell+20,cell+21];
 const states=Array.from({length:3},()=>{
  ship.update();
  const paint=ship.actorPaint;
  const list=ship.actorLists.get(main)||[];
  return {
   painted:(paint?.main??list).filter(({actor})=>!actor.dead&&!(actor instanceof GroundGun))
    .map(({address})=>address),
   paintTiles:cells.map(i=>paint?(paint.mapPatches.get(i)??ship.assets.map[i]):ship.map[i]),
   tiles:cells.map(i=>ship.map[i]),
   main:list.map(({address,type,actor})=>[address,actor.dead?4:type]),
   drops:(ship.actorLists.get(transient)||[]).filter(({actor})=>actor.kind==='credit').map(({type})=>type),
   seed:ship.seed,score:ship.score,spent:ship.droneShots[0]===null,
  };
 });
 return {path,hit,events,background,cell,states};
})();
const formationCredits=[1,2,3,4,5].flatMap(stage=>[
 {births:[[2,9],[4,8],[5,9],[5,1],[8,10]], actions:{2:[0],5:[1,3],8:[4,2]}},
 {births:[4,8,12,16].flatMap(tick=>[[tick,8],[tick,1]]).concat([[20,10],[22,9]]),
  actions:{20:[8,'unlink'],22:[9]}},
 {births:[[4,8],[5,9,2]], actions:{7:[0]}},
 {births:[[4,8],[5,9]], actions:{6:['clear',1,0]}, round:256},
 {births:[[4,0],[4,8]], actions:{5:[0,1]}},
].map(({births,actions,round=1})=>{
 ship.start(stage);
 ship.run.actorPool=new ActorPool();
 ship.actorLists.clear();
 const main=ActorList.main,transient=ActorList.transient;
 const path=[10,100,60,2,36,0,0,1000,0,10,130,60,4,5,0];
 const types=[{}, {8:4,9:5,10:6}, {1:3,8:4,9:5,10:2}, {8:2,9:3,10:4}, {8:3,9:4,10:5}][stage-1];
 const events=births.map(([tick,type,route=1])=>[4300-tick,types[type]??type,1,route,0,0,3]);
 ship.assets={...ship.assets,events,background:[],
  paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0,18]}};
 ship.camera=ship.control.camera=4300;ship.endCamera=4200;ship.control.ceiling=4316;
 ship.player.x=300;ship.player.y=174;ship.boss=ship.miniboss=undefined;
 ship.shipTouchesTerrain=()=>false;
 ship.campaignRound=round;
 const actors=[], states=[];
 for(let tick=1;tick<=Math.max(...Object.keys(actions));tick++){
  ship.update();
  const count=births.filter(([at])=>at===tick).length;
  if(count)actors.push(...ship.enemies.slice(-count));
  for(const action of actions[tick]||[]){
   if(action==='clear')grantReward(ship,18);
   else if(action==='unlink'){
    const actor=actors[0];
    if(stage<=2)ship.run.actorPool.release(ship.actorLists,main,ship.run.actorPool.recordsByAddress.get(actor.actorAddress));
    else ship.enemies.splice(ship.enemies.indexOf(actor),1);
    actor.dead=true;
   }else ship.hitWithWeapon(actors[action],{damage:32767});
  }
  const {ids,next}=ship.run.formationClock;
  states.push({clock:[...ids,next],groups:[...ship.formationCredits].sort(([a],[b])=>a-b),
   seed:ship.seed,score:ship.score,
   drops:stage<=2?(ship.actorLists.get(transient)||[]).filter(({actor})=>!actor.dead&&actor.kind==='credit')
    .map(({type})=>type):ship.pickups.filter(p=>p.kind==='credit').map(p=>p.value===100?0x18:0x60).sort((a,b)=>a-b)});
 }
 return {stage,events,actions,round,path,states};
}));
const stageOneForegroundPool=[
 ['composites'],['successor'],['orphan'],['clear-foreground'],['clear-ground'],
 ['clear-recycled'],['clear-recycled-resist'],
 ['clear-recycled-composite'],['clear-recycled-composite-resist'],
 ['clear-recycled-wall'],['clear-recycled-patrol'],
 ...[0,1,7].flatMap(type=>(type===7?['free']:['free','spent','self']).map(capacity=>[capacity,type])),
].map(([mode,type])=>{
 ship.start();
 ship.run.actorPool=new ActorPool();
 ship.actorLists.clear();
 const pool=ship.run.actorPool;
 ship.camera=ship.control.camera=ship.endCamera=4300;
 ship.control.ceiling=4316;
 ship.eventStreamsClosed=true;
 ship.boss=undefined;
 ship.shipTouchesTerrain=()=>false;
 ship.player.x=300;
 ship.player.y=174;
 const shipFrame=pointer(ship.assets.logic.playerBank[6]);
 const path=[10,100,60,2,36,0,0,mode==='composites'?18:1000,0];
 const clear=mode.startsWith('clear-');
 const saturatedClear=mode.startsWith('clear-recycled');
 const compositeClear=mode.startsWith('clear-recycled-composite');
 const groundClear=mode.endsWith('-wall')||mode.endsWith('-patrol');
 const round=ship.campaignRound=mode.endsWith('-resist')?(compositeClear?128:64):1;
 const gunEvent=mode.endsWith('-patrol')?[4300,4,0,3,72,4340,0]:[4300,1,0,0,72,4340,0];
 const formation=[0,1,1,1,0,0,3], podEvent=[0,0,1,1,0,0,16];
 const events=mode==='successor'?[[0,1,1,1,0,0,3],[0,0,1,1,0,30,0]]
  :mode==='composites'?[[0,7,2,1,120,0,3]]:mode==='orphan'?[[0,7,1,1,0,0,3]]
  :mode==='clear-foreground'?[gunEvent,podEvent,formation]
  :saturatedClear?[[0,2,1,1,64,0,3],groundClear?gunEvent:compositeClear?[0,7,1,1,0,0,3]:formation,podEvent]
  :clear?[podEvent,formation,gunEvent]:[[0,type,1,1,0,0,type?3:16]];
 ship.assets={...ship.assets,paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
 for(const event of events){
  if(event===gunEvent){
   const patrol=event[1]===4;
   const gun=patrol?new GroundPatrol(event,ship.assets.groundLogic.get(4),ship.camera,f=>ship.sprite(f))
    :new GroundGun(event,ship.assets.groundLogic);
   pool.allocate(ship.actorLists,ActorList.main,patrol?0xd0:0xec,gun);
   ship.ground.push(gun);
   if(gun.patches)ship.patchGround(gun,gun.patches);
  }else ship.spawn(event);
 }
 if(clear){
  if(saturatedClear){ship.update();pool.free.length=0;}
  else ship.addPooledHostileRound({x:290,y:70,dx:0,dy:0,fixed:true,
   direction:0,frame:ship.assets.logic.foregroundShot.frame});
  grantReward(ship,18);
 }
 if(mode==='successor'){
  pool.free.length=0;
  const [victim,pod]=ship.enemies;
  pool.subpixels.set(victim.actorAddress,[0xc000,0x9000]);
  pod.fireCounter=255;
 }
 if(mode==='orphan'){
  pool.free.length=0;
  const {frame,vectors}=ship.assets.logic.foregroundShot;
  ship.addPooledHostileRound({x:260,y:80,dx:vectors[2][0]*6,dy:vectors[2][1]*6,direction:2,frame,fixed:true});
 }
 if(type!==undefined){
  if(mode==='spent'){
   const spent={x:270,y:80,point:true,damage:1,dead:true};
   ship.addPlayerRound(spent);
   pool.headings.set(spent.actorAddress,5);
  }
  if(mode!=='free')pool.free.length=0;
  const [enemy]=ship.enemies;
  ship.hitWithWeapon(enemy.children.at(-1)??enemy,{damage:127});
 }
 const state=()=>{
  const lists=[ActorList.main,ActorList.transient].map(list=>ship.actorLists.get(list)||[]);
  return {seed:ship.seed,free:pool.free.at(-1)??0,score:ship.score,
   draw:lists.map(list=>list.filter(({actor})=>!actor.dead).map(({address})=>address)),
   lists:lists.map(list=>list.map(({actor,address,type})=>{
    if(actor.dead)return [address,4];
    if(type===0x14)return [address,type,actor.xFixed,actor.yFixed,pointer(actor.frame),actor.direction];
    if(type===0x0c)return [address,type,actor.x,actor.y,pointer(actor.frames[actor.age])];
    if(actor.kind)return [address,type,actor.x,actor.y,pointer(ship.pickupFrame(actor)),actor.state,actor.direction];
    const b=actor.contactBox;
    return [address,type,actor.motion.xFixed,actor.motion.yFixed,pointer(ship.enemyFrame(actor)),
     b.x,b.y,b.x+b.w-1,b.y+b.h-1,actor.fireCounter];
   }))};
 };
 const states=[state()];
 let flash,attachmentFlash,groundDeath;
 if(saturatedClear){
  flash=[];
  const replacement=ship.actorLists.get(ActorList.transient)[0].actor;
  if(groundClear){
   const [{cell}]=ship.ground;
   groundDeath={address:replacement.actorAddress,x:replacement.x,y:replacement.y,
    frame:pointer(replacement.frames[0]),tiles:cell===undefined?[]:[0,1,20,21].map(i=>ship.map[cell+i])};
  }
  if(!replacement.dead)Renderer.prototype.drawPickup.call({
   drawSprite(sprite,x,y,_alpha,mask){
    if(mask!=='vga-hit')return;
    sprite.alpha.forEach((v,i)=>{
     const px=x-sprite.originX+i%sprite.width,py=y-sprite.originY+Math.floor(i/sprite.width);
     if(v&&px>=0&&px<320&&py>=0&&py<192)flash.push(py*320+px);
    });
   }
  },ship,replacement);
  if(compositeClear){
   const attachment=ship.enemies[1].children[0];
   attachmentFlash=!attachment.dead&&attachment.flashTick===ship.tick;
  }
 }
 for(let tick=0;tick<(mode==='composites'?9:20);tick++){
  if(mode==='successor'&&tick)ship.enemies[0].fireCounter=0;
  if(mode==='orphan'&&tick===12)ship.explode(64,100,true,true);
  ship.update();
  states.push(state());
 }
 return {mode,type,shipFrame,path,events,states,round,flash,attachmentFlash,groundDeath};
});
const stageOneFlashes=['formation','orphan-round','orphan-round-full','orphan-blast',
 'orphan-round-marked','orphan-round-free','orphan-reward','orphan-credit','orphan-counted','orphan-cannon','arm',1,4,8,12].map(mode=>{
 const orphan=typeof mode==='string'&&mode.startsWith('orphan-');
 const retired=mode==='orphan-round-marked'||mode==='orphan-round-free';
 const formation=orphan||mode==='formation';
 ship.start();
 if(orphan){
  ship.run.actorPool=new ActorPool();
  ship.actorLists.clear();
  ship.boss=undefined;
 }
 ship.camera=ship.control.camera=ship.endCamera=formation?4300:0;
 ship.eventStreamsClosed=ship.shopVisited=true;
 ship.shipTouchesTerrain=()=>false;
 ship.player.x=300;
 ship.player.y=174;
 const event=[0,7,1,1,0,0,3],path=[10,100,60,4,90,0];
 let replacement;
 if(formation){
  ship.campaignRound=orphan?2:3;
  ship.assets={...ship.assets,paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
  ship.spawn(event);
  if(orphan){
   const pool=ship.run.actorPool, free=pool.free.splice(0);
   replacement={x:150,y:80,dx:0,dy:0,direction:2,fixed:true,frame:ship.assets.logic.foregroundShot.frame};
   ship.addPooledHostileRound(replacement,0);
   if(mode==='orphan-blast')replacement=ship.explode(150,80,true,true).actor;
   else if(mode==='orphan-reward'){
    replacement={x:150,y:80,kind:'reward',reward:16,age:0,state:7};
    ship.addPickup(replacement);
   }else if(mode==='orphan-credit'){
    replacement={x:150,y:80,kind:'credit',value:50,age:0,state:7,direction:ship.randomWord()};
    ship.addPickup(replacement);
   }else if(mode==='orphan-counted'){
    ship.seed=55;
    for(const value of [50,100]){
     replacement={kind:'credit',counted:true,value,age:0,state:7,
      x:ship.randomWord()%300+10,y:ship.randomWord()%180+6};
     ship.addPickup(replacement);
    }
   }
   pool.free.push(...free);
  }
 }
 const root=formation?ship.enemies[0]:ship.boss;
 for(let i=0;i<(formation?1:mode==='arm'?2:mode);i++)ship.update();
 if(mode==='orphan-cannon'){
  const pool=ship.run.actorPool, free=pool.free.splice(0), frames=ship.assets.logic.cannon.shot;
  replacement={x:150,y:80,cannon:true,dy:-10,damage:2,age:0,frame:frames[0],frames};
  ship.addPlayerRound(replacement,0x30);
  pool.free.push(...free);
 }
 if(retired){
  replacement.dead=true;
  if(mode==='orphan-round-free'){
   const pool=ship.run.actorPool;
   pool.release(ship.actorLists,ActorList.transient,pool.recordsByAddress.get(root.actorAddress));
  }
 }
 const targets=formation?[replacement??root,...root.children]:mode==='arm'?[root.arms[0]]:[root];
 let cannon, fire;
 const shoot=(full=false)=>{
  if(retired){ship.hitWithWeapon(root.children[0],{damage:1});return;}
  const {x,y}=root.children[0].contactBox;
  const shot={x:x+1,y:y+1,dx:0,dy:0,point:true,damage:1,age:0};
  fire=[shot.x,shot.y];
  ship.addPlayerRound(shot);
  if(full)ship.run.actorPool.free.length=0;
  ship.updatePlayerRound(shot);
  if(!shot.dead)throw Error('Shot missed orphan attachment');
 };
 if(mode==='arm'){
  const {x,y}=targets[0].motion;
  const frame=ship.assets.logic.cannon.shot[0];
  const offset=ship.bounds(ship.sprite(frame),0,0);
  const round={x:x-offset.x,y:y-offset.y+10,dy:-10,cannon:true,damage:2,age:0,frame};
  cannon={x:round.x,y:round.y,frame:pointer(frame)};
  ship.addPlayerRound(round,0x30);
  ship.updatePlayerRound(round);
  cannon.spent=Boolean(round.dead);
 }else if(orphan)shoot();
 else ship.hitWithWeapon(targets.at(-1),{x:160,y:ship.boss?.weakY??0,point:true,damage:1});
 const marks=new Set();
 const mark=(x,y)=>{if(x>=0&&x<320&&y>=0&&y<192)marks.add(y*320+x);};
 const renderer=Object.create(Renderer.prototype);
 renderer.assets=ship.assets;
 renderer.vgaFlashTiles=new Map(ship.assets.tiles.map((pixels,index)=>[index,pixels]));
 renderer.context={
  fillRect(x,y,w,h){for(let row=0;row<h;row++)for(let col=0;col<w;col++)mark(x+col,y+row);},
  drawImage(tile,x,y){tile.forEach((v,i)=>{if(v)mark(x+i%16,y+(i>>4));});},
 };
 renderer.drawSprite=(sprite,x,y,alpha,mask)=>{
  if(mode==='arm'&&!mask){renderer.drewNormalArm=true;return;}
  if(mask!=='vga-hit')throw Error('Missing VGA sprite flash');
  sprite.alpha.forEach((v,i)=>{if(v)mark(x-sprite.originX+i%sprite.width,y-sprite.originY+Math.floor(i/sprite.width));});
 };
 const pixels=targets.map(actor=>{
  marks.clear();
  if(mode==='orphan-round-free'&&actor===replacement)return [];
  if(orphan&&actor===replacement)renderer.drawTransient(ship,[ship.run.actorPool.recordsByAddress.get(actor.actorAddress)]);
  else if(formation)renderer.drawForeground(ship,actor,orphan?actor:root);
  else if(mode==='arm')renderer.drawStageOneMain(ship,[{actor}]);
  else renderer.drawStageOneCore(ship,root);
  if(mode==='arm'?(!renderer.drewNormalArm||marks.size):!marks.size)throw Error(`Unexpected stage-one flash: ${mode}`);
  return [...marks].sort((a,b)=>a-b);
 });
 let death;
 if(orphan){
  shoot(mode==='orphan-round-full');
  const {seed,score}=ship;
  const lists=[ActorList.main,ActorList.transient].map(list=>ship.actorLists.get(list).map(({address,type,actor})=>{
   if(actor.dead)return [address,4];
   const frame=type===0x0c?actor.frames[actor.age]:ship.pickupFrame(actor);
   return [address,type,actor.x,actor.y,pointer(frame)];
  }));
  death={seed,score,lists,count:ship.countedCredits};
 }
 return {mode,event,path,pixels,cannon,fire,death};
});
const stageOneDronePaint=['formation','gun'].map(mode=>{
 ship.start();
 ship.run.actorPool=new ActorPool();
 ship.actorLists.clear();
 ship.boss=undefined;
 ship.camera=ship.control.camera=ship.endCamera=4300;
 ship.control.ceiling=4316;
 ship.eventStreamsClosed=ship.shopVisited=true;
 ship.shipTouchesTerrain=()=>false;
 ship.player.x=300;
 ship.player.y=174;
 const path=[10,100,60,4,90,0],event=mode==='formation'?[0,7,1,1,0,0,3]:[4300,1,0,0,72,4340,0];
 if(mode==='formation'){
  ship.assets={...ship.assets,paths:{bytes:new Uint8Array(Int16Array.from(path).buffer),offsets:[0]}};
  ship.spawn(event);
 }else{
  const gun=new GroundGun(event,ship.assets.groundLogic);
  ship.run.actorPool.allocate(ship.actorLists,ActorList.main,0xec,gun);
  ship.ground.push(gun);
 }
 ship.update();
 const cell=mode==='gun'?ship.ground[0].cell:null, cells=cell===null?[]:[cell,cell+1,cell+20,cell+21];
 const hit=mode==='formation'?[100,60]:[80,44];
 const painted=[],tiles=new Map();
 const renderer=Object.assign(Object.create(Renderer.prototype),{
  assets:ship.assets,map:ship.map,mapRevision:-1,
  tileImages:ship.assets.tiles.map((_,i)=>i),
  world:{getContext:()=>({drawImage(tile,x,y){tiles.set(y/16*20+x/16,tile);}})},
  context:Object.fromEntries(['drawImage','save','beginPath','rect','clip','restore','fillText','fillRect']
    .map(name=>[name,()=>{}])),
  drawSprite(){},
  drawStageOneMain(_,records){painted.push(...records.filter(({actor})=>!actor.dead).map(({address})=>address));},
  drawTransient(_,records){painted.push(...records.filter(({actor})=>!actor.dead).map(({address})=>address));},
 });
 ship.seed=0x5845;
 ship.addDroneVolley(...hit,[[0,0,0,0]]);
 const states=Array.from({length:2},()=>{
  ship.update();
  painted.length=0;renderer.draw(ship);
  return {painted:painted.slice(),map:cells.map(i=>tiles.get(i)),seed:ship.seed,score:ship.score,
   spent:ship.droneShots[0]===null,transient:(ship.actorLists.get(ActorList.transient)||[])
    .map(({address,actor,type})=>[address,type,actor.x,actor.y,
     pointer(type===0x0c?actor.frames[actor.age]:ship.pickupFrame(actor))])};
 });
 return {mode,path,event,hit,cell,states};
});
const sharedSprites=Buffer.from(unpack(readFileSync('X2SPR.DAT'))).toString('base64');
const weaponSprites=Buffer.from(unpack(readFileSync('X2WEAPS.DAT'))).toString('base64');
console.log(JSON.stringify({cameraWatermarks,stageOneCameraEvents,formationCredits,guns,bossTraces,bossHits,bossBurst,credits,patrols,randomGuns,controls,weapons,health,rear,shops,shopCredits,shopArt,podOpenings,recycledPickups,actorPools,mountPools,stageOneMountFire,actorReclaims,stageTwoPoolScenes,stageTwoCameraEvents,stageTwoPickupOrder,homingPatrolLocks,miniCorpseSelfReuse,transientReuse,mixedDropCountdown,hostileContacts,stageTwoShipContacts,stageTwoRing,hatches,creatures,swarmContacts,miniEyes,miniWaves,miniDamage,miniBurst,miniControls,miniHits,bossTwoTraces,bossEggs,bossCrawlers,bossTerrain,bossTwoDeaths,bossTwoMap,mainToTransient,saturatedHatch,bossArenaPool,miniArenaPool,linkedPlayerShots,linkedMines,stageTwoDrone,linkedElectro,stageTwoNashwan,maneuverJets,checkpoints,deathFrames,countdown,foreground,foregroundBullets,composites,rewards,stageTransitions,protection,diveTraces,timedMeters,terrainHull,diveRecoveries,terrainRecoveries,ringTrace,shadeTraces,terrainWormTraces,terrainWormDeaths,terrainWormClear,terrainWormContacts,terrainWormWeapons,stageOneGunPool,stageOneGroundDeaths,stageOnePatrols,stageOneHostileRounds,stageOneAimCarry,stageOneForegroundPool,stageOneFlashes,stageOneDronePaint,sharedSprites,weaponSprites}));
""",
], cwd=ROOT, text=True))

cpu = machine()
cpu.mem_write((LOAD + 0x2824) * 16, base64.b64decode(native["shopArt"]["raw"]))
planes = [bytearray(8000) for _ in range(4)]
vga = {"planes": 15, "mask": 255}


def shop_out(_cpu, port, _size, value, _data):
    if port == 0x3C4 and value & 255 == 2:
        vga["planes"] = value >> 8
    elif port == 0x3CE and value & 255 == 8:
        vga["mask"] = value >> 8


def shop_write(_cpu, _access, address, _size, value, _data):
    offset = address - 0xA0000
    if not 0 <= offset < 8000:
        return
    for plane in range(4):
        if vga["planes"] & (1 << plane):
            old = planes[plane][offset]
            planes[plane][offset] = (old & ~vga["mask"]) | (value & vga["mask"])


cpu.hook_add(UC_HOOK_INSN, shop_out, None, 1, 0, UC_X86_INS_OUT)
cpu.hook_add(UC_HOOK_MEM_WRITE, shop_write, begin=0xA0000, end=0xA1F3F)
graphics_base = (LOAD + 0xF29) * 16
for source, destination, rows in [(0x8430, 0x182, 52), (0x8F90, 0xEF2, 10),
                                  (0x91C0, 0x9A2, 34)]:
    for register, value in [(UC_X86_REG_CS, LOAD + 0xF29),
                            (UC_X86_REG_DS, LOAD + 0x1853),
                            (UC_X86_REG_SI, source), (UC_X86_REG_DI, destination),
                            (UC_X86_REG_CX, rows), (UC_X86_REG_SP, 0xFFFC)]:
        cpu.reg_write(register, value)
    cpu.mem_write(0x9FFFC, b"\x00\xff")
    cpu.emu_start(graphics_base + 0x1D01, graphics_base + 0xFF00, count=100000)
    assert cpu.reg_read(UC_X86_REG_IP) == 0xFF00
for y in range(96):
    for x in range(112):
        offset = (y + 9) * 40 + (x + 208) // 8
        mask = 0x80 >> (x & 7)
        pixel = sum((1 << plane) for plane in range(4) if planes[plane][offset] & mask)
        assert pixel == native["shopArt"]["pixels"][y * 112 + x], (x, y, pixel)
        assert bool(native["shopArt"]["alpha"][y * 112 + x]) == (7 <= x < 104)
print("Shopkeeper portrait: all 10,752 pixels and masked edges match original VGA painting.")

for case in native["podOpenings"]:
    cpu = machine()
    pod, pickup = 0x9F4C, 0xA000
    word(cpu, 0x8E7C, pickup)
    word(cpu, pickup + 8, 0xA04C)
    word(cpu, 0x9096, 0)
    word(cpu, 0x909E, 0x9096)
    word(cpu, 0x90A0, 0x9096)
    for offset, value in [(0, 0x64), (0x12, 137), (0x16, 81), (0x22, case["reward"])]:
        word(cpu, pod + offset, value)
    cpu.reg_write(UC_X86_REG_DI, pod)
    call(cpu, 0x1E61)
    assert word(cpu, pod) == 4
    assert word(cpu, pickup) == case["actor"]
    assert word(cpu, pickup + 0x22) == case["pickup"]["reward"]
    assert [word(cpu, pickup + offset) for offset in (0x12, 0x16)] == [
        case["pickup"]["x"], case["pickup"]["y"]]
print("PASS all 19 pod-opening callbacks: assigned rewards and exact spawn position")

case = native["recycledPickups"]
cpu = startup_pool(1, True)
cpu.mem_write((0x349B + LOAD) * 16,
              base64.b64decode(native["sharedSprites"]) + base64.b64decode(native["weaponSprites"]))
word(cpu, 0x8E80, 4)
call(cpu, 0x1022)
pod = cpu.reg_read(UC_X86_REG_SI)
for offset, value in [(0, 0x64), (0x12, 80), (0x16, 60), (0x22, 16)]:
    word(cpu, pod + offset, value)
for register, value in [(UC_X86_REG_SI, 0x9F00), (UC_X86_REG_AX, -3), (UC_X86_REG_BX, -6),
                        (UC_X86_REG_CX, 0), (UC_X86_REG_DX, 0), (UC_X86_REG_BP, 0x1380)]:
    cpu.reg_write(register, value)
call(cpu, 0x4613)
address = word(cpu, 0x90A0)
assert address == case["shot"]
cpu.reg_write(UC_X86_REG_SI, address)
call(cpu, 0x7A0)
cpu.reg_write(UC_X86_REG_DI, pod)
call(cpu, 0x1E61)
for kind in ("pod", "credit"):
    assert word(cpu, 0x90A0) == address
    for tick, state in enumerate(case[kind]):
        if tick:
            cpu.reg_write(UC_X86_REG_SI, address)
            call(cpu, 0x28DF)
        actual = [address, word(cpu, address + 0x12), word(cpu, address + 0x16),
                  word(cpu, address + 0x1A, signed=True), word(cpu, address + 0x1C), word(cpu, address + 0xC)]
        assert actual == state, ("recycled pickup", kind, tick, actual, state)
    if kind == "pod":
        cpu.reg_write(UC_X86_REG_SI, address)
        call(cpu, 0x7A0)
        word(cpu, 0x304A, 0x5845)
        cpu.reg_write(UC_X86_REG_CX, 0)
        call(cpu, 0x15E4)
print("PASS recycled stage-two pickups: one DOS slot transfers its raw heading from a shot to a pod reward to a boss credit")

cpu = machine()
actor_types = [0x64, 0x3C, 0x50, 0x54, 0x46]
for index, kind in enumerate(actor_types):
    actor = 0xA000 + index * 0x4C
    word(cpu, actor, kind)
    cpu.mem_write(DS + actor + 0x26, b"\x00")
    word(cpu, actor + 0xA, actor + 0x4C if index < len(actor_types) - 1 else 0x904A)
word(cpu, 0x904A, 0)
word(cpu, 0x9054, 0xA000)
for index, kind in enumerate([0x14, 0x88]):
    actor = 0xA200 + index * 0x4C
    word(cpu, actor, kind)
    word(cpu, actor + 0xA, 0xA24C if not index else 0x9096)
word(cpu, 0x9096, 0)
word(cpu, 0x90A0, 0xA200)
dispatched = []


def screen_clear_hook(uc, address, _size, _data):
    if address == LOAD * 16 + 0x3A36:
        actor = uc.reg_read(UC_X86_REG_DI)
        dispatched.append((word(uc, actor), uc.reg_read(UC_X86_REG_AX)))
    elif address != LOAD * 16 + 0xEB3:
        return
    sp = uc.reg_read(UC_X86_REG_SP)
    ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
    uc.reg_write(UC_X86_REG_SP, sp + 2)
    uc.reg_write(UC_X86_REG_IP, ip)


cpu.hook_add(UC_HOOK_CODE, screen_clear_hook)
call(cpu, 0x2AD0)
assert dispatched == [(0x64, 127), (0x3C, 127), (0x46, 127)]
assert word(cpu, 0xA200) == 4 and word(cpu, 0xA24C) == 0x88
print("PASS Z original dispatch: 127 damage, pod/ground inclusion, boss and pickup exemptions")

for case in native["actorPools"]:
    cpu = startup_pool(case["players"], case["stage"] == 2)
    if case["stage"] == 1:
        word(cpu, 0x8E70, case["players"])
        word(cpu, 0x991C, 1)
        word(cpu, 0x991A, 1)
        call(cpu, 0x1B43)
    address = word(cpu, 0x8E7C)
    for expected in case["free"]:
        assert address == expected
        address = word(cpu, address + 8)
    assert address == 0
    for hud, mounts, arena in case["seats"]:
        assert word(cpu, 0x8FBC) == 0x9F00
        address = word(cpu, 0x9F0A)
        for expected in hud:
            assert address == expected and word(cpu, address) == 0xC4
            address = word(cpu, address + 0xA)
        assert address == 0x8FB2
        assert [word(cpu, 0x9008)] == mounts
        assert word(cpu, mounts[0]) == 0x94 and word(cpu, mounts[0] + 0xA) == 0x8FFE
        address = word(cpu, 0x9054)
        for expected, kind in zip(arena, (0x50,) if case["stage"] == 1 else (0x54, 0x54, 0x54, 0x50), strict=True):
            assert address == expected and word(cpu, address) == kind
            address = word(cpu, address + 0xA)
        assert address == 0x904A
        call(cpu, 0x1A19)
print("PASS actor startup: all 159 records, solo/alternating HUD, mount and both arena reservations")

for case in native["actorReclaims"]:
    cpu = startup_pool(1)
    for _ in range(154 - len(case["records"])):
        call(cpu, 0x1022)
    for sentinel, kind in case["records"]:
        call(cpu, 0x1022)
        actor = cpu.reg_read(UC_X86_REG_SI)
        word(cpu, actor, kind)
        cpu.reg_write(UC_X86_REG_DI, sentinel)
        call(cpu, 0x77C)
    assert word(cpu, 0x8E7C) == 0
    call(cpu, 0x1022)
    assert cpu.reg_read(UC_X86_REG_SI) == case["address"], case
print("PASS actor exhaustion: transient priority, scenery, signed main type and head fallback")

for case in native["hatches"]:
    cpu = startup_pool(case["players"], True)
    cpu.mem_write(DS, bytes(12000))
    cpu.mem_write((LOAD + 0x4489) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
    cpu.reg_write(UC_X86_REG_DI, 0xF000)
    kind = case["event"][1]
    call(cpu, {2: 0x7FDB, 4: 0x80A3, 5: 0x80BB}[kind])
    hatch = cpu.reg_read(UC_X86_REG_SI)
    assert hatch == case["hatchSlot"]
    cell = word(cpu, hatch + 0x38)
    spawned = []

    def hatch_hook(uc, address, _size, _data):
        if address == LOAD * 16 + 0x3589:
            actor = uc.reg_read(UC_X86_REG_SI)
            spawned.append([actor] + [word(uc, actor + offset) for offset in
                            (0, 0xC, 0xE, 0x12, 0x16, 0x1A, 0x1C, 0x24)]
                           + [uc.mem_read(DS + actor + 0x27, 1)[0]])

    cpu.hook_add(UC_HOOK_CODE, hatch_hook)
    word(cpu, 0x304A, 0x5845)
    retire = None
    for expected in case["states"]:
        if retire is not None:
            cpu.reg_write(UC_X86_REG_SI, retire)
            call(cpu, 0xF2B)
            assert word(cpu, 0x8E7C) == retire
            retire = None
        spawned.clear()
        word(cpu, 0x9190, expected["camera"])
        word(cpu, 0x91AA, expected["ceiling"])
        word(cpu, 0x919C, expected["tick"])
        cpu.reg_write(UC_X86_REG_SI, hatch)
        call(cpu, {2: 0x7CE6, 4: 0x7BEF, 5: 0x7AC4}[kind])
        actual = [word(cpu, hatch + 0x1A), word(cpu, hatch + 0x22), word(cpu, hatch) == 4]
        assert actual == expected["actor"], (kind, case["profile"], expected["tick"], actual)
        actual_tiles = [word(cpu, cell + offset) for offset in (0, 2, 40, 42)]
        assert actual_tiles == expected["tiles"], (kind, case["profile"], expected["tick"], actual_tiles)
        assert spawned == expected["spawned"], (kind, case["profile"], expected["tick"], spawned)
        assert word(cpu, 0x304A) == expected["seed"]
        if kind != 2 and spawned:
            retire = spawned[0][0]
            free = word(cpu, 0x8E7C)
            cpu.reg_write(UC_X86_REG_SI, retire)
            call(cpu, 0x7C0)
            assert word(cpu, retire) == 4 and word(cpu, 0x8E7C) == free
    print(f"PASS hatch {kind}/{case['event'][6]}/{case['profile']}: tiles, timing, spawn slots, deferred frees and RNG")

for case in native["creatures"]:
    cpu = machine()
    cpu.mem_write((LOAD + 0x4489) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
    actor = 0xA000 + case.get("phase", 0)
    kind = case["type"]
    animation = (struct.unpack_from("<H", image, 0x8FE9 + (7 - case["direction"]) * 6)[0]
                 if kind == 2 else 0x783E if kind == 5 else 0x785C)
    pointer, duration = struct.unpack_from("<HH", image, animation)
    for offset, value in [(0, 0x108 if kind == 2 else 0xE0 if kind == 5 else 0xE4),
                           (0xC, pointer), (0xE, duration), (0x10, animation + 4),
                           (0x12, 160 if kind == 2 else 130),
                           (0x16, 90 if kind == 2 else 140),
                           (0x1A, 0), (0x1C, case.get("direction", 0))]:
        word(cpu, actor + offset, value)
    cpu.reg_write(UC_X86_REG_SI, actor)
    call(cpu, 0x3589)
    expired = []

    def creature_hook(uc, address, _size, _data):
        if address == LOAD * 16 + 0x42EB:
            uc.reg_write(UC_X86_REG_AX, 0)
            uc.reg_write(UC_X86_REG_EFLAGS, uc.reg_read(UC_X86_REG_EFLAGS) | 64)
        elif address == LOAD * 16 + 0x3326:
            expired.append(True)
        else:
            return
        sp = uc.reg_read(UC_X86_REG_SP)
        ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
        uc.reg_write(UC_X86_REG_SP, sp + 2)
        uc.reg_write(UC_X86_REG_IP, ip)

    cpu.hook_add(UC_HOOK_CODE, creature_hook)
    for expected in case["states"]:
        word(cpu, 0x9190, 1000)
        word(cpu, 0x9198, expected.get("delta", 1))
        word(cpu, 0x919C, expected["tick"])
        word(cpu, 0x9F12, expected["player"]["x"])
        word(cpu, 0x9F16, expected["player"]["y"])
        cpu.reg_write(UC_X86_REG_SI, actor)
        call(cpu, 0x85D0 if kind == 2 else 0x830C)
        offsets = [0x12, 0x16, 0x1A] + ([0x1C] if kind == 2 else []) + [
            0xC, 0xE, 0x28, 0x2A, 0x2C, 0x2E]
        actual = [word(cpu, actor + offset, signed=offset in (0x12, 0x16, 0x28, 0x2A, 0x2C, 0x2E))
                  for offset in offsets]
        assert actual == expected["state"], (kind, case.get("phase"), expected["tick"], actual, expected)
        if kind == 2:
            assert (word(cpu, actor) == 4) == expected["dead"]
            assert bool(expired) == expected["expired"]
    print(f"PASS creature {kind}/{case.get('phase', case.get('direction'))}: original movement/animation/bounds/expiry")

for case in native["guns"]:
    cpu = machine()
    actor = 0x9F4C
    event = case["event"]
    kind, side = event[1], event[6]
    word(cpu, 0x8E7C, actor)
    word(cpu, actor + 8, 0x9F98)
    word(cpu, 0x904A, 0)
    word(cpu, 0x9052, 0x904A)
    word(cpu, 0x9054, 0x904A)
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
    cpu.reg_write(UC_X86_REG_SI, 0xF000)
    word(cpu, 0x304A, 0x5845)
    bullet = None

    def hook(uc, address, _size, _data):
        global bullet
        if address == LOAD * 16 + 0x1ED3:
            bullet = [uc.reg_read(register) for register in (
                UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_CX, UC_X86_REG_DX, UC_X86_REG_BP)]
            if bullet[1] >= 32768:
                bullet[1] -= 65536
            uc.reg_write(UC_X86_REG_IP, 0xFF00)
        elif address == LOAD * 16 + 0x3326:
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)

    cpu.hook_add(UC_HOOK_CODE, hook)
    word(cpu, 0x9190, 4300)
    call(cpu, {1: 0x6F7F, 2: 0x6F00, 3: 0x6FE0}[kind])
    cell = word(cpu, actor + 0x38)
    # Only the constructor's written cells matter before the first full animation update.
    for tick, expected in enumerate(case["states"]):
        word(cpu, 0x9190, 4300 - tick)
        word(cpu, 0x91AA, 4316 - tick)
        cpu.reg_write(UC_X86_REG_SI, actor)
        bullet = None
        call(cpu, {1: 0x6D22, 2: 0x6AC7, 3: 0x6BCA}[kind])
        actual = {
            "actor": [word(cpu, actor + offset) for offset in (0x12, 0x16, 0x38, 0x24, 0x1A)]
                     + [cpu.mem_read(DS + actor + 0x48, 1)[0]],
            "tiles": [word(cpu, cell + offset) for offset in (0, 2, 40, 42)],
            "bullet": bullet,
        }
        assert actual == expected, f"Gun {kind}/{side}, tick {tick}: {actual} != {expected}"
    cpu.reg_write(UC_X86_REG_DI, actor)
    cpu.reg_write(UC_X86_REG_AX, 2)
    call(cpu, 0x3B76)
    assert [word(cpu, cell + offset) for offset in (0, 2, 40, 42)] == case["death"]
    assert word(cpu, actor) == 4, "Destroyed map gun was not removed"
    print(f"PASS gun {kind}/{side}: spawn, 128 animation/fire ticks and destroyed map tiles")

for case in native["bossTraces"]:
    cpu = machine()
    actor = 0x9F4C
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S1/SPRITES.VGA").read_bytes())
    word(cpu, 0x8E7C, actor)
    for index in range(32):
        word(cpu, actor + index * 0x4C + 8, actor + (index + 1) * 0x4C)
    for head in (0x904A, 0x9096):
        word(cpu, head, 0)
        word(cpu, head + 8, head)
        word(cpu, head + 10, head)
    word(cpu, 0x304A, 0x5845)
    bullets = []

    def boss_hook(uc, address, _size, _data):
        if address == LOAD * 16 + 0x1ED3:
            x, y, direction, speed, sprite = [uc.reg_read(register) for register in (
                UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_CX, UC_X86_REG_DX, UC_X86_REG_BP)]
            x = x if x < 32768 else x - 65536
            y = y if y < 32768 else y - 65536
            vx = struct.unpack_from("<h", image, 0x1F0D + direction * 2)[0] * speed / 16384
            vy = struct.unpack_from("<h", image, 0x1F2D + direction * 2)[0] * speed / 16384
            bullets.append([x, y, vx, vy])
            uc.reg_write(UC_X86_REG_DI, 0xF200)
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)

    cpu.hook_add(UC_HOOK_CODE, boss_hook)
    call(cpu, 0x758F)
    for tick, expected in enumerate(case["states"], 1):
        camera = expected["camera"]
        word(cpu, 0x9190, camera)
        word(cpu, 0x91AA, camera + 16)
        word(cpu, 0x919C, tick)
        word(cpu, 0x9F12, tick % 280 + 20)
        word(cpu, 0x9F16, 160)
        if case["hurt"] and tick == 700:
            word(cpu, actor + 0x24, 7)
        bullets.clear()
        operands = []
        cpu.reg_write(UC_X86_REG_BX, 0x5A5A)
        if cpu.mem_read(DS + 0x922B, 1)[0]:
            for index in range(8):
                cpu.reg_write(UC_X86_REG_SI, actor + (index + 1) * 0x4C)
                call(cpu, 0x71DD)
                operands.append(cpu.reg_read(UC_X86_REG_BX))
        cpu.reg_write(UC_X86_REG_SI, actor)
        call(cpu, 0x72C4)
        operands.append(cpu.reg_read(UC_X86_REG_BX))
        assert operands == [x & 65535 for x in expected["operands"]], ("boss aim carry", tick, operands, expected["operands"])
        for bullet in bullets:
            bullet.append(word(cpu, 0xF20C))
        core = [word(cpu, actor + offset, signed=offset in (0x1A, 0x20, 0x22, 0x40)) for offset in
                (0x16, 0x1A, 0x42, 0x20, 0x22)]
        core.extend([word(cpu, actor + 0x1C) * 65536 + word(cpu, actor + 0x1E),
                     word(cpu, actor + 0x3E, signed=True) * 65536 + word(cpu, actor + 0x3C),
                     word(cpu, actor + 0x40, signed=True), word(cpu, 0x91FE)])
        assert core == expected["core"], f"Boss core tick {tick}: {core} != {expected['core']}"
        assert word(cpu, 0x91AA) == expected["ceiling"], f"Boss camera lock tick {tick}"
        assert word(cpu, 0x304A) == expected["seed"], f"Boss RNG tick {tick}"
        if cpu.mem_read(DS + 0x922B, 1)[0]:
            for index, wanted in enumerate(expected["arms"]):
                a = actor + (index + 1) * 0x4C
                actual = [word(cpu, a + 0x12, signed=True) * 65536 + word(cpu, a + 0x14),
                          word(cpu, a + 0x16, signed=True) * 65536 + word(cpu, a + 0x18),
                          word(cpu, a + 0x1C) * 65536 + word(cpu, a + 0x1E),
                          word(cpu, a + 0x3E, signed=True) * 65536 + word(cpu, a + 0x3C),
                          cpu.mem_read(DS + a + 0x48, 1)[0], word(cpu, a + 0xC)]
                assert actual == wanted, f"Boss arm {index}, tick {tick}: {actual} != {wanted}"
        assert bullets == expected["bullets"], f"Boss shots tick {tick}: {bullets} != {expected['bullets']}"
    print(f"PASS boss, damaged={case['hurt']}: 1200 original core/arm/aim/fire/camera ticks")

for case in native["bossHits"]:
    cpu = machine()
    actor = 0x9F4C
    word(cpu, actor + 0x16, 16)
    word(cpu, actor + 0x24, 30)
    cpu.mem_write(DS + 0x922B, b"\xff")
    word(cpu, 0x9190, 0)
    x, y = case["shot"]["x"], case["shot"]["y"]
    box = [x, y, x, y] if case["shot"]["point"] else [x - 1, y - 4, x + 1, y + 3]
    for offset, value in zip((0x8EB4, 0x8EB6, 0x8EB8, 0x8EBA), box):
        word(cpu, offset, value)
    cpu.reg_write(UC_X86_REG_DI, actor)
    cpu.reg_write(UC_X86_REG_AX, 1)
    call(cpu, 0x714D)
    assert (word(cpu, actor + 0x24) == 29) == case["accepted"], f"Boss eye hit boundary {case}"
print("PASS boss eye: 14 original point/projectile hit-boundary cases")

cpu = machine()
actor = 0x9F4C
word(cpu, 0x8E7C, actor)
for index in range(64):
    word(cpu, actor + index * 0x4C + 8, actor + (index + 1) * 0x4C)
word(cpu, 0x909E, 0x9096)
word(cpu, 0x90A0, 0x9096)
word(cpu, 0x9164, 0)
word(cpu, 0x304A, 0x5845)
cpu.reg_write(UC_X86_REG_CX, 8)
call(cpu, 0x15E4)
credits = [[word(cpu, actor + index * 0x4C + 0x12),
            word(cpu, actor + index * 0x4C + 0x16), 50 if index % 2 == 0 else 100]
           for index in range(18)]
for register, value in [(UC_X86_REG_CX, 19), (UC_X86_REG_AX, 0), (UC_X86_REG_BX, 0),
                        (UC_X86_REG_DX, 320), (UC_X86_REG_DI, 192), (UC_X86_REG_BP, 0x124C)]:
    cpu.reg_write(register, value)
call(cpu, 0x1588)
effects = [[word(cpu, actor + index * 0x4C + 0x12), word(cpu, actor + index * 0x4C + 0x16)]
           for index in range(18, 38)]
assert {"credits": credits, "effects": effects, "seed": word(cpu, 0x304A)} == native["bossBurst"]
assert word(cpu, 0x9164) == 18
print("PASS boss death: 18 counted rewards, 20 explosions, original positions and RNG")

for case in native["credits"]:
    cpu = machine()
    actor = 0x9F4C
    for offset, value in [(0, 0x60), (0xC, 0x11F2), (0x12, case["position"][0]),
                          (0x16, case["position"][1]), (0x1A, 7), (0x1C, 0)]:
        word(cpu, actor + offset, value)

    def credit_hook(uc, address, _size, _data):
        if address in (LOAD * 16 + 0x41B1, LOAD * 16 + 0x3589):
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)
        elif address == LOAD * 16 + 0x42AE:
            uc.reg_write(UC_X86_REG_IP, 0xFF00)

    cpu.hook_add(UC_HOOK_CODE, credit_hook)
    for tick, expected in enumerate(case["states"]):
        cpu.reg_write(UC_X86_REG_SI, actor)
        call(cpu, 0x28DF)
        actual = [word(cpu, actor + offset, signed=offset in (0x12, 0x16, 0x1A))
                  for offset in (0x12, 0x16, 0x1A, 0x1C)] + [word(cpu, actor) == 4]
        assert actual == expected, f"Credit globe {case['position']}, tick {tick}: {actual} != {expected}"
    print(f"PASS counted credit globe {case['position']}: homing, circling and falling expiry")

for case in native["patrols"]:
    cpu = machine()
    actor = 0x9F4C
    stage = case["stage"]
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / f"S{stage}/SPRITES.VGA").read_bytes())
    word(cpu, 0x8E7C, actor)
    word(cpu, actor + 8, actor + 0x4C)
    for head in (0x904A, 0x9096):
        word(cpu, head, 0)
        word(cpu, head + 8, head)
        word(cpu, head + 10, head)
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
    cpu.reg_write(UC_X86_REG_DI, 0xF000)
    cpu.reg_write(UC_X86_REG_SI, 0xF000)
    word(cpu, 0x304A, 0x5845)
    word(cpu, 0x9190, 1000)
    bullets = []
    explosion = None

    def patrol_hook(uc, address, _size, _data):
        global explosion
        if address == LOAD * 16 + 0x1ED3:
            values = [uc.reg_read(register) for register in (
                UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_CX, UC_X86_REG_DX, UC_X86_REG_BP)]
            x, y, direction, speed, sprite = values
            x = x if x < 32768 else x - 65536
            y = y if y < 32768 else y - 65536
            vx = struct.unpack_from("<h", image, 0x1F0D + direction * 2)[0] * speed / 16384
            vy = struct.unpack_from("<h", image, 0x1F2D + direction * 2)[0] * speed / 16384
            bullets.append([x, y, vx, vy, sprite])
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)
        elif address == LOAD * 16 + 0x3326:
            x, y = [uc.reg_read(register) for register in (UC_X86_REG_AX, UC_X86_REG_BX)]
            explosion = [x if x < 32768 else x - 65536, y if y < 32768 else y - 65536,
                         uc.reg_read(UC_X86_REG_BP) == 0x124C]
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)

    cpu.hook_add(UC_HOOK_CODE, patrol_hook)
    call(cpu, 0x705B if stage == 1 else 0x8018)
    camera = 1000
    for tick, expected in enumerate(case["states"]):
        word(cpu, 0x9198, camera - expected["camera"])
        camera = expected["camera"]
        word(cpu, 0x9190, camera)
        word(cpu, 0x91AA, expected["ceiling"])
        word(cpu, 0x9F16, expected["playerY"])
        cpu.reg_write(UC_X86_REG_SI, actor)
        bullets.clear()
        call(cpu, 0x6E2C if stage == 1 else 0x7E87)
        dead = word(cpu, actor) == 4
        assert dead == expected["dead"], f"Patrol removal {case}, tick {tick}"
        assert word(cpu, 0x304A) == expected["seed"], f"Patrol RNG stage {stage}, tick {tick}"
        if dead:
            break
        actual = {
            "actor": [word(cpu, actor + offset, signed=offset in (0x16, 0x1A)) for offset in
                      (0x12, 0x16, 0x1A, 0x1C, 0x22, 0x24, 0xC, 0xE)],
            "box": [word(cpu, actor + offset, signed=True) for offset in (0x28, 0x2A, 0x2C, 0x2E)],
            "bullets": bullets,
        }
        wanted = {key: expected[key] for key in actual}
        assert actual == wanted, f"Patrol {stage}/{case['side']}/{case['scenario']}, tick {tick}: {actual} != {wanted}"
    if case["death"]:
        word(cpu, 0x9152, 0)
        word(cpu, 0x9154, 0)
        cpu.reg_write(UC_X86_REG_DI, actor)
        cpu.reg_write(UC_X86_REG_AX, word(cpu, actor + 0x24))
        call(cpu, 0x3AA7)
        assert {"effect": explosion, "score": word(cpu, 0x9152)} == case["death"], "Patrol death differs"
    print(f"PASS patrol {stage}/{case['side']}/{case['scenario']}: movement, animation, collision, RNG and shots")

for case in native["randomGuns"]:
    cpu = machine()
    actor = 0x9F4C
    stage = case["stage"]
    word(cpu, 0x8E7C, actor)
    word(cpu, actor + 8, actor + 0x4C)
    word(cpu, 0x9052, 0x904A)
    word(cpu, 0x9054, 0x904A)
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
    cpu.reg_write(UC_X86_REG_DI, 0xF000)
    word(cpu, 0x304A, 0x5845)
    bullet = None

    def random_gun_hook(uc, address, _size, _data):
        global bullet
        if address == LOAD * 16 + 0x1ED3:
            x, y, direction, speed, sprite = [uc.reg_read(register) for register in (
                UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_CX, UC_X86_REG_DX, UC_X86_REG_BP)]
            vx = struct.unpack_from("<h", image, 0x1F0D + direction * 2)[0] * speed / 16384
            vy = struct.unpack_from("<h", image, 0x1F2D + direction * 2)[0] * speed / 16384
            bullet = [x, y, vx, vy, sprite]
            uc.reg_write(UC_X86_REG_DI, 0xF200)
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)
        elif address == LOAD * 16 + 0x3326:
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)

    cpu.hook_add(UC_HOOK_CODE, random_gun_hook)
    call(cpu, {2: 0x7F82, 3: 0xA40F, 4: 0xC5C3, 5: 0xE35A}[stage])
    cell = word(cpu, actor + 0x38)
    for tick, expected in enumerate(case["states"]):
        word(cpu, 0x9190, 1000)
        word(cpu, 0x91AA, 1016)
        cpu.reg_write(UC_X86_REG_SI, actor)
        bullet = None
        call(cpu, {2: 0x7DDE, 3: 0xAB25, 4: 0xC61A, 5: 0xE3B3}[stage])
        if bullet and stage == 5:
            bullet[4] = word(cpu, 0xF20C)
        actual = {"phase": word(cpu, actor + 0x1A), "seed": word(cpu, 0x304A),
                  "counter": cpu.mem_read(DS + actor + 0x48, 1)[0],
                  "patches": [word(cpu, cell + offset) for offset in
                              ((0, 2, 40, 42) if stage == 4 else (0,))], "bullet": bullet}
        assert actual == expected, f"Stage {stage} gun side {case['event'][6]}, tick {tick}: {actual} != {expected}"
    cpu.reg_write(UC_X86_REG_DI, actor)
    cpu.reg_write(UC_X86_REG_AX, word(cpu, actor + 0x24))
    call(cpu, 0xC6E5 if stage == 4 else 0x3B76)
    assert [word(cpu, cell + offset) for offset in
            ((0, 2, 40, 42) if stage == 4 else (0,))] == case["death"], "Destroyed gun tiles differ"
    print(f"PASS stage {stage} gun {case['event'][6]}: animation, RNG, shots and destroyed tiles")

for forced, case in [(False, case) for case in native["controls"]] + [
        (True, case) for case in native["miniControls"]]:
    cpu = machine()
    player = 0x9F00
    for offset, value in [(player + 0x12, 160), (player + 0x16, 174), (0x9190, 4608),
                          (0x91AA, 4607), (0x918C, 1), (0x91AE, 16), (0x91A8, 224),
                          (0x915E, case["speed"]), (0x919E, 0), (0x91A0, 0)]:
        word(cpu, offset, value)
    if forced:
        for offset, value in [(0x9190, 2600), (0x91AA, 2880), (0x918C, -1), (0x91A8, 2528)]:
            word(cpu, offset, value)

    def scroll_hook(uc, address, _size, _data):
        if address == LOAD * 16 + 0x3F03:
            uc.reg_write(UC_X86_REG_IP, 0xFF00)

    cpu.hook_add(UC_HOOK_CODE, scroll_hook)
    for tick, entry in enumerate(case["states"]):
        cpu.mem_write(DS + 0x8F59, bytes([entry["bits"]]))
        cpu.reg_write(UC_X86_REG_SI, player)
        call(cpu, 0x44F3)
        call(cpu, 0x3E1A)
        actual = [word(cpu, offset, signed=True) for offset in
                  (player + 0x12, player + 0x16, 0x9190, 0x91AA, 0x919E, 0x91A0, 0x9198)]
        assert actual == entry["state"], f"Speed {case['speed']}, tick {tick}: {actual} != {entry['state']}"
    print(f"PASS speed {case['speed']}, forced reverse={forced}: 256 original keyboard/camera ticks")

for case in native["weapons"]:
    cpu = machine()
    actor = 0x9F4C
    word(cpu, 0x8E7C, actor)
    for index in range(3):
        word(cpu, actor + index * 0x4C + 8, actor + (index + 1) * 0x4C)
    word(cpu, 0x9096, 0)
    word(cpu, 0x909E, 0x9096)
    word(cpu, 0x90A0, 0x9096)
    word(cpu, 0x9F12, 160)
    word(cpu, 0x9F16, 174)
    word(cpu, 0xF200 + 0x34, case["power"])
    cpu.mem_write(DS + 0x8FAE, b"\xff")
    cpu.reg_write(UC_X86_REG_SI, 0xF200)
    call(cpu, {1: 0x37DF, 8: 0x3835, 10: 0x3801, 14: 0x20F7}[case["id"]])
    actual = [[word(cpu, actor + index * 0x4C + offset, signed=offset in (0x1C, 0x20))
               for offset in (0x1C, 0x20, 0x12, 0x16, 0xC, 0x34)]
              for index in range(len(case["shots"]))]
    assert actual == case["shots"], f"Weapon {case['id']}/{case['power']}: {actual} != {case['shots']}"
    print(f"PASS weapon {case['id']}/{case['power']}: original muzzles, velocities, masks and damage")

for stage in native["health"]:
    number = stage["stage"]
    for case in stage["cases"]:
        cpu = machine()

        def constructor_hook(uc, address, _size, _data):
            if address == LOAD * 16 + 0x3589:
                sp = uc.reg_read(UC_X86_REG_SP)
                ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
                uc.reg_write(UC_X86_REG_SP, sp + 2)
                uc.reg_write(UC_X86_REG_IP, ip)
            elif number == 2 and address == LOAD * 16 + 0x8F76:
                uc.reg_write(UC_X86_REG_IP, 0xFF00)

        cpu.hook_add(UC_HOOK_CODE, constructor_hook)
        word(cpu, 0x991A, stage["round"])
        call(cpu, {1: 0x7637, 2: 0x8F68, 3: 0xACCE, 4: 0xC809, 5: 0xE4F7}[number])
        word(cpu, 0x8E7C, 0x9F4C)
        for index in range(10):
            word(cpu, 0x9F4C + index * 0x4C + 8, 0x9F4C + (index + 1) * 0x4C)
        word(cpu, 0x9052, 0x904A)
        word(cpu, 0x9054, 0x904A)
        paths = (ROOT / f"S{number}/PATHS.BIN").read_bytes()
        cpu.mem_write(DS + 0xDE30, paths)
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", 4608, case["type"], 1, 1, 0, 0, 3))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        cpu.reg_write(UC_X86_REG_BX, case["type"])
        call(cpu, {1: 0x70F1, 2: 0x80CA, 3: 0xABCC, 4: 0xC771, 5: 0xE475}[number])
        actual = [word(cpu, 0x9F4C + index * 0x4C + 0x24)
                  for index in range(len(case["parts"]))]
        # Attached actor health is unused; all damage is routed through the root.
        assert actual[0] == case["parts"][0], (number, stage["round"], case, actual)
        if stage["round"] == 1:
            assert actual == case["parts"], (number, case, actual)
    print(f"PASS stage {number}, round {stage['round']}: original foreground health")

cpu = machine()
actor = 0x9F4C
word(cpu, actor + 0xC, 0x934C)
word(cpu, actor + 0xE, 0)
word(cpu, actor + 0x10, 0x12FC)
word(cpu, 0x991E, 0)
word(cpu, 0x9F12, 160)
word(cpu, 0x9F16, 100)


def rear_hook(uc, address, _size, _data):
    if address == LOAD * 16 + 0x45F4:
        sp = uc.reg_read(UC_X86_REG_SP)
        ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
        uc.reg_write(UC_X86_REG_SP, sp + 2)
        uc.reg_write(UC_X86_REG_IP, ip)


cpu.hook_add(UC_HOOK_CODE, rear_hook)
for tick, expected in enumerate(native["rear"]):
    cpu.mem_write(DS + 0x8FAE, bytes([255 if expected["fired"] else 0]))
    cpu.reg_write(UC_X86_REG_SI, actor)
    call(cpu, 0x3835)
    actual = [word(cpu, actor + offset) for offset in (0x12, 0x16, 0xC)]
    assert actual == expected["state"], f"Rear attachment tick {tick}: {actual} != {expected}"
print("PASS rear attachment: original anchor and idle/firing animation over 40 ticks")

for case in native["shops"]:
    cpu = machine()
    word(cpu, 0x9190, case["camera"])
    word(cpu, 0x91AA, case["camera"] + 16)
    word(cpu, 0x9F16, case["y"])
    cpu.mem_write(DS + 0x922C, bytes([255 if case["visited"] else 0]))
    cpu.mem_write(DS + 0x8FB0, b"\0")

    def shop_hook(uc, address, _size, _data):
        if address == LOAD * 16 + 0x6590:
            uc.reg_write(UC_X86_REG_IP, 0xFF00)

    cpu.hook_add(UC_HOOK_CODE, shop_hook)
    call(cpu, 0x655B)
    actual = [word(cpu, 0x9190), word(cpu, 0x91AA),
              bool(cpu.mem_read(DS + 0x922C, 1)[0]), bool(cpu.mem_read(DS + 0x8FB0, 1)[0])]
    assert actual == case["state"], f"Shop checkpoint {case}: {actual}"
print("PASS stage-one shop: original world-Y boundaries, camera snap and one-visit flag")

for case in native["shopCredits"]:
    cpu = machine()
    entry = [0x758F, 0x8E0D, 0xAC5A, 0xC7AB, 0xE4BB][case["stage"] - 1]

    def credit_hook(uc, address, _size, _data):
        if address in (LOAD * 16 + entry + 12, LOAD * 16 + 0x403E):
            uc.reg_write(UC_X86_REG_IP, 0xFF00)

    cpu.hook_add(UC_HOOK_CODE, credit_hook)
    call(cpu, entry)
    word(cpu, 0x304A, 0x5845)
    word(cpu, 0x9190, case["camera"])
    word(cpu, 0x915A, case["balance"] & 65535)
    word(cpu, 0x915C, case["balance"] >> 16)
    call(cpu, 0x3FCC)
    actual = [word(cpu, 0x915A) + word(cpu, 0x915C) * 65536, word(cpu, 0x304A)]
    assert actual == case["state"], f"Shop credit floor {case}: {actual}"
print("PASS shop credits: original stage-specific minimum balances and RNG in 30 cases")

def set_camera(cpu, camera):
    word(cpu, 0x9190, camera)
    word(cpu, 0x918E, camera // 16 * 40)
    word(cpu, 0x9196, camera % 16)


def dive_machine(x, scroll=False, draw_meters=False):
    cpu = machine()
    skipped = {0xF96}
    if not draw_meters:
        skipped.add(0x465C)
    if not scroll:
        skipped.add(0x3E1A)
    skip_calls(cpu, skipped)
    if scroll:
        cpu.hook_add(UC_HOOK_CODE, lambda uc, *_: uc.reg_write(UC_X86_REG_IP, 0xFF00),
                     begin=LOAD * 16 + 0x3F03, end=LOAD * 16 + 0x3F03)
    for offset, value in [(0x8E6E, 1), (0x9054, 0xA000), (0xA000, 0), (0x9160, 3), (0x9164, 0),
                          (0x918C, 1), (0x91AA, 4000), (0x9F12, x), (0x9F16, 174)]:
        word(cpu, offset, value)
    for offset in (0x8E7E, 0x8E80, 0x8E82, 0x8E84, 0x9150, 0x9162, 0x919E, 0x991E, 0x9224):
        word(cpu, offset, 0)
    set_camera(cpu, 4000)
    cpu.mem_write(DS, bytes(12000))
    cpu.mem_write(DS + 0x5538, bytes(64))
    cpu.mem_write(DS + 0x8ECC, struct.pack("<3H", 4000, x, 174) * 17)
    return cpu


for case in native["diveTraces"]:
    cpu = dive_machine(160)
    cpu.mem_write((0x349B + LOAD) * 16, base64.b64decode(native["sharedSprites"]))
    word(cpu, 0x9F0C, 0x77A)
    for offset, value in [(0x28, 158), (0x2A, 167), (0x2C, 162), (0x2E, 171)]:
        word(cpu, 0xA04C + offset, value)
    for tick, expected in enumerate(case["states"]):
        phase = word(cpu, 0x8E80)
        cpu.reg_write(UC_X86_REG_SI, 0x9F00)
        call(cpu, 0x4311)
        pose = word(cpu, 0x9F0C) if phase else 0
        masked = word(cpu, 0x9F04) == 0x897
        cpu.reg_write(UC_X86_REG_SI, 0xA04C)
        call(cpu, 0x42AE)
        collected = not bool(cpu.reg_read(UC_X86_REG_EFLAGS) & 0x40)
        call(cpu, 0x4675)
        if tick in case["presses"]:
            call(cpu, 0x3DBD)
        state = [word(cpu, a, signed=True) for a in (0x8E80, 0x8E82, 0x8E84, 0x8E7E, 0x991E)]
        state.extend((pose, masked, word(cpu, 0x9160), collected))
        assert state == expected, (case["presses"], tick, state, expected)
print("PASS dive poses, terrain painter, posture, timer, charges and pickup eligibility in six input traces")

for case in native["timedMeters"]:
    cpu = dive_machine(160, draw_meters=True)
    cpu.mem_write((0x349B + LOAD) * 16, base64.b64decode(native["sharedSprites"]))
    word(cpu, 0x9F0C, 0x77A)
    word(cpu, 0x9150, case["shades"])
    draws = sprite_draw_trace(cpu)
    for tick, state in enumerate(case["states"]):
        if state["kill"]:
            call(cpu, 0x3C01)
        cpu.reg_write(UC_X86_REG_SI, 0x9F00)
        call(cpu, 0x4311)
        draws.clear()
        call(cpu, 0x4675)
        if state["request"]:
            call(cpu, 0x3DBD)
        remaining = [word(cpu, a, signed=True) for a in (0x9150, 0x8E84, 0x8E82, 0x991E)]
        assert draws == state["draws"], (case["shades"], tick, draws, state["draws"])
        assert remaining == state["remaining"], (case["shades"], tick, remaining, state["remaining"])
print("PASS dive and Shades meters: 229 DOS ticks of draw order, sprite levels, request timing and death")

for case in native["terrainHull"]:
    cpu = machine()
    tiles = (ROOT / f'S{case["stage"]}' / "MODS.VGA").read_bytes()
    planes = list(struct.iter_unpack(">4H", tiles))
    cpu.mem_write(DS + 0x5538, b"".join(struct.pack(">H", a | b | c | d) for a, b, c, d in planes))
    cpu.mem_write(DS, struct.pack("<6000H", *case["map"]))
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    for camera, x, y, expected in case["states"]:
        set_camera(cpu, camera)
        word(cpu, 0x9F12, x)
        word(cpu, 0x9F16, y)
        call(cpu, 0x1E29)
        assert (cpu.reg_read(UC_X86_REG_AX) == 0xFFFF) == expected, (case["stage"], camera, x, y, expected)
print("PASS resurfacing hull intersection: 1,600 original tile samples across all five stages")

for case in native["diveRecoveries"]:
    cpu = dive_machine(155)
    cpu.mem_write(DS + 0x5558, b"\xff" * 32)
    for row in range(259, 262):
        for column in range(12 if case["escape"] else 9, 13):
            word(cpu, 2 * (row * 20 + column), 1 << 6)
    for tick, expected in enumerate(case["states"]):
        cpu.mem_write(DS + 0x8F59, b"\x08" if 0 < tick < 12 else b"\0")
        cpu.reg_write(UC_X86_REG_SI, 0x9F00)
        call(cpu, 0x4311)
        call(cpu, 0x4675)
        if tick in (0, 4):
            call(cpu, 0x3DBD)
        state = [word(cpu, a, signed=True) for a in (0x9F12, 0x9F16, 0x8E7E)]
        state.append(cpu.mem_read(DS + 0x9224, 1) != b"\0")
        assert state == expected, (case["escape"], tick, state, expected)
    assert state[-1] != case["escape"]
print("PASS resurfacing history: safe escape and forced death")

for case in native["terrainRecoveries"]:
    mode = case["mode"]
    x = 159 if mode in ("brush", "clear") else 162
    y = 16 if mode == "upper-limit" else 174
    cpu = dive_machine(x, scroll=True)
    for offset, value in [(0x91AE, 16), (0x91A0, 0), (0x91A8, 3900),
                          (0x9F16, y), (0x9164, int(mode == "counted"))]:
        word(cpu, offset, value)
    cpu.mem_write(DS + 0x8ECC, struct.pack("<3H", 4000, x, y) * 17)
    cpu.mem_write(DS + 0x5558, b"\xff" * 32)
    row = (4000 + y) // 16
    for r in range(row - 2, row + 3):
        word(cpu, 2 * (r * 20 + 11), 64)
    for tick, entry in enumerate(case["states"]):
        if mode == "clear" and tick == 1:
            cpu.mem_write(DS, bytes(12000))
        word(cpu, 0x919A, 1)
        cpu.mem_write(DS + 0x8F59, bytes([entry["bits"]]))
        cpu.reg_write(UC_X86_REG_SI, 0x9F00)
        call(cpu, 0x4311)
        call(cpu, 0x3E1A)
        state = [word(cpu, a, signed=True) for a in (0x9F12, 0x9F16, 0x9190, 0x91AA, 0x919E, 0x8E7E)]
        state.append(cpu.mem_read(DS + 0x9224, 1) != b"\0")
        assert state == entry["state"], (mode, tick, state, entry["state"])
print("PASS ordinary terrain: six DOS recovery traces including moving camera, clamps and counted-credit immunity")

cpu = dive_machine(160)
cpu.mem_write((0x349B + LOAD) * 16,
              base64.b64decode(native["sharedSprites"]) + base64.b64decode(native["weaponSprites"]))
ring_actor = 0x9F4C
word(cpu, 0x8E7C, ring_actor)
word(cpu, ring_actor + 8, 0)
word(cpu, 0x90A0, 0x90A2)
word(cpu, 0x9188, 0)
for tick, case in enumerate(native["ringTrace"]):
    if case["grant"]:
        call(cpu, 0x2B80)
    bits = 4 if case["left"] else 8 if case["right"] else 0
    cpu.mem_write(DS + 0x8F59, bytes([bits]))
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x4311)
    ring = None
    if word(cpu, 0x9188):
        cpu.reg_write(UC_X86_REG_SI, ring_actor)
        call(cpu, 0x1FB4)
        if word(cpu, ring_actor + 4) == 0x853:
            ring = [word(cpu, ring_actor + 0xC),
                    *[word(cpu, ring_actor + a, signed=True) for a in (0x12, 0x16)]]
    call(cpu, 0x4675)
    if case["dive"]:
        call(cpu, 0x3DBD)
    state = [word(cpu, 0x9188), word(cpu, 0x991E), ring]
    assert state == case["state"], (tick, state, case["state"],
                                   [word(cpu, a) for a in (0x9F0C, 0x9F12, 0x9F16, 0x915E)])
print("PASS invulnerability ring: 580 original ticks of extension, animation, placement, dive posture and expiry")

for case in native["shadeTraces"]:
    cpu = dive_machine(160)
    cpu.mem_write((0x349B + LOAD) * 16, base64.b64decode(native["sharedSprites"]))
    if case["timer"] == 220:
        call(cpu, 0x4FD7)
        assert word(cpu, 0x9150) == 220
    else:
        word(cpu, 0x9150, case["timer"])
    word(cpu, 0x8E80, case["phase"])
    word(cpu, 0x9F0C, 0x77A)
    word(cpu, 0x9F16, 90)
    actors = [0xA000 + index * 0x4C for index in range(len(case["boxes"]))]
    for actor, (x, y) in zip(actors, case["boxes"]):
        for offset, value in [(0, 0xC8), (6, 0x761), (0xA, actor + 0x4C),
                              (0x28, x), (0x2A, y), (0x2C, x), (0x2E, y)]:
            word(cpu, actor + offset, value)
    word(cpu, actors[-1] + 0x4C, 0)
    damage = [0] * len(actors)

    def shade_hit(uc, _address, _size, _data):
        damage[actors.index(uc.reg_read(UC_X86_REG_DI))] += uc.reg_read(UC_X86_REG_AX)

    cpu.hook_add(UC_HOOK_CODE, shade_hit, begin=LOAD * 16 + 0x761, end=LOAD * 16 + 0x761)
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x4311)
    call(cpu, 0x4675)
    assert damage == case["damage"] and word(cpu, 0x9150) == case["countdown"], (case, damage)
print("PASS Shades: purchase duration, inclusive range, first target, dive and expiry in six original cases")


for case in native["checkpoints"]:
    if not case["index"]:
        cpu = machine()
    cpu.mem_write(DS + 0xDA9E, struct.pack("<7H", *case["event"]))
    cpu.reg_write(UC_X86_REG_SI, 0xDA9E)
    word(cpu, 0x915A, case["balance"])
    word(cpu, 0x915C, case["balance"] >> 16)
    word(cpu, 0x9162, case["timer"])
    for slot, (kind, power) in enumerate(case["inventory"]):
        actor = 0x9F4C + slot * 0x4C
        word(cpu, 0x9134 + 4 * slot, kind)
        word(cpu, 0x9136 + 4 * slot, actor)
        word(cpu, actor + 0x34, power)
    call(cpu, 0x35CE)
    saved = [word(cpu, a) for a in (0x91A6, 0x91A2, 0x91A4)]
    saved.append(word(cpu, 0x9166) + word(cpu, 0x9168) * 65536)
    saved.extend([word(cpu, 0x916A + i * 4), word(cpu, 0x916C + i * 4)] for i in range(7))
    assert saved == case["saved"], (case, saved)
print("PASS all 39 checkpoint snapshots: camera, X/Y word, 32-bit credits and Nashwan equipment exemption")

skip_calls(cpu, {0x193C, 0x5926, 0xD5F})
word(cpu, 0x9162, 0)
call(cpu, 0x195B)
camera, x, _, credits = saved[:4]
assert [word(cpu, a) for a in (0x9190, 0x91AA, 0x9192, 0x9194)] == [
    camera, camera, camera + 1, camera + 192]
assert [word(cpu, a) for a in (0x9F12, 0x9F16, 0x915A, 0x915C)] == [x, 176, credits & 65535, credits >> 16]
assert [word(cpu, 0x8EBC + i * 2) for i in range(8)] == [x, 176] * 4
print("PASS original checkpoint restore: position, exclusive event bounds, credits and trailing samples")

case = native["cameraWatermarks"]
cpu = machine()
limits = lambda: [word(cpu, offset) for offset in (0x9192, 0x9194)]
cpu.emu_start(LOAD * 16 + 0x1AC1, LOAD * 16 + 0x1ACD)
assert limits() == case["startLimits"]
skip_calls(cpu, {0x193C, 0x5926, 0xD5F})
word(cpu, 0x91A6, 2000)
call(cpu, 0x195B)
assert limits() == case["restoredLimits"]
for field, base in (("events", 0xD274), ("background", 0xDA9E)):
    cpu.mem_write(DS + base, b"".join(struct.pack("<7H", *event) for event in case[field]) + b"\xff\xff")
seen = []


def event_trace(uc, address, _size, _data):
    seen.append([int(address == LOAD * 16 + 0xFD2), word(uc, uc.reg_read(UC_X86_REG_SI))])
    sp = uc.reg_read(UC_X86_REG_SP)
    uc.reg_write(UC_X86_REG_SP, sp + 2)
    uc.reg_write(UC_X86_REG_IP, struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0])


for entry in (0xFB4, 0xFD2):
    cpu.hook_add(UC_HOOK_CODE, event_trace, begin=LOAD * 16 + entry, end=LOAD * 16 + entry)
for state in case["states"]:
    seen.clear()
    word(cpu, 0x9190, state["camera"])
    call(cpu, 0x3615)
    assert seen == state["seen"] and limits() == state["limits"], (state, seen, limits())
print("PASS camera high-water marks: startup, distinct checkpoint limits, unsorted dispatch, held scroll and reversal")

for entry, stop, camera in [(0xC12C, 0xC150, 2480), (0xD4A8, 0xD4CC, 416)]:
    for timer in (0, 100):
        cpu = machine()
        cpu.mem_write(DS + (0x9236 if entry == 0xC12C else 0x9238), b"\0")
        for offset, value in [(0x9162, timer), (0x9166, 123), (0x915A, 654),
                              (0x9134, 0x94), (0x9136, 0x9F4C), (0x9F80, 2)]:
            word(cpu, offset, value)
        cpu.mem_write(DS + 0x9138, bytes(24))
        cpu.mem_write(DS + 0x916A, bytes(28))
        skip_calls(cpu, {stop})
        call(cpu, entry)
        assert [word(cpu, a) for a in (0x91A6, 0x91A2, 0x91A4, 0x9166)] == [camera, 160, 176, 123]
        assert [word(cpu, a) for a in (0x916A, 0x916C)] == ([0, 0] if timer else [0x94, 2])
print("PASS special checkpoint writes: both arenas save position and equipment, not current credits")

cpu = machine()
for address in (0x9164, 0x9162, 0x991E, 0x8E84, 0x9150):
    word(cpu, address, 0)
cpu.mem_write(DS + 0x8F59, b"\0")
call(cpu, 0x3C01)
death_frames = []
for _ in range(16):
    death_frames.append(word(cpu, 0x9F0C))
    call(cpu, 0x4675)
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x4311)
assert death_frames == native["deathFrames"], (death_frames, native["deathFrames"])
assert cpu.mem_read(DS + 0x8F5C, 1) == b"\xff"
print("PASS death animation: original frame sequence through the full 16-step posture change")

for accept_at in (0, 1, 79):
    cpu = machine()
    skip_calls(cpu, {0x5935, 0x595D, 0x9EB, 0xAFB, 0xB83, 0x831, 0xA51, 0x5950})
    word(cpu, 0x91B0, 2)
    countdown = []

    def continue_input(uc, address, _size, _data):
        if address == LOAD * 16 + 0x5C58:
            countdown.append(int(bytes(uc.mem_read(DS + 0x346C, 1))))
            if len(countdown) == accept_at:
                uc.mem_write(DS + 0x8F5B, b"\xff")

    cpu.hook_add(UC_HOOK_CODE, continue_input)
    call(cpu, 0x5C0F)
    assert countdown == native["countdown"][:accept_at or 79]
    assert cpu.reg_read(UC_X86_REG_AX) == (0xFFFF if accept_at else 0)
print("PASS original continue countdown: 79 updates, timeout and first/last-tick acceptance")


cpu = machine()
skip_calls(cpu, {0xF5A})
swap_regions = [(DS + 0x8FB2, DS + 0xCE80, 0x28C), (DS + 0x9F00, DS + 0x8F62, 0x4C),
                (DS, (LOAD + 0x1565) * 16, 12000)]
for first, second, size in swap_regions:
    cpu.mem_write(first, bytes([0x4A]) * size)
    cpu.mem_write(second, bytes([0xB5]) * size)
word(cpu, 0x8E7A, 0)
word(cpu, 0x304A, 0x5845)
word(cpu, 0x8E7C, 0xA000)
for offset, value in [(0x91B0, 2), (0xCE80 + 0x91B0 - 0x8FB2, 3)]:
    word(cpu, offset, value)
for active, expected in [(1, [0xB5, 0x4A]), (0, [0x4A, 0xB5])]:
    call(cpu, 0x1A19)
    assert word(cpu, 0x8E7A) == active
    for first, second, size in swap_regions:
        for i, base in enumerate((first, second)):
            wanted = bytearray([expected[i]]) * size
            if first == DS + 0x8FB2:
                struct.pack_into("<H", wanted, 0x91B0 - 0x8FB2, 2 + (active ^ i))
            assert cpu.mem_read(base, size) == wanted
    assert word(cpu, 0x304A) == 0x5845 and word(cpu, 0x8E7C) == 0xA000
print("PASS original two-player swap: personal credits, records, ship and map exchange; RNG and free-list head stay shared")

for stage, active_alive, peer_alive, peer_finished, expected in [
    (1, 1, 0, 0, (0, 0, 0)), (1, 1, 1, 0, (1, 0, 0)), (1, 1, 1, 1, (0, 0, 0)),
    (1, 0, 1, 0, (1, 0, 0)), (1, 0, 1, 1, (1, 255, 0)), (5, 0, 1, 1, (1, 255, 255)),
]:
    cpu = machine()
    skip_calls(cpu, {0x195B, 0xF5A})
    for offset, value in [(0x991C, stage), (0x8E7A, 0), (0x8F5D, active_alive | peer_alive << 8),
                          (0x8F5F, peer_finished << 8), (0x8F61, 0), (0x8FB0, 0), (0x991E, 0)]:
        word(cpu, offset, value)
    call(cpu, 0x1A65)
    actual = (word(cpu, 0x8E7A), word(cpu, 0x8F61) & 255, word(cpu, 0x8FB0) & 255)
    assert actual == expected and word(cpu, 0x991E) == 8, (stage, active_alive, peer_alive, peer_finished, actual)
print("PASS original two-player handoffs: six live, eliminated and stage-finished cases")

for start_stage in (1, 5):
    cpu = machine()
    skip_calls(cpu, {0xD5F, 0x18F5, 0x195B, 0x3760, 0xF5A, 0xF78, 0x5CC5,
                     0x193C, 0x985, 0x80F, 0xA2F, 0xE2B, 0xD81, 0x3319, 0x35EB})
    peer = 0xCE80 - 0x8FB2
    for offset, value in [(0x8E70, 2), (0x8E7A, 0), (0x8F5D, 0x0101), (0x8F5F, 0), (0x8F54, 0),
                          (0x991C, start_stage), (0x991A, 1), (0x9162, 0), (peer + 0x9162, 0),
                          (0x915A, 123), (peer + 0x915A, 456), (0x91B0, 3), (peer + 0x91B0, 2),
                          (0x9008, 0x9000), (peer + 0x9008, 0x9000), (0x9000, 0), (peer + 0x9000, 0)]:
        word(cpu, offset, value)
    victory = int(start_stage == 5)
    for stage, active, finished, balances, continues, round_number in [
        (start_stage, 1, 0x00FF, [456, 123], [2, 3 + victory], 1),
        (1 if victory else 2, 0, 0, [0, 0], [3 + victory, 2 + victory], 1 + victory),
    ]:
        cpu.reg_write(UC_X86_REG_SP, 0xFFFC)
        cpu.emu_start(LOAD * 16 + 0x40A7, LOAD * 16 + 0x3D26, count=150000)
        ip = cpu.reg_read(UC_X86_REG_IP)
        assert ip == 0x3D26, (stage, hex(cpu.reg_read(UC_X86_REG_CS)), hex(ip))
        assert [word(cpu, offset) for offset in (0x991C, 0x8E7A, 0x8F5F, 0x991A)] == [
            stage, active, finished, round_number]
        assert [word(cpu, offset) for offset in (0x915A, peer + 0x915A)] == balances
        assert [word(cpu, offset) for offset in (0x91B0, peer + 0x91B0)] == continues
print("PASS original two-player stage gate: both players advance together and earn their own victory credit")


def mini_machine():
    cpu = machine()
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
    paths = (ROOT / "S2/PATHS.BIN").read_bytes()
    cpu.mem_write(DS + 0xDE30, paths)
    for i, offset in enumerate(struct.unpack_from("<115H", paths)):
        word(cpu, 0xDE30 + i * 2, offset + 0xDF16)
    word(cpu, 0x8E7C, 0xB000)
    for i in range(100):
        word(cpu, 0xB000 + i * 0x4C + 8, 0xB000 + (i + 1) * 0x4C)
    for head in (0x904A, 0x9096):
        for offset in (8, 10):
            word(cpu, head + offset, head)
        word(cpu, head, 0)
    word(cpu, 0x304A, 0x5845)
    return cpu


for case in native["miniEyes"]:
    cpu = mini_machine()
    for offset, value in [(0x9190, 2700), (0x91AA, 2716), (0x9200, case["remaining"]),
                          (0x918C, -1 if case["remaining"] == 1 else 1)]:
        word(cpu, offset, value)
    eyes = []
    for i, (x, y) in enumerate([(9, 184), (4, 164), (14, 164)]):
        actor = 0xA000 + i * 0x4C
        for offset, value in [(0x12, x), (0x16, y), (0x22, 2 - i), (0x1A, 0),
                              (0xC, (y * 20 + x) * 2)]:
            word(cpu, actor + offset, value)
        eyes.append(actor)
    for i in range(8):
        word(cpu, 0x91D4 + i * 2, 24)
    for expected in case["states"]:
        word(cpu, 0x919C, expected["tick"])
        word(cpu, 0x9F12, expected["x"])
        word(cpu, 0x9202, expected["busy"])
        for actor in reversed(eyes):
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, 0x88A9)
        actual = []
        for actor in eyes:
            box = [word(cpu, actor + 0x28, signed=True)]
            if box[0] != 1000:
                box.extend(word(cpu, actor + offset, signed=True) for offset in (0x2A, 0x2C, 0x2E))
            actual.append([word(cpu, actor + 0x1A), box, word(cpu, word(cpu, actor + 0xC))])
        assert actual == expected["eyes"], (case["remaining"], expected["tick"], actual, expected["eyes"])
        assert word(cpu, 0x91AA) == expected["ceiling"]
        assert [word(cpu, 0x91D4 + i * 2) for i in range(8)] == expected["lights"]
        tiles = []
        for i in range(8):
            cell = struct.unpack_from("<H", image, 0x9219 + i * 18)[0]
            tiles.append([word(cpu, cell + delta) for delta in (0, 2, 40, 42)])
        assert tiles == expected["tiles"]
    print(f"PASS miniboss eyes, remaining={case['remaining']}: eligibility, animation, lights, reverse ceiling")

for case in native["miniWaves"]:
    cpu = mini_machine()
    side, entry = case["entry"] & 1, case["entry"]
    for offset, value in [(0xFCFA, side), (0x9200, 3), (0x9190, case["camera"]),
                          (0x919A, case["scroll"]), (0x91F4 + side * 2, (entry & 6) << 5)]:
        word(cpu, offset, value)
    cpu.mem_write(DS + 0x922F, bytes([2 if entry < 8 else 0]))
    call(cpu, 0x81E7)
    actors = [0xB000 + i * 0x4C for i in range(12)]
    centre = 0xA500
    for offset, value in [(0x12, 9), (0x16, 184), (0x22, 2), (0xC, 0x1CD2)]:
        word(cpu, centre + offset, value)
    initial = [[word(cpu, a + offset, signed=offset in (0x12, 0x16, 0x1A))
                for offset in (0x12, 0x16, 0x1A, 0x24, 0xC)] for a in actors]
    assert initial == case["initial"], (entry, initial, case["initial"])
    for tick, expected in enumerate(case["states"], 1):
        word(cpu, 0x9198, expected["delta"])
        cpu.mem_write(DS + 0x922D, b"\x00\x00")
        for a in reversed(actors):
            if word(cpu, a) == 4:
                continue
            cpu.reg_write(UC_X86_REG_SI, a)
            call(cpu, 0x866D)
        word(cpu, 0x919C, tick)
        cpu.reg_write(UC_X86_REG_SI, centre)
        call(cpu, 0x88A9)
        actual = []
        for a in reversed(actors):
            if word(cpu, a) == 4:
                actual.append(None)
                continue
            state = [word(cpu, a + high, signed=True) * 65536 + word(cpu, a + low)
                     for high, low in [(0x12, 0x14), (0x16, 0x18)]]
            state.extend([word(cpu, a + 0x1C) * 65536 + word(cpu, a + 0x1E),
                          word(cpu, a + 0x3E, signed=True) * 65536 + word(cpu, a + 0x3C),
                          word(cpu, a + 0x40, signed=True), word(cpu, a + 0x1A, signed=True),
                          word(cpu, a + 0x3A) - word(cpu, a + 0x38), word(cpu, a + 0xC),
                          {0x761: "hidden", 0x897: "masked", 0x853: "normal"}[word(cpu, a + 4)]])
            state.extend(word(cpu, a + offset, signed=True) for offset in (0x28, 0x2A, 0x2C, 0x2E))
            actual.append(state)
        assert actual == expected["actors"], (entry, tick, next(
            ((i, a, b) for i, (a, b) in enumerate(zip(actual, expected["actors"])) if a != b), None))
        assert [bool(v) for v in cpu.mem_read(DS + 0x922D, 2)] == expected["presence"]
        assert [word(cpu, 0x91D4 + i * 2) for i in range(8)] == expected["lights"], (entry, tick)
    print(f"PASS miniboss formation entry {entry}: 12 original constructors, fixed-point paths, art and masking")

for case in native["miniDamage"]:
    cpu = mini_machine()
    actor = 0xA000
    for offset, value in [(0, [0x114, 0x118, 0x11C][case["part"]]), (2, 0x866D),
                          (0x12, 160), (0x16, 90), (0x24, 2), (0x22, 0), (0x9202 - actor, 1)]:
        word(cpu, actor + offset, value)
    cpu.reg_write(UC_X86_REG_DI, actor)
    cpu.reg_write(UC_X86_REG_AX, 2)
    call(cpu, [0x80F5, 0x8114, 0x8126][case["part"]])
    assert word(cpu, 0x9202) == case["busy"]
    assert word(cpu, 0x9156) == case["score"]
    assert word(cpu, 0x304A) == case["seed"]
    corpse = 0xB000
    assert word(cpu, corpse + 0x1C) == case["angle"]
    for tick, expected in enumerate(case["states"], 1):
        cpu.reg_write(UC_X86_REG_SI, corpse)
        call(cpu, 0x866D)
        actual = [word(cpu, corpse + 0x12), word(cpu, corpse + 0x16), tick,
                  word(cpu, corpse) == 4, word(cpu, corpse + 0xC)]
        assert actual == expected, (case["part"], tick, actual, expected)
    print(f"PASS miniboss part {case['part']}: fatal callback, busy flag, no score, corpse animation/movement")

cpu = mini_machine()
actor = 0xA000
for offset, value in [(0, 0x54), (0xC, 0x1CD2), (0x24, 12), (0x28, 144), (0x2A, 64)]:
    word(cpu, actor + offset, value)
word(cpu, 0x9200, 1)
cpu.reg_write(UC_X86_REG_DI, actor)
cpu.reg_write(UC_X86_REG_AX, 12)
call(cpu, 0x87D5)
effects = [[word(cpu, 0xB000 + i * 0x4C + 0x12), word(cpu, 0xB000 + i * 0x4C + 0x16), i > 0]
           for i in range(41)]
credits = [[word(cpu, 0xB000 + i * 0x4C + 0x12), word(cpu, 0xB000 + i * 0x4C + 0x16),
            50 if (i - 41) % 2 == 0 else 100] for i in range(41, 51)]
assert {"effects": effects, "credits": credits, "seed": word(cpu, 0x304A),
        "count": word(cpu, 0x9164)} == native["miniBurst"]
assert word(cpu, 0x91A8) == 0 and cpu.mem_read(DS + 0x9230, 1) == b"\xff"
assert bytes(cpu.mem_read(DS + 0x1950, 0x1CC * 2)) == bytes(0x1CC * 2)
print("PASS miniboss death: map clear, 40 large explosions, 10 counted credits, RNG and released camera floor")

for case in native["miniHits"]:
    cpu = mini_machine()
    actor = 0xA000
    word(cpu, 0x9202, case["busy"])
    word(cpu, actor + 0x24, 12)
    word(cpu, actor + 0x1A, case["phase"])
    cpu.reg_write(UC_X86_REG_DI, actor)
    cpu.reg_write(UC_X86_REG_AX, 1)
    call(cpu, 0x87D5)
    assert (word(cpu, actor + 0x24) == 11) == case["accepted"], case
print("PASS miniboss eye damage: 32 animation/busy-state combinations")

# The last counted globe, not a miniboss end-level flag, requests the same-stage shop.
cpu = mini_machine()
actor = 0xA000
for offset, value in [(0, 0x60), (0xC, 0x11F2), (0xE, 1), (0x10, 0x11F6),
                      (0x12, 160), (0x16, 196), (0x1A, 0)]:
    word(cpu, actor + offset, value)
word(cpu, 0x9164, 1)
cpu.mem_write(DS + 0x8FB0, b"\x00")
cpu.mem_write(DS + 0x8F61, b"\x00")
cpu.reg_write(UC_X86_REG_SI, actor)
call(cpu, 0x28DF)
assert word(cpu, 0x9164) == 0 and cpu.mem_read(DS + 0x8FB0, 1) == b"\xff"
shop_branch = []


def mini_shop_hook(uc, address, _size, _data):
    if address in (LOAD * 16 + 0x3FC8, LOAD * 16 + 0x40A7):
        shop_branch.append(address - LOAD * 16)
        uc.reg_write(UC_X86_REG_IP, 0xFF00)


cpu.hook_add(UC_HOOK_CODE, mini_shop_hook)
call(cpu, 0x3FAA)
assert shop_branch == [0x3FC8]
print("PASS miniboss shop: final counted-globe expiry requests shop without an end-level transition")


def boss_two_machine():
    cpu = mini_machine()
    cpu.mem_write(DS, base64.b64decode(native["bossTwoMap"]))

    def sound_interrupt(uc, interrupt, _data):
        assert interrupt == 0x80
        uc.reg_write(UC_X86_REG_AX, uc.reg_read(UC_X86_REG_AX) & 0xFF00)

    cpu.hook_add(UC_HOOK_INTR, sound_interrupt)
    return cpu


def actor_box(cpu, actor):
    left = word(cpu, actor + 0x28, signed=True)
    return [1000] if left == 1000 else [left] + [
        word(cpu, actor + offset, signed=True) for offset in (0x2A, 0x2C, 0x2E)]


def terrain_flags(cpu):
    flags = []
    for i in range(4):
        address = 0x938B + struct.unpack_from("<H", image, 0x9503 + i * 2)[0]
        count = struct.unpack_from("<H", image, address)[0]
        flags.extend(bool(struct.unpack("<H", cpu.mem_read(LOAD * 16 + address + 2 + j * 8, 2))[0])
                     for j in range(count))
    return flags


for case in native["bossTwoTraces"]:
    cpu = boss_two_machine()
    actor = 0xA000
    for offset, value in [(0, 0x50), (0x16, 96), (0x1A, -1), (0x24, 75)]:
        word(cpu, actor + offset, value)
    for tick, expected in enumerate(case["states"], 1):
        cpu.mem_write(DS + 0xB000, bytes(32 * 0x4C))
        for i in range(32):
            word(cpu, 0xB000 + i * 0x4C + 8, 0xB000 + (i + 1) * 0x4C)
        word(cpu, 0x8E7C, 0xB000)
        for head in (0x904A, 0x9096):
            word(cpu, head + 8, head)
            word(cpu, head + 10, head)
        for offset, value in [(0x9190, expected["camera"]), (0x91AA, expected["camera"] + 16),
                              (0x919C, tick), (0x9F12, 160), (0x9F16, case["playerY"]),
                              (0x8F32, case["population"])]:
            word(cpu, offset, value)
        cpu.reg_write(UC_X86_REG_SI, actor)
        call(cpu, 0x89AE)
        core = [word(cpu, actor + offset, signed=offset in (0x1A, 0x1C)) for offset in
                (0x16, 0x1A, 0x1C, 0x20, 0x30, 0x22, 0x48)]
        assert core == expected["core"], (case["population"], case["playerY"], tick, core, expected["core"])
        assert actor_box(cpu, actor) == expected["box"], (tick, actor_box(cpu, actor), expected["box"])
        assert word(cpu, 0x91AA) == expected["ceiling"]
        tiles = list(struct.unpack("<54H", cpu.mem_read(LOAD * 16 + 0x92E7, 108)))
        assert tiles == expected["tiles"], (tick, "boss tiles")
        bullets, eggs = [], []
        for i in range((word(cpu, 0x8E7C) - 0xB000) // 0x4C):
            a = 0xB000 + i * 0x4C
            if word(cpu, a) == 0x14:
                bullets.append([word(cpu, a + offset, signed=offset in (0x12, 0x16))
                                for offset in (0x12, 0x16, 0x1C, 0x42, 0xC, 0xE)])
            elif word(cpu, a) == 0x10C:
                eggs.append([word(cpu, a + offset, signed=offset == 0x16)
                             for offset in (0x12, 0x16, 0x1A, 0x1C, 0xC, 0xE)])
        assert bullets == expected["bullets"], (tick, bullets, expected["bullets"])
        assert eggs == expected["eggs"], (tick, eggs, expected["eggs"])
        assert word(cpu, 0x304A) == expected["seed"], (tick, "boss RNG")
    print(f"PASS stage-two boss, population={case['population']}, player Y={case['playerY']}: "
          "1800 original movement, weak-point, tile, volley, spawn and RNG ticks")

for case in native["bossEggs"]:
    cpu = boss_two_machine()
    actor = 0xA000
    for offset, value in [(0, 0x10C), (0x12, 160), (0x16, 224 - case["camera"]),
                          (0xC, 0x376B), (0xE, 2), (0x10, 0x78E2), (0x1C, case["direction"])]:
        word(cpu, actor + offset, value)
    for tick, expected in enumerate(case["states"], 1):
        word(cpu, 0x9190, case["camera"])
        word(cpu, 0x9198, expected["delta"])
        cpu.reg_write(UC_X86_REG_SI, actor)
        call(cpu, 0x83BD)
        state = [word(cpu, actor + offset, signed=offset == 0x16) for offset in
                 (0x12, 0x16, 0x1A, 0x1C, 0xC, 0xE)] + [word(cpu, actor) == 4]
        assert state == expected["state"], (case["direction"], tick, state, expected["state"])
        crawler = None
        if word(cpu, actor) == 4:
            a = 0xB000
            crawler = [word(cpu, a + offset, signed=offset == 0x16) for offset in
                       (0x12, 0x16, 0x1C, 0x24, 0xC, 0xE)] + actor_box(cpu, a)
        assert crawler == expected["crawler"], (tick, crawler, expected["crawler"])
        assert word(cpu, 0x304A) == expected["seed"]
    print(f"PASS boss egg {case['direction']}/{case['camera']}: drift, clamps, hatch timing and crawler constructor")

for case in native["bossCrawlers"]:
    cpu = boss_two_machine()
    actor = 0xA000
    animation = struct.unpack_from("<H", image, 0x950B + case["direction"] * 2)[0]
    for offset, value in [(0, 0x110), (0x12, 116), (0x16, 8), (0x1C, case["direction"]),
                          (0x1A, (case["direction"] + 4) & 7 if case["turning"] else -1),
                          (0xC, struct.unpack_from("<H", image, animation)[0]),
                          (0xE, 2), (0x10, animation + 4), (0x24, 2)]:
        word(cpu, actor + offset, value)
    for expected in case["states"]:
        word(cpu, 0x9190, 100)
        word(cpu, 0x9198, 0)
        word(cpu, 0x919C, expected["tick"])
        word(cpu, 0x9F12, 160)
        word(cpu, 0x9F16, 170)
        word(cpu, 0x8E7C, 0xB000)
        word(cpu, 0xB008, 0xB04C)
        for head in (0x904A, 0x9096):
            word(cpu, head + 8, head)
            word(cpu, head + 10, head)
        before = terrain_flags(cpu)
        cpu.reg_write(UC_X86_REG_SI, actor)
        call(cpu, 0x84E1)
        state = [word(cpu, actor + offset, signed=offset in (0x12, 0x16, 0x1A)) for offset in
                 (0x12, 0x16, 0x1A, 0x1C, 0xC, 0xE, 0x48)] + actor_box(cpu, actor)
        assert state == expected["state"], (case["direction"], case["turning"], expected["tick"],
                                             state, expected["state"])
        assert word(cpu, 0x304A) == expected["seed"]
        after = terrain_flags(cpu)
        assert after == expected["flags"]
        patches = []
        flat = 0
        for i in range(4):
            address = 0x938B + struct.unpack_from("<H", image, 0x9503 + i * 2)[0]
            count = struct.unpack_from("<H", image, address)[0]
            for j in range(count):
                if after[flat] and not before[flat]:
                    _, x, y, tile = struct.unpack("<4H", cpu.mem_read(LOAD * 16 + address + 2 + j * 8, 8))
                    cell = y // 16 * 20 + x // 16
                    assert word(cpu, cell * 2) == tile
                    patches.append([cell, tile])
                flat += 1
        assert patches == expected["patches"]
        bullets = []
        if word(cpu, 0x8E7C) != 0xB000:
            bullets = [[word(cpu, 0xB000 + offset, signed=offset in (0x12, 0x16))
                        for offset in (0x12, 0x16, 0x1C, 0x42, 0xC)]]
        assert bullets == expected["bullets"]
    print(f"PASS crawler {case['direction']}, turning={case['turning']}: "
          "500 original animation, route, repair, aiming, firing and RNG ticks")

for case in native["bossTerrain"]:
    cpu = boss_two_machine()
    for address in (0x938B, 0x93ED, 0x944F, 0x94A1):
        count = struct.unpack_from("<H", image, address)[0]
        for i in range(count):
            cpu.mem_write(LOAD * 16 + address + 2 + i * 8, b"\x01\x00")
    box = case["box"]
    for offset, value in [(0xFCE2, box["x"]), (0xFCE6, box["y"]),
                          (0xFCEA, box["x"]), (0xFCEE, box["y"]), (0x9190, 0)]:
        word(cpu, offset, value)
    call(cpu, 0x8CA7)
    hit = cpu.reg_read(UC_X86_REG_AX) != 0
    assert hit == bool(case["hit"]), case
    if hit:
        call(cpu, 0x8D18)
        expected = case["hit"]
        assert word(cpu, expected["cell"] * 2) == expected["tile"]
        actual = [[word(cpu, 0xB012), word(cpu, 0xB016)]]
        assert actual == expected["effects"], (case, actual)
print("PASS boss arena walls: 132 original point/boundary collision and destruction cases")

for expected in native["bossTwoDeaths"]:
    cpu = boss_two_machine()
    actor = 0xA000
    for offset, value in [(0, 0x50), (0x16, 96), (0x24, 75)]:
        word(cpu, actor + offset, value)
    word(cpu, 0x9190, expected["camera"])
    cpu.reg_write(UC_X86_REG_DI, actor)
    cpu.reg_write(UC_X86_REG_AX, 75)
    call(cpu, 0x8745)
    credits = [[word(cpu, 0xB000 + i * 0x4C + 0x12), word(cpu, 0xB000 + i * 0x4C + 0x16),
                50 if i % 2 == 0 else 100] for i in range(20)]
    effects = [[word(cpu, 0xB000 + i * 0x4C + 0x12), word(cpu, 0xB000 + i * 0x4C + 0x16)]
               for i in range(20, 50)]
    assert credits == expected["credits"] and effects == expected["effects"]
    order = []
    current = word(cpu, 0x90A0)
    while current != 0x9096:
        assert len(order) < 50
        order.append([(current - 0xB000) // 0x4C, word(cpu, current)])
        current = word(cpu, current + 0xA)
    assert order == expected["order"]
    assert word(cpu, 0x304A) == expected["seed"] and word(cpu, 0x9164) == expected["count"]
    assert cpu.mem_read(DS + 0x8F61, 1) == b"\xff"
print("PASS corrected stage-two boss death: 20 counted credits, 30 boss-position explosions and end-level flag")


def foreground_machine(stage):
    cpu = machine()
    cpu.mem_write((0x349B + LOAD) * 16, base64.b64decode(native["sharedSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / f"S{stage}/SPRITES.VGA").read_bytes())
    word(cpu, 0x8E7C, 0xB000)
    for i in range(100):
        word(cpu, 0xB000 + i * 0x4C + 8, 0xB000 + (i + 1) * 0x4C)
    word(cpu, 0x909E, 0x9096)
    word(cpu, 0x90A0, 0x9096)
    call(cpu, [0x764F, 0x8F88, 0xACE2, 0xC823, 0xE50B][stage - 1])
    return cpu


def fixed_position(cpu, actor):
    return [word(cpu, actor + offset, signed=True) * 65536 + word(cpu, actor + offset + 2)
            for offset in (0x12, 0x16)]


def worm_machine():
    cpu = foreground_machine(1)
    # Replace the synthetic foreground free chain, which overlaps the real record bank.
    cpu.mem_write(DS + 0x9F4C, bytes(159 * 0x4C))
    word(cpu, 0x8E7C, 0x9F4C)
    for i in range(159):
        word(cpu, 0x9F4C + i * 0x4C + 8, 0x9F4C + (i + 1) * 0x4C if i < 158 else 0)
    paths = (ROOT / "S1/PATHS.BIN").read_bytes()
    cpu.mem_write(DS + 0xDE30, paths)
    for i, offset in enumerate(struct.unpack_from("<115H", paths)):
        word(cpu, 0xDE30 + i * 2, offset + 0xDF16)
    compressed = (ROOT / "S1/MAP.CMP").read_bytes()
    source, tiles = 0, bytearray()
    while len(tiles) < 12000:
        literals = compressed[source] * 2
        tiles.extend(compressed[source + 1:source + 1 + literals])
        source += 1 + literals
        tiles.extend(bytes(compressed[source] * 2))
        source += 1
    cpu.mem_write(DS, bytes(tiles))
    for sentinel in (0x904A, 0x9096, 0x90E2):
        cpu.reg_write(UC_X86_REG_SI, sentinel)
        call(cpu, 0x762)
    call(cpu, 0x7619)
    cpu.mem_write(DS + 0x922C, b"\xff")
    word(cpu, 0x919A, 1)
    return cpu


def listed_actors(cpu, sentinel):
    actor = word(cpu, sentinel + 0xA)
    for _ in range(100):
        if actor == sentinel:
            return
        yield actor
        actor = word(cpu, actor + 0xA)
    raise AssertionError("Original actor list did not terminate")


def draw_list_trace(cpu):
    seen = []

    def trace(uc, _address, _size, _data):
        actor = uc.reg_read(UC_X86_REG_SI)
        if word(uc, actor + 4) != 0x761:
            seen.append(actor)
        # Keep the original walker and list links; skip hardware-specific VGA painting.
        uc.reg_write(UC_X86_REG_IP, 0x3716)

    cpu.hook_add(UC_HOOK_CODE, trace, begin=LOAD * 16 + 0x3713, end=LOAD * 16 + 0x3713)

    def read(sentinel):
        seen.clear()
        cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
        call(cpu, 0x370B)
        return seen.copy()

    return read


cpu = startup_pool(1, True)
draw_list = draw_list_trace(cpu)
first_jet = word(cpu, 0x9F0A)
seen = set()
for tick, state in enumerate(native["maneuverJets"], 1):
    word(cpu, 0x919E, state["bank"])
    word(cpu, 0x8E80, state["dive"])
    word(cpu, 0x9F12, state["player"][0])
    word(cpu, 0x9F16, state["player"][1])
    cpu.mem_write(DS + 0x8F59, bytes([state["input"]]))
    if tick == 45:
        cpu.mem_write(DS + 0x9224, b"\xff")
    cpu.reg_write(UC_X86_REG_SI, first_jet)
    call(cpu, 0x36FC)
    painted = [[word(cpu, a + offset) for offset in (0xC, 0x12, 0x16)]
               for a in draw_list(0x8FB2) if word(cpu, a) == 0xC4]
    assert painted == state["painted"], (tick, painted, state)
    seen.update(item[0] for item in painted)
assert len(seen) == 8
assert {len(state["painted"]) for state in native["maneuverJets"]} == {0, 2, 4}
print("PASS maneuver jets: 48 DOS HUD ticks of input, banking, hidden animation, dive and death")


for case in native["stageTwoCameraEvents"]:
    cpu = startup_pool(case["players"], True)
    cpu.mem_write((0x349B + LOAD) * 16, base64.b64decode(native["sharedSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
    call(cpu, 0x8F68)
    for offset, value in [(0x9190, 1000), (0x9192, 1001), (0x9194, 1001), (0x9198, 0), (0x91AA, 1016),
                          (0x9F12, 300), (0x9F16, 24), (0x304A, 0x5845), (0x91AC, 1)]:
        word(cpu, offset, value)
    word(cpu, 0xDE30, 0xF100)
    cpu.mem_write(DS + 0xF100, struct.pack("<9h", *case["path"]))
    for field, base in (("events", 0xD274), ("background", 0xDA9E)):
        cpu.mem_write(DS + base, b"".join(struct.pack("<7H", *event) for event in case[field]) + b"\xff\xff")
    for cell, tile in zip(case["cells"], case["initialTiles"], strict=True):
        word(cpu, cell * 2, tile)
    draw = draw_list_trace(cpu)
    tiles = lambda: [word(cpu, cell * 2) for cell in case["cells"]]
    read = lambda sentinel: [[a, word(cpu, a)] for a in listed_actors(cpu, sentinel)]
    for tick, expected in enumerate(case["states"], 1):
        cpu.emu_start(LOAD * 16 + 0x3D26, LOAD * 16 + 0x3D47)
        for sentinel in (0x904A, 0x9096, 0x90E2):
            cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
            call(cpu, 0x36FC)
        painted = [a for a in draw(0x904A) if word(cpu, a) not in (0x50, 0x54)]
        paint_tiles = tiles()
        call(cpu, 0x36D3)
        call(cpu, 0x3615)
        main, scenery = read(0x904A), read(0x90E2)
        motion = [[word(cpu, a + offset, signed=True) for offset in (0x12, 0x16)]
                  for a, kind in main if kind not in (0x50, 0x54, 0xE8, 0xEC)]
        gun = next(a for a, kind in main if kind in (0xE8, 0xEC))
        gun_bounds = [word(cpu, gun + offset, signed=True) for offset in (0x28, 0x2A, 0x2C, 0x2E)]
        actual = {"painted": painted, "paintTiles": paint_tiles, "tiles": tiles(),
                  "main": main, "scenery": scenery, "motion": motion if tick > 1 else None,
                  "gun": gun_bounds if gun_bounds[0] != 1000 else None,
                  "hatch": word(cpu, scenery[0][0] + 0x1A),
                  "seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C)}
        assert actual == expected, ("stage-two camera events", case["players"], tick, actual, expected)
print("PASS stage-two camera events: both pool layouts, mixed births, delayed sprite/map paint and first callbacks")


for case in native["stageTwoPoolScenes"]:
    cpu = startup_pool(case["players"], True)
    cpu.mem_write(DS, bytes(12000))
    cpu.mem_write((0x349B + LOAD) * 16, base64.b64decode(native["sharedSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
    skip_calls(cpu, {0xEB3})
    for address in listed_actors(cpu, 0x904A):
        word(cpu, address + 2, 0x761)
    for offset, value in [(0x9190, 1000), (0x91AA, 1016), (0x9198, 0),
                          (0x9F12, 300), (0x9F16, 100), (0x304A, 0x5845)]:
        word(cpu, offset, value)
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x3589)
    for event in case["background"]:
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_DI, 0xF000)
        call(cpu, {1: 0x7F82, 3: 0x8018, 5: 0x80BB}[event[1]])
    for tick, expected in enumerate(case["states"], 1):
        word(cpu, 0x919C, tick)
        lists = []
        for sentinel in (0x904A, 0x9096, 0x90E2):
            cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
            call(cpu, 0x36FC)
        if tick == 1 and case["clear"]:
            call(cpu, 0x2AD0)
        for sentinel in (0x904A, 0x9096, 0x90E2):
            records = []
            for actor in listed_actors(cpu, sentinel):
                kind = word(cpu, actor)
                offsets = {0x0C: (0x12, 0x16, 0xC), 0x14: (0x12, 0x16)}.get(kind, ())
                records.append([actor, kind] + [word(cpu, actor + offset, signed=offset != 0xC)
                                                 for offset in offsets])
            lists.append(records)
        actual = {"lists": lists, "seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C),
                  "score": word(cpu, 0x9152)}
        assert actual == expected, (case["players"], case["clear"], tick, actual, expected)
print("PASS stage-two mixed actor lists: gun/round allocation, patrol migration, Z, effects and hatchling reuse")

for case in native["linkedPlayerShots"]:
    stage, camera = case["stage"], case["camera"]
    cpu = startup_pool(1, stage == 2)
    cpu.mem_write(DS, bytes(12000))
    cpu.mem_write((0x349B + LOAD) * 16,
                  base64.b64decode(native["sharedSprites"]) + base64.b64decode(native["weaponSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / f"S{stage}/SPRITES.VGA").read_bytes())
    skip_calls(cpu, {0xEB3})
    cannons = case["id"] == 15
    lasers = case["id"] == 18
    bomb = case["id"] == 21
    flamer = case["id"] == 20
    seeker = case["id"] == 23
    mount_type = {15: 0x34, 18: 0x20, 20: 0xB0, 21: 0x9C, 23: 0xA0}.get(case["id"])
    player_types = (0x10, 0x24, 0x28, 0x30, 0x48, 0xB4)
    for offset, value in [(0x9190, camera), (0x91AA, camera + 16), (0x9198, 0), (0x9F12, 186 if cannons or lasers else 160),
                          (0x9F16, 174), (0x304A, 0x5845), (0x9188, 999),
                          (0xF30C, 0x96C0), (0xF310, 0x156A), (0xF330, -26), (0xF332, 16)]:
        word(cpu, offset, value)
    if stage == 4:
        word(cpu, 0x991A, 1)
        word(cpu, 0x991C, 4)
        call(cpu, 0xC79F)
    if cannons:
        for _ in range(4):
            call(cpu, 0x3246)
    if lasers:
        for _ in range(2):
            call(cpu, word(cpu, 0x381A + 18 * 2))
            word(cpu, word(cpu, 0x9008) + 0x34, case["power"])
    if bomb:
        call(cpu, 0x2D2A)
    if seeker:
        call(cpu, 0x2D86)
    if case.get("capacity"):
        assert case["capacity"] == 1
        assert word(cpu, 0x8E7C) == case["freeHead"], (stage, case["id"], word(cpu, 0x8E7C), case["freeHead"])
        word(cpu, case["freeHead"] + 8, 0)
    if flamer:
        call(cpu, 0x2DF0)
        word(cpu, word(cpu, 0x9136) + 0x34, case["power"])

        def flamer_sound(uc, interrupt, _):
            assert interrupt == 0x80 and uc.reg_read(UC_X86_REG_AX) >> 8 == 0x11
            uc.reg_write(UC_X86_REG_AX, 0x1101)

        cpu.hook_add(UC_HOOK_INTR, flamer_sound)
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x3589)
    for event in case["background"]:
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_DI, 0xF000)
        call(cpu, 0x7F82 if stage == 2 else 0xC5C3)
    seen, round_frames, beam_lengths = set(), set(), set()
    saw_death_flush = False
    for tick, expected in enumerate(case["states"], 1):
        word(cpu, 0x919C, tick)
        word(cpu, 0x9F12, expected["x"])
        word(cpu, 0x9F16, expected["y"])
        if seeker:
            call(cpu, 0x373D)
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
        call(cpu, 0x36FC)
        cpu.mem_write(DS + 0x8FAE, bytes([255 if expected["fire"] else 0]))
        cpu.mem_write(DS + 0x8F59, bytes([128 if expected["fire"] else 0]))
        if flamer:
            cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9008))
            call(cpu, 0x36FC)
        elif mount_type:
            for mount in listed_actors(cpu, 0x8FFE):
                if word(cpu, mount) == mount_type:
                    cpu.reg_write(UC_X86_REG_SI, mount)
                    call(cpu, word(cpu, mount + 2))
        else:
            cpu.reg_write(UC_X86_REG_SI, 0xF300)
            call(cpu, 0x250B)
        if expected["fire"] and not mount_type:
            for mount, power in [({1: 0x37DF, 14: 0x20F7}[case["id"]], 1), (0x3835, 0), (0x3801, 2)]:
                word(cpu, 0xF234, power)
                cpu.reg_write(UC_X86_REG_SI, 0xF200)
                call(cpu, mount)
        if tick == 97:
            cpu.mem_write(DS + 0x9224, b"\xff")
        player_rounds = {a: word(cpu, a) for a in listed_actors(cpu, 0x9096) if word(cpu, a) in player_types}
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x90A0))
        call(cpu, 0x36FC)
        if tick == 97:
            saw_death_flush = any(word(cpu, actor) == 4 for actor in player_rounds)
        lists = []
        for sentinel in (0x904A, 0x9096):
            records = []
            for actor in listed_actors(cpu, sentinel):
                kind = word(cpu, actor)
                seen.add(kind)
                record = [actor, kind]
                if kind in (*player_types, 0xC, 0x14) or kind == 4 and actor in player_rounds:
                    record.extend(word(cpu, actor + offset, signed=True) for offset in (0x12, 0x16))
                replaced_seeker = (case.get("capacity") and kind == 4 and player_rounds.get(actor) == 0x48
                                   and word(cpu, actor + 0xC) == struct.unpack_from("<H", image, 0x1230)[0])
                if replaced_seeker:
                    record.append(word(cpu, actor + 0xC))
                elif kind == 0x10:
                    record.extend(word(cpu, actor + offset) for offset in (0xC, 0x34))
                    round_frames.add(record[-2])
                elif kind == 0x24:
                    record.extend(word(cpu, actor + offset) for offset in (0x1A, 0x34))
                    beam_lengths.add(record[-2])
                elif kind == 0x28:
                    record.extend([word(cpu, actor + 0xC), word(cpu, actor + 0x1A, signed=True)])
                elif kind == 0xC and (bomb or seeker):
                    record.append(word(cpu, actor + 0xC))
                elif kind == 0x30:
                    record.extend([word(cpu, actor + 0xC),
                                   *struct.unpack("<4h", cpu.mem_read(DS + actor + 0x28, 8))])
                elif player_rounds.get(actor) == 0xB4:
                    record.append(word(cpu, actor + 0x14))
                    if kind == 0xB4:
                        damaging = word(cpu, actor + 0x22)
                        record.extend([word(cpu, actor + 0xC), word(cpu, actor + 0x1C, signed=True), damaging])
                        if damaging:
                            record.extend(actor_box(cpu, actor))
                elif player_rounds.get(actor) == 0x48:
                    record.extend([word(cpu, actor + 0x1A, signed=True), word(cpu, actor + 0x1C),
                                   word(cpu, actor + 0xC), word(cpu, actor + 0x22)])
                elif kind in (0xE8, 0xEC, 0xD4, 0xD0):
                    record.append(word(cpu, actor + 0x24))
                records.append(record)
            lists.append(records)
        actual = {**{k: expected[k] for k in ("fire", "x", "y")},
                  "lists": lists, "seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C), "score": word(cpu, 0x9152)}
        assert actual == expected, (stage, case["id"], case.get("capacity"), tick,
                                    {k: (v, expected[k]) for k, v in actual.items() if v != expected[k]})
    if cannons:
        assert {0xC, 0x30, 0x40}.issubset(seen) and word(cpu, 0x9152) > 0
    elif lasers:
        assert {0xC, 0x24}.issubset(seen) and beam_lengths == {0, 32, 64, 65}
        assert word(cpu, 0x9152) >= 200
    elif bomb:
        assert {0xC, 0x28}.issubset(seen) and word(cpu, 0x9152) == 200 and saw_death_flush
    elif flamer:
        assert {0xC, 0xB4}.issubset(seen) and word(cpu, 0x9152) == 200 and saw_death_flush
    elif seeker:
        assert 0x48 in seen and saw_death_flush
        if case["power"]:
            actors = listed_actors(cpu, 0x904A)
            kinds, health = ((0xE8, 0xEC), 4) if stage == 2 else ((0xD4, 0xD0), 16)
            assert any(word(cpu, a) in kinds and word(cpu, a + 0x24) < health for a in actors)
        elif case.get("capacity"):
            assert 4 in seen and 0xC not in seen
        else:
            assert 0xC in seen and word(cpu, 0x9152) == 0
    else:
        assert {0xC, 0x10, 0x14}.issubset(seen) and word(cpu, 0x9152) == 200
        assert {0x7A26, 0x7A86}.issubset(round_frames)
print("PASS stage-two player-round slots and stage-four Homing Missiles: 1470 DOS ticks of launch, locks, hits and bursts")

for case in native["linkedMines"]:
    stage, camera = case["stage"], case["background"][0][0]
    cpu = startup_pool(1, stage == 2)
    cpu.mem_write(DS, bytes(12000))
    cpu.mem_write((0x349B + LOAD) * 16,
                  base64.b64decode(native["sharedSprites"]) + base64.b64decode(native["weaponSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / f"S{stage}/SPRITES.VGA").read_bytes())
    skip_calls(cpu, {0xEB3})
    for offset, value in [(0x9190, camera), (0x91AA, camera + 16), (0x9198, 0), (0x9188, 999),
                          (0x304A, 0x5845), (0x9F12, 160), (0x9F16, 96)]:
        word(cpu, offset, value)
    if stage == 4:
        word(cpu, 0x991A, 1)
        word(cpu, 0x991C, 4)
        call(cpu, 0xC79F)
    call(cpu, 0x2F7C if case["id"] == 9 else 0x3004)
    mount = word(cpu, 0x914A)
    kind = word(cpu, mount)
    assert kind == (0x38 if case["id"] == 9 else 0x3C)
    for event in case["background"]:
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_DI, 0xF000)
        call(cpu, 0x7F82 if stage == 2 else 0xC5C3)
    for tick, state in enumerate(case["states"], 1):
        for offset, value in [(0x919C, tick), (0x9F12, state["x"]), (0x9F16, state["y"])]:
            word(cpu, offset, value)
        cpu.mem_write(DS + 0x8F59, bytes([state["input"]]))
        if tick == 178:
            cpu.mem_write(DS + 0x9224, b"\xff")
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
        call(cpu, 0x36FC)
        cpu.reg_write(UC_X86_REG_SI, mount)
        call(cpu, 0x2697)
        charges = {a for a in listed_actors(cpu, 0x9096) if word(cpu, a) == kind}
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x90A0))
        call(cpu, 0x36FC)
        main, transient = [], []
        for actor in listed_actors(cpu, 0x904A):
            entry = [actor, word(cpu, actor)]
            if entry[1] in (0xEC, 0xD4):
                entry.append(word(cpu, actor + 0x24))
            main.append(entry)
        for actor in listed_actors(cpu, 0x9096):
            entry = [actor, word(cpu, actor)]
            if actor in charges or entry[1] == 0x0C or stage == 4 and entry[1] == 0x14:
                entry.extend(word(cpu, actor + offset, signed=True) for offset in (0x12, 0x16))
                if actor in charges:
                    entry.append(word(cpu, actor + 0x1A, signed=True))
                entry.append(word(cpu, actor + 0xC))
            transient.append(entry)
        actual = {"main": main, "transient": transient, "count": word(cpu, 0x8E86),
                  "pose": [word(cpu, mount + offset) for offset in (0x12, 0x16, 0x1A, 0xC)],
                  "seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C), "score": word(cpu, 0x9152)}
        for key, value in actual.items():
            assert value == state[key], (stage, case["id"], tick, key, value, state[key])
    assert max(state["count"] for state in case["states"]) == 10
    assert (word(cpu, 0x9152) == 200 or stage == 4) and word(cpu, 0x8E86) > 0
    cpu.hook_add(UC_HOOK_INTR, lambda _cpu, _interrupt, _data: None)
    call(cpu, 0x18F5)
    assert word(cpu, 0x8E86) == case["checkpointCount"]
print("PASS stage-two and stage-four Mine slots: 716 DOS ticks of mount motion, ten-charge cap, two powers, death and reuse")

for case in native["stageTwoDrone"]:
    cpu = startup_pool(1, True)
    cpu.mem_write(DS, bytes(12000))
    cpu.mem_write((0x349B + LOAD) * 16, base64.b64decode(native["sharedSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
    skip_calls(cpu, {0xEB3})
    for offset, value in [(0x3044, 0), (0x9190, 1000), (0x91AA, 1016),
                          (0x9198, 0), (0x304A, 0x5845), (0x9188, 999)]:
        word(cpu, offset, value)
    call(cpu, word(cpu, 0x381A + 19 * 2))
    mount = word(cpu, 0x914A)
    assert word(cpu, mount) == 0x2C
    word(cpu, mount + 0x34, case["power"])
    for cell, tile in zip(case["cells"], case["initialTiles"], strict=True):
        word(cpu, cell * 2, tile)
    tiles = lambda: [word(cpu, cell * 2) for cell in case["cells"]]
    draw = draw_list_trace(cpu)
    flashes = []

    def flash_tile(uc, _address, _size, _data):
        x, y, width, tileset = (uc.reg_read(reg) for reg in
                                (UC_X86_REG_CX, UC_X86_REG_DX, UC_X86_REG_AX, UC_X86_REG_SI))
        flashes.append([x * 2 & ~7, y, width,
                        list(struct.unpack(f"<{width}H", uc.mem_read(LOAD * 16 + tileset, width * 2)))])
        sp = uc.reg_read(UC_X86_REG_SP)
        uc.reg_write(UC_X86_REG_SP, sp + 2)
        uc.reg_write(UC_X86_REG_IP, struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0])

    cpu.hook_add(UC_HOOK_CODE, flash_tile, begin=LOAD * 16 + 0x963, end=LOAD * 16 + 0x963)
    for event in case["background"]:
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_DI, 0xF000)
        call(cpu, 0x7F82)
    guns = set(a for a in listed_actors(cpu, 0x904A) if word(cpu, a) == 0xEC)
    if case["toughHealth"]:
        word(cpu, word(cpu, 0x9054) + 0x24, case["toughHealth"])
    for slot, coord in enumerate(case["initial"]):
        if slot != 1:
            cpu.mem_write(DS + 0x9C80 + slot * 8, struct.pack("<4h", *coord))
    for tick, expected in enumerate(case["states"], 1):
        if tick == 7:
            for slot in range(len(case["initial"])):
                if slot != 1:
                    word(cpu, 0x9C80 + slot * 8, 0xFFFF)
        for offset, value in [(0x919C, tick), (0x9F12, expected["x"]), (0x9F16, expected["y"]),
                              (0x8EBC, expected["anchor"]["x"]), (0x8EBE, expected["anchor"]["y"])]:
            word(cpu, offset, value)
        if tick == 63:
            cpu.mem_write(DS + 0x9224, b"\xff")
        for sentinel in (0x904A, 0x9096, 0x90E2):
            if sentinel == 0x9096:
                cpu.mem_write(DS + 0x8F59, bytes([128 if expected["fire"] else 0]))
                cpu.reg_write(UC_X86_REG_SI, mount)
                call(cpu, 0x221A)
            cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
            call(cpu, 0x36FC)
        paint_tiles = tiles()
        blasts = [[a, word(cpu, a + 0xC)] for a in draw(0x9096) if word(cpu, a) == 0x0C]
        flashes.clear()
        for actor in draw(0x904A):
            if actor in guns and word(cpu, actor + 4) == 0x3BDF:
                cpu.reg_write(UC_X86_REG_SI, actor)
                call(cpu, 0x3BDF)
        call(cpu, 0xA95)
        table = [list(entry) if entry[0] >= 0 else None for entry in
                 struct.iter_unpack("<4h", cpu.mem_read(DS + 0x9C80, 80 * 8))]
        actual = {"table": table,
                  "guns": [[a, word(cpu, a), word(cpu, a + 0x24) if word(cpu, a) != 4 else 0]
                           for a in listed_actors(cpu, 0x904A) if a in guns],
                  "paintTiles": paint_tiles, "tiles": tiles(), "blasts": blasts, "flashes": flashes,
                  "seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C), "score": word(cpu, 0x9152)}
        for key, value in actual.items():
            assert value == expected[key], (case["power"], tick, key, value, expected[key])
    assert any(state["score"] for state in case["states"])
assert any(state["flashes"] for case in native["stageTwoDrone"] for state in case["states"])
print("PASS Drone table: 192 DOS VGA ticks across three powers, sparse insertion, saturation, point damage and death")
print("PASS stage-two Drone paint: gun tiles survive the impact frame; flashes and blasts draw on the next visit")

for case in native["linkedElectro"]:
    stage, camera = case["stage"], case["camera"]
    cpu = startup_pool(1, stage == 2)
    cpu.mem_write(DS, bytes(12000))
    cpu.mem_write((0x349B + LOAD) * 16,
                  base64.b64decode(native["sharedSprites"]) + base64.b64decode(native["weaponSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / f"S{stage}/SPRITES.VGA").read_bytes())
    skip_calls(cpu, {0xEB3})
    for offset, value in [(0x9190, camera), (0x91AA, camera + 16), (0x9198, 0), (0x9188, 999),
                          (0x304A, 0x5845), (0x9F12, 160), (0x9F16, 90)]:
        word(cpu, offset, value)
    if stage == 4:
        word(cpu, 0x991A, 1)
        word(cpu, 0x991C, 4)
        call(cpu, 0xC79F)
    call(cpu, 0x2F08)
    mount = word(cpu, 0x914A)
    for event in case["background"]:
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_DI, 0xF000)
        call(cpu, 0x7F82 if stage == 2 else 0xC5C3)
    for tick, state in enumerate(case["states"], 1):
        word(cpu, 0x919C, tick)
        for (x, y), (px, py) in [(state["before"], (0x8F34, 0x8F36)),
                                 (state["player"], (0x9F12, 0x9F16)),
                                 ((state["trail"]["x"], state["trail"]["y"]), (0x8EBC, 0x8EBE))]:
            word(cpu, px, x)
            word(cpu, py, y)
        cpu.mem_write(DS + 0x8F59, bytes([128 if state["fire"] else 0]))
        cpu.mem_write(DS + 0x8FAE, bytes([255 if state["pulse"] else 0]))
        for sentinel in (0x904A, 0x8FFE, 0x9096):
            cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
            call(cpu, 0x36FC)
        lists = []
        for sentinel in (0x904A, 0x9096):
            entries = []
            for actor in listed_actors(cpu, sentinel):
                kind = word(cpu, actor)
                entry = [actor, kind]
                if kind in (0xEC, 0xD4):
                    entry.append(word(cpu, actor + 0x24))
                if kind in (0xC, 0x10, 0x14):
                    entry.extend(word(cpu, actor + off, signed=True) for off in (0x12, 0x16))
                if kind == 0xC:
                    entry.append(word(cpu, actor + 0xC))
                entries.append(entry)
            lists.append(entries)
        pose = [word(cpu, mount + offset) for offset in (0x12, 0x16, 0x1A, 0xC)]
        actual = {"pose": pose, "box": actor_box(cpu, mount) if pose[2] == 1 else None,
                  "lists": lists, "seed": word(cpu, 0x304A),
                  "free": word(cpu, 0x8E7C), "score": word(cpu, 0x9152)}
        for key, value in actual.items():
            assert value == state[key], ("Electro Ball", stage, tick, key, value, state[key])
    if stage == 2:
        assert case["states"][0]["score"] == 100 and word(cpu, 0x9152) == 200
    assert {state["pose"][2] for state in case["states"]} == {0, 1, 65535}
print("PASS stage-two and stage-four Electro Ball: 84 DOS ticks of pose, overlapping hits and starter allocation")

for stage, states in zip((2, 4), native["stageTwoNashwan"], strict=True):
    cpu = startup_pool(1, stage == 2)
    if stage == 4:
        word(cpu, 0x8E70, 1)
        word(cpu, 0x991C, stage)
        word(cpu, 0x991A, 1)
        call(cpu, 0x1B43)
    cpu.mem_write(DS, bytes(12000))
    cpu.mem_write((0x349B + LOAD) * 16,
                  base64.b64decode(native["sharedSprites"]) + base64.b64decode(native["weaponSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / f"S{stage}/SPRITES.VGA").read_bytes())
    skip_calls(cpu, {0xEB3})
    for offset, value in [(0x3044, 0), (0x9190, 1000), (0x91AA, 1016), (0x9198, 0),
                          (0x9188, 999), (0x9162, 38), (0x9F12, 160), (0x9F16, 144)]:
        word(cpu, offset, value)
    call(cpu, 0x2B22)
    seen = set()
    draw_list = draw_list_trace(cpu)
    meter = sprite_draw_trace(cpu)
    for tick, state in enumerate(states, 1):
        for offset, value in [(0x919C, tick), (0x9F12, state["player"][0]), (0x9F16, state["player"][1]),
                              (0x8EBC, state["trail"]["x"]), (0x8EBE, state["trail"]["y"])]:
            word(cpu, offset, value)
        cpu.mem_write(DS + 0x8F59, bytes([128 if state["fire"] else 0]))
        cpu.mem_write(DS + 0x8FAE, bytes([255 if state["pulse"] else 0]))
        for sentinel in (0x904A, 0x8FFE, 0x9096, 0x90E2):
            cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
            call(cpu, 0x36FC)
        mount_painted = draw_list(0x8FFE)
        painted = draw_list(0x9096)
        meter.clear()
        call(cpu, 0x46E4)
        call(cpu, 0xA95)
        transient = []
        for actor in listed_actors(cpu, 0x9096):
            kind = word(cpu, actor)
            seen.add(kind)
            entry = [actor, kind]
            if kind not in (4, 0x40):
                entry.extend(word(cpu, actor + off, signed=True) for off in (0x12, 0x16))
                entry.append(word(cpu, actor + (0x1A if kind == 0x24 else 0xC)))
            transient.append(entry)
        actual = {"transient": transient, "painted": painted, "mountPainted": mount_painted,
                  "free": word(cpu, 0x8E7C), "remaining": word(cpu, 0x9162),
                  "meter": meter[0] if meter else None,
                  "mounts": [[a, word(cpu, a)] for a in listed_actors(cpu, 0x8FFE)],
                  "drone": [list(entry) if entry[0] >= 0 else None for entry in
                            struct.iter_unpack("<4h", cpu.mem_read(DS + 0x9C80, 80 * 8))]}
        for key, value in actual.items():
            assert value == state[key], ("Nashwan", stage, tick, key, value, state[key])
    assert {4, 0x10, 0x24, 0x30, 0x40}.issubset(seen)
    assert any(entry for state in states for entry in state["drone"])
    expiry, paid = states[37:39]
    assert expiry["meter"] and not expiry["remaining"] and not paid["meter"]
    assert len(expiry["mountPainted"]) > len(paid["mountPainted"])
    print(f"PASS stage-{stage} Nashwan: 40 DOS ticks of mixed volleys, final paint, meter, release and paid-loadout return")

for case in native["stageTwoPickupOrder"]:
    cpu = startup_pool(1, True)
    cpu.mem_write((0x349B + LOAD) * 16, base64.b64decode(native["sharedSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
    skip_calls(cpu, {0xEB3})
    for offset, value in [(0x9F16, 174), (0x9198, 0), (0x9188, 0), (0x9164, 0)]:
        word(cpu, offset, value)
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x3589)
    for kind in (("round", "pickup") if case["first"] else ("pickup", "round")):
        if kind == "round":
            for register, value in [(UC_X86_REG_AX, 160), (UC_X86_REG_BX, 170), (UC_X86_REG_CX, 0),
                                    (UC_X86_REG_DX, 0), (UC_X86_REG_BP, case["frame"])]:
                cpu.reg_write(register, value)
            call(cpu, 0x1ED3)
            round_address = word(cpu, 0x90A0)
        else:
            pod = 0xF000
            for offset, value in [(0x12, case["x"]), (0x16, case["y"]), (0x22, 18)]:
                word(cpu, pod + offset, value)
            cpu.reg_write(UC_X86_REG_DI, pod)
            call(cpu, 0x1E61)
            pickup = word(cpu, 0x90A0)
            word(cpu, pickup + 0x1A, -2)
    cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x90A0))
    call(cpu, 0x36FC)
    assert word(cpu, 0x9186) == case["health"], case
    assert (word(cpu, pickup) == 4) == case["pickupDead"], case
    assert (word(cpu, round_address) in (0, 4)) == case["roundDead"], case
print("PASS stage-two pickup contact: Z blocks damage only from later rounds in the transient list")

def launch_test_rocket(cpu, x, y):
    word(cpu, 0x9F12, x)
    word(cpu, 0x9F16, y)
    cpu.mem_write(DS + 0x8FAE, b"\xff")
    word(cpu, 0xF300 + 0x48, -1)
    cpu.reg_write(UC_X86_REG_SI, 0xF300)
    call(cpu, 0x3900)
    rockets = [a for a in listed_actors(cpu, 0x9096) if word(cpu, a) == 0x48]
    assert len(rockets) == 4
    rocket = rockets[-1]
    for actor in rockets[:-1]:
        cpu.reg_write(UC_X86_REG_SI, actor)
        call(cpu, 0x7A0)
    word(cpu, rocket + 0x1A, 0)
    return rocket


for case in native["homingPatrolLocks"]:
    cpu = startup_pool(1, True)
    cpu.mem_write((0x349B + LOAD) * 16,
                  base64.b64decode(native["sharedSprites"]) + base64.b64decode(native["weaponSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
    skip_calls(cpu, {0xEB3})
    for address in listed_actors(cpu, 0x904A):
        word(cpu, address + 2, 0x761)
        word(cpu, address + 0x28, 1000)  # Keep the inactive arena controllers offscreen.
    camera = case["event"][0]
    for offset, value in [(0x9190, camera), (0x91AA, camera + 16), (0x9198, 0), (0x304A, 0x5845)]:
        word(cpu, offset, value)
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
    cpu.reg_write(UC_X86_REG_DI, 0xF000)
    call(cpu, 0x8018)
    patrol = cpu.reg_read(UC_X86_REG_SI)
    rocket = launch_test_rocket(cpu, 110, 60)
    assert (patrol, rocket) == (case["patrol"], case["rocket"])
    if "prior" in case:
        word(cpu, rocket + 0x22, patrol if case["locked"] else 0)
        cpu.reg_write(UC_X86_REG_SI, patrol)
        call(cpu, 0x7A0)
        donor = 0xF400
        if case["prior"] == "egg":
            word(cpu, donor + 0x16, 96)
            cpu.reg_write(UC_X86_REG_SI, donor)
            call(cpu, 0x8B17)
            assert word(cpu, patrol) == 0x10C
            cpu.reg_write(UC_X86_REG_SI, patrol)
            call(cpu, 0x7A0)
        box = [word(cpu, patrol + offset) for offset in range(0x28, 0x30, 2)]
        for offset, value in [(0, 0x114), (2, 0x866D), (0x12, 280), (0x16, 100), (0x24, 2)]:
            word(cpu, donor + offset, value)
        cpu.reg_write(UC_X86_REG_DI, donor)
        cpu.reg_write(UC_X86_REG_AX, 2)
        call(cpu, 0x80F5)
        corpse = word(cpu, 0x90A0)
        cpu.reg_write(UC_X86_REG_SI, corpse)
        call(cpu, 0x866D)
        assert corpse == patrol and box == [word(cpu, corpse + offset) for offset in range(0x28, 0x30, 2)]
        word(cpu, 0x8F32, 1)
        cpu.reg_write(UC_X86_REG_SI, rocket)
        call(cpu, 0x1FF3)
        actual = {"lists": [[[a, word(cpu, a)] for a in listed_actors(cpu, sentinel)]
                            for sentinel in (0x904A, 0x9096)],
                  "position": [word(cpu, rocket + offset, signed=offset == 0x1A)
                               for offset in (0x12, 0x16, 0x1C, 0x1A, 0xC)],
                  "target": word(cpu, rocket + 0x22), "seed": word(cpu, 0x304A),
                  "effects": [[word(cpu, a + 0x12), word(cpu, a + 0x16)]
                              for a in listed_actors(cpu, 0x9096) if word(cpu, a) == 0xC],
                  "corpse": [corpse] + [word(cpu, corpse + offset) for offset in (0x12, 0x16, 0x1C, 0xC)]}
        assert actual == case["expected"], ("Homing Missile corpse lock", case["prior"], case["locked"],
                                            actual, case["expected"])
        continue
    if "hatch" in case:
        word(cpu, rocket + 0x22, patrol)
        cpu.reg_write(UC_X86_REG_SI, patrol)
        call(cpu, 0x7A0)
        cpu.reg_write(UC_X86_REG_SI, 0xF400)
        if case["hatch"]:
            for offset, value in [(0x12, 160), (0x16, 124), (0x1C, 2)]:
                word(cpu, 0xF400 + offset, value)
            call(cpu, 0x8468)
            assert word(cpu, patrol) == 0x110
        else:
            word(cpu, 0xF400 + 0x16, 96)
            call(cpu, 0x8B17)
            assert word(cpu, patrol) == 0x10C and actor_box(cpu, patrol) == [1000]
        call(cpu, 0x373D)
        cpu.reg_write(UC_X86_REG_SI, rocket)
        call(cpu, 0x1FF3)
        transient = list(listed_actors(cpu, 0x9096))
        actual = {"lists": [[[a, word(cpu, a)] for a in listed_actors(cpu, sentinel)]
                            for sentinel in (0x904A, 0x9096)],
                  "position": [word(cpu, rocket + offset, signed=offset == 0x1A)
                               for offset in (0x12, 0x16, 0x1C, 0x1A, 0xC)],
                  "target": word(cpu, rocket + 0x22), "seed": word(cpu, 0x304A),
                  "effects": [[word(cpu, a + 0x12), word(cpu, a + 0x16)]
                              for a in transient if word(cpu, a) == 0xC]}
        assert actual == case["expected"], ("Homing Missile recycled slot", case["hatch"], actual, case["expected"])
        continue
    word(cpu, rocket + 0x22, patrol if case["locked"] else 0)
    word(cpu, 0x9F12, 300)
    word(cpu, 0x9F16, 100)
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x3589)
    call(cpu, 0x373D)
    for sentinel in (0x904A, 0x9096):
        cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
        call(cpu, 0x36FC)
    lists = [[[a, word(cpu, a)] for a in listed_actors(cpu, sentinel)] for sentinel in (0x904A, 0x9096)]
    actual = {"lists": lists,
              "position": [word(cpu, rocket + offset, signed=offset == 0x1A)
                           for offset in (0x12, 0x16, 0x1C, 0x1A, 0xC)],
              "box": actor_box(cpu, patrol), "target": word(cpu, rocket + 0x22),
              "seed": word(cpu, 0x304A), "effects": sum(kind == 0xC for _, kind in lists[1])}
    assert actual == case["expected"], ("Homing Missile patrol lock", case["locked"], actual, case["expected"])
print("PASS Homing Missile patrol locks: existing locks survive migration but new locks search only the main list")
print("PASS Homing Missile recycled locks: a reused slot follows a crawler but not an untargetable egg")
print("PASS Homing Missile corpse locks: existing locks use inherited patrol bounds but not disabled egg bounds")


case = native["miniCorpseSelfReuse"]
cpu = startup_pool(1, True)
call(cpu, 0x1022)
wave = cpu.reg_read(UC_X86_REG_SI)
assert wave == case["wave"]
cpu.reg_write(UC_X86_REG_DI, 0x904A)
call(cpu, 0x77C)
for offset, value in [(0, 0x114), (2, 0x866D), (0x12, 280), (0x16, 100), (0x24, 2)]:
    word(cpu, wave + offset, value)
word(cpu, 0x8E7C, 0)
word(cpu, 0x304A, 0x5845)
cpu.reg_write(UC_X86_REG_DI, wave)
cpu.reg_write(UC_X86_REG_AX, 2)
call(cpu, 0x80F5)
corpse = word(cpu, 0x90A0)
assert [corpse] + [word(cpu, corpse + offset) for offset in (0, 0x12, 0x16, 0x1C)] + [
    word(cpu, 0x304A)] == case["before"]
cpu.reg_write(UC_X86_REG_SI, corpse)
call(cpu, 0x36FC)
assert word(cpu, corpse) == 0
assert [word(cpu, 0x8E7C), word(cpu, corpse + 0x12), word(cpu, corpse + 0x16)] == case["after"]
print("PASS saturated miniboss wave death: the self-reused corpse is marked and frees without moving")


def trace_actor_update(uc, _address, _size, dispatch):
    actor = uc.reg_read(UC_X86_REG_SI)
    dispatch.append((actor, word(uc, actor)))


for case in native["transientReuse"]:
    cpu = startup_pool(1, True)
    cpu.mem_write((0x349B + LOAD) * 16,
                  base64.b64decode(native["sharedSprites"]) + base64.b64decode(native["weaponSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
    skip_calls(cpu, {0xEB3})
    for offset, value in [(0x9198, 0), (0x304A, 0x5845)]:
        word(cpu, offset, value)
    # Keep the arena slots reserved, but leave no eligible targets linked.
    cpu.reg_write(UC_X86_REG_SI, 0x904A)
    call(cpu, 0x762)
    for register, value in [(UC_X86_REG_AX, 30), (UC_X86_REG_BX, 40), (UC_X86_REG_CX, 2),
                            (UC_X86_REG_DX, 2), (UC_X86_REG_BP, case["frame"])]:
        cpu.reg_write(register, value)
    call(cpu, 0x1ED3)
    round_address = word(cpu, 0x90A0)
    if case["successorBlast"]:
        for register, value in [(UC_X86_REG_AX, 40), (UC_X86_REG_BX, 50),
                                (UC_X86_REG_BP, 0x1230), (UC_X86_REG_DX, 0x853)]:
            cpu.reg_write(register, value)
        call(cpu, 0x3326)
        blast = word(cpu, 0x90A0)
    rocket = launch_test_rocket(cpu, 80, 60)
    while word(cpu, 0x8E7C):
        call(cpu, 0x1022)
    before = [[a, word(cpu, a)] for a in listed_actors(cpu, 0x9096)]
    assert before == case["before"], (before, case["before"])

    dispatch = []
    cpu.hook_add(UC_HOOK_CODE, trace_actor_update, dispatch, begin=LOAD * 16 + 0x3704, end=LOAD * 16 + 0x3704)
    for tick, expected in enumerate(case["states"]):
        dispatch.clear()
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x90A0))
        call(cpu, 0x36FC)
        if case["successorBlast"]:
            head = [(blast, 0xC)] if tick else [(rocket, 0x48), (blast, 0xC), (rocket, 4)]
            assert word(cpu, blast + 0xE) == 1
        else:
            head = [(rocket, 4 if tick else 0x48)]
            assert word(cpu, rocket + 4) == 0x761
        actual = {"list": [[a, word(cpu, a), word(cpu, a + 0x12), word(cpu, a + 0x16), word(cpu, a + 0xC)]
                           for a in listed_actors(cpu, 0x9096)],
                  "free": word(cpu, 0x8E7C), "seed": word(cpu, 0x304A)}
        assert dispatch == [*head, (round_address, 0x14)], (dispatch, actual)
        assert actual == expected, ("recycled missile burst", case["successorBlast"], tick, actual, expected)
print("PASS saturated transient walk: successor reuse advances the blast; self-reuse marks it without drawing")

for case in native["mixedDropCountdown"]:
    cpu = startup_pool(1, True)
    cpu.mem_write((0x349B + LOAD) * 16,
                  base64.b64decode(native["sharedSprites"]) + base64.b64decode(native["weaponSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
    skip_calls(cpu, {0xEB3})
    for offset, value in [(0x9F0C, word(cpu, 0x304C + 12)), (0x9F12, 160), (0x9F16, 174),
                          (0x9198, 0), (0x9186, 39), (0x9188, 0), (0x8E80, 0),
                          (0x915A, 5000), (0x915C, 0), (0x9164, 0), (0x8FB0, 0)]:
        word(cpu, offset, value)
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x3589)
    cpu.reg_write(UC_X86_REG_CX, 0)
    call(cpu, 0x15E4)
    cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x90A0))
    call(cpu, 0x7A0)
    boss_credit = word(cpu, 0x90A0)
    word(cpu, 0x9164, 1)
    for offset, value in [(0x12, 50), (0x16, 30), (0x1A, -2)]:
        word(cpu, boss_credit + offset, value)
    if case["afterEviction"] is not None:
        while word(cpu, 0x8E7C):
            call(cpu, 0x1022)
    for register, value in [(UC_X86_REG_AX, 160), (UC_X86_REG_BX, 170), (UC_X86_REG_CX, 0),
                            (UC_X86_REG_DX, 0), (UC_X86_REG_BP, case["frame"])]:
        cpu.reg_write(register, value)
    call(cpu, 0x1ED3)
    if case["afterEviction"] is not None:
        round_address = word(cpu, 0x90A0)
        assert round_address == boss_credit and word(cpu, round_address) == 0x14
        cpu.reg_write(UC_X86_REG_SI, round_address)
        call(cpu, 0x36FC)
        after_eviction = {"count": word(cpu, 0x9164), "shop": bool(word(cpu, 0x8FB0) & 255),
                          "health": word(cpu, 0x9186), "credits": word(cpu, 0x915A),
                          "ordinaryDead": False, "bossDead": True, "reused": round_address == boss_credit,
                          "roundDead": word(cpu, round_address) == 4, "flash": word(cpu, 0x9F04) == 0x8B9}
        assert after_eviction == case["afterEviction"], ("evicted boss credit", after_eviction, case["afterEviction"])
    for offset, value in [(0x12, 160), (0x16, case["y"]), (0x22, 0)]:
        word(cpu, 0xF000 + offset, value)
    cpu.reg_write(UC_X86_REG_DI, 0xF000)
    call(cpu, 0x3AEC if case["kind"] == "credit" else 0x1E61)
    ordinary = word(cpu, 0x90A0)
    if case["afterEviction"] is not None:
        assert ordinary == boss_credit
    word(cpu, ordinary + 0x1A, case["state"])
    word(cpu, ordinary + 0x1C, 0)
    cpu.reg_write(UC_X86_REG_SI, ordinary)
    call(cpu, 0x36FC)
    actual = {"count": word(cpu, 0x9164), "shop": bool(word(cpu, 0x8FB0) & 255),
              "health": word(cpu, 0x9186), "credits": word(cpu, 0x915A),
              "ordinaryDead": word(cpu, ordinary) == 4, "bossDead": word(cpu, boss_credit) != 0x18}
    assert actual == case["expected"], ("mixed drop countdown", case, actual)
print("PASS mixed drop countdown: DOS ordinary globe collection and pod expiry release protection before later shots")
print("PASS saturated drop countdown: a recycled boss globe leaves the DOS countdown and shop gate unchanged")


def flash_pixels(cpu, actor=0x9F00, normal=0x853):
    """Capture the VGA set/reset color at the pixels selected by the flash painter."""
    controller = {8: 255}
    pixels = {}

    def out(_cpu, port, _size, value, _data):
        if port == 0x3CE:
            controller["index"] = value & 255
            if _size == 2:
                controller[value & 255] = value >> 8
        elif port == 0x3CF:
            controller[controller["index"]] = value

    def write(_cpu, _access, address, size, _value, _data):
        assert size == 1 and controller[1] == 15
        y, cell = divmod(address - 0xA0000, 40)
        for bit in range(8):
            if controller[8] & (0x80 >> bit):
                pixels[cell * 8 + bit, y] = controller[0]

    out_hook = cpu.hook_add(UC_HOOK_INSN, out, None, 1, 0, UC_X86_INS_OUT)
    write_hook = cpu.hook_add(UC_HOOK_MEM_WRITE, write, begin=0xA0000, end=0xA1FFF)
    cpu.mem_write(0x90010, struct.pack("<H", 192))
    word(cpu, 0x3044, 0)
    word(cpu, 0x425B, 0)
    cpu.reg_write(UC_X86_REG_SI, actor)
    call(cpu, word(cpu, actor + 4))
    assert word(cpu, actor + 4) == normal
    cpu.hook_del(out_hook)
    cpu.hook_del(write_hook)
    return pixels


pickup_sprite_bank = base64.b64decode(native["sharedSprites"]) + base64.b64decode(native["weaponSprites"])
for case in native["hostileContacts"]:
    stage = case["stage"]
    if stage == 2:
        cpu = startup_pool(1, True)
        cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
    else:
        cpu = foreground_machine(stage)
        word(cpu, 0x9052, 0x904A)
        word(cpu, 0x9054, 0x904A)
        skip_calls(cpu, {0xF96})
    cpu.mem_write((0x349B + LOAD) * 16, pickup_sprite_bank)
    cpu.mem_write(DS, bytes(12000))
    skip_calls(cpu, {0xEB3})
    for offset, value in [(0x9190, 1000), (0x91AA, 1016), (0x9198, 0), (0x919E, 0),
                          (0x9F0C, word(cpu, 0x304C + 12)), (0x9F12, 160), (0x9F16, 174),
                          (0x9186, case["health"]), (0x9188, case["invincible"]),
                          (0x9164, case["counted"]), (0x915A, 0), (0x915C, 0), (0x8E7E, 0),
                          (0x8E80, case["dive"]), (0x8E82, -1 if case["dive"] == 1 else 0)]:
        word(cpu, offset, value)
    # Start with the hull left by the last exposed HUD visit.
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x3589)
    if case["kind"] == "round":
        for register, value in [(UC_X86_REG_AX, 160), (UC_X86_REG_BX, case["y"]), (UC_X86_REG_CX, 0),
                                (UC_X86_REG_DX, 0), (UC_X86_REG_BP, case["frame"])]:
            cpu.reg_write(register, value)
        call(cpu, 0x1ED3)
        actor = word(cpu, 0x90A0)
    elif case["kind"] == "reward":
        for offset, value in [(0x12, 160), (0x16, case["y"]), (0x22, 16)]:
            word(cpu, 0xF000 + offset, value)
        cpu.reg_write(UC_X86_REG_DI, 0xF000)
        call(cpu, 0x1E61)
        actor = word(cpu, 0x90A0)
        word(cpu, actor + 0x1A, -2)
    else:
        cpu.reg_write(UC_X86_REG_CX, 0)
        call(cpu, 0x15E4)
        # Isolate one of the constructed pair as the last uncollected credit.
        actor = word(cpu, 0x90A0)
        if case["kind"] == 100:
            actor = word(cpu, actor + 0xA)
        for offset, value in [(0x12, 160), (0x16, case["y"]), (0x1A, -2), (0x1C, 0)]:
            word(cpu, actor + offset, value)
        word(cpu, 0x9164, 1)
    cpu.mem_write(DS + 0x8F59, b"\x01")
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x4311)
    cpu.reg_write(UC_X86_REG_SI, actor)
    call(cpu, word(cpu, actor + 2))
    dying = cpu.mem_read(DS + 0x9224, 1) != b"\0"
    actual = {"shipY": word(cpu, 0x9F16), "divePhase": None if dying else word(cpu, 0x8E80),
              "y": word(cpu, actor + 0x16), "dead": word(cpu, actor) == 4,
              "health": word(cpu, 0x9186), "invincible": word(cpu, 0x9188), "flash": word(cpu, 0x9F04) == 0x8B9,
              "wallet": word(cpu, 0x915A) + 65536 * word(cpu, 0x915C), "count": word(cpu, 0x9164)}
    assert actual == case["expected"], ("transient contact", case, actual)
    if paint := case["paint"]:
        actual = flash_pixels(cpu)
        expected = {}
        for i, opaque in enumerate(base64.b64decode(paint["mask"])):
            y, x = divmod(i, paint["width"])
            y += paint["y"]
            if opaque and 0 <= y < 192:
                expected[x + paint["x"], y] = 7
        assert actual == expected, ("ship flash mask", stage, case["dive"], dying, len(actual), len(expected))
print("PASS shot and pickup contact: cached edges and VGA hit flash in all five stages; both counted credit values")

for case in native["stageTwoShipContacts"]:
    cpu = startup_pool(1, True)
    cpu.mem_write(DS, bytes(12000))
    cpu.mem_write((0x349B + LOAD) * 16, base64.b64decode(native["sharedSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
    skip_calls(cpu, {0xEB3})
    for offset, value in [(0x9190, 1000), (0x91AA, 1016), (0x9198, 0), (0x919E, 0),
                          (0x9F0C, word(cpu, 0x304C + 12)), (0x9F12, case["x"]), (0x9F16, 174),
                          (0x9150, case["shades"]), (0x9186, case["health"]), (0x9188, 0),
                          (0x9164, 0), (0x8E80, 0), (0x8E7E, 0), (0x991E, 0)]:
        word(cpu, offset, value)
    for _ in range(2):
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
        cpu.reg_write(UC_X86_REG_DI, 0xF000)
        call(cpu, 0x7F82)
    cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
    call(cpu, 0x36FC)
    if case["mode"] == "marked":
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
        call(cpu, 0x7C0)
    if case["pickup"]:
        for offset, value in [(0x12, case["pickup"][0]), (0x16, case["pickup"][1]), (0x22, 16)]:
            word(cpu, 0xF000 + offset, value)
        cpu.reg_write(UC_X86_REG_DI, 0xF000)
        call(cpu, 0x1E61)
        word(cpu, word(cpu, 0x90A0) + 0x1A, -2)
    cpu.mem_write(DS + 0x8F59, bytes([4 if case["mode"] == "steer-in" else 8]))
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x4311)
    for sentinel in (0x904A, 0x9096):
        cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
        call(cpu, 0x36FC)
    actual = {
        "lists": [[[a, word(cpu, a)] for a in listed_actors(cpu, sentinel)] for sentinel in (0x904A, 0x9096)],
        "x": word(cpu, 0x9F12), "health": word(cpu, 0x9186), "score": word(cpu, 0x9152),
        "invincible": word(cpu, 0x9188), "dying": cpu.mem_read(DS + 0x9224, 1) != b"\0",
        "flash": word(cpu, 0x9F04) == 0x8B9, "free": word(cpu, 0x8E7C),
    }
    assert actual == case["expected"], ("ship contact", case["mode"], actual, case["expected"])
print("PASS stage-two ship contact: DOS sprite edges, steering, marked blockers, Shades and fatal pickup order")

for case in native["swarmContacts"]:
    cpu = startup_pool(1, True)
    cpu.mem_write(DS, bytes(12000))
    cpu.mem_write((0x349B + LOAD) * 16, base64.b64decode(native["sharedSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
    skip_calls(cpu, {0xEB3})
    for offset, value in [(0x9190, 1000), (0x91AA, 1016), (0x9198, 0), (0x919E, 0),
                          (0x9F0C, word(cpu, 0x304C + 12)), (0x9F12, 160), (0x9F16, case["shipY"]),
                          (0x9150, 0), (0x9186, case["health"]), (0x9188, case["invincible"]),
                          (0x9164, 0), (0x8E80, case["dive"]), (0x8E82, 0), (0x8E7E, 0),
                          (0x9223, int(case["shield"]))]:
        word(cpu, offset, value)
    cpu.mem_write(DS + 0x8F59, b"\0")
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x3589)
    call(cpu, 0x1022)
    actor = cpu.reg_read(UC_X86_REG_SI)
    cpu.reg_write(UC_X86_REG_DI, 0x904A)
    call(cpu, 0x77C)
    animation = struct.unpack_from("<H", image, 0x8FE9 + (7 - case["direction"]) * 6)[0]
    pointer, duration = struct.unpack_from("<HH", image, animation)
    for offset, value in [(0, 0x108), (2, 0x85D0), (4, 0x853), (6, 0x3B55), (0xC, pointer),
                          (0xE, duration), (0x10, animation + 4), (0x12, case["x"]), (0x16, case["y"]),
                          (0x1A, case["age"]), (0x1C, case["direction"]), (0x24, 1), (0x26, 0)]:
        word(cpu, actor + offset, value)
    cpu.reg_write(UC_X86_REG_SI, actor)
    call(cpu, 0x3589)
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x4311)
    cpu.reg_write(UC_X86_REG_SI, actor)
    call(cpu, word(cpu, actor + 2))
    cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x90A0))
    call(cpu, 0x36FC)
    actual = {
        "health": word(cpu, 0x9186), "dead": word(cpu, actor) in (0, 4), "score": word(cpu, 0x9152),
        "dying": cpu.mem_read(DS + 0x9224, 1) != b"\0", "flash": word(cpu, 0x9F04) == 0x8B9,
        "position": [word(cpu, actor + off) for off in (0x12, 0x16)], "free": word(cpu, 0x8E7C),
        "effects": [[a, word(cpu, a + 0x12), word(cpu, a + 0x16)] for a in listed_actors(cpu, 0x9096)],
    }
    assert actual == case["expected"], ("swarm contact", case["mode"], actual, case["expected"])
print("PASS stage-two swarm contact: DOS remote hit, visible miss, protection, dive, fatality, ramming and expiry")

case = native["stageTwoRing"]
cpu = startup_pool(1, True)
cpu.mem_write((0x349B + LOAD) * 16, base64.b64decode(native["sharedSprites"]))
cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
skip_calls(cpu, {0xEB3})
for offset, value in [(0x9F16, 174), (0x9198, 0), (0x9188, 0), (0x9164, 0), (0x991E, 0)]:
    word(cpu, offset, value)
cpu.reg_write(UC_X86_REG_SI, 0x9F00)
call(cpu, 0x3589)


def ring_fixture_round(x, y):
    for register, value in [(UC_X86_REG_AX, x), (UC_X86_REG_BX, y), (UC_X86_REG_CX, 0),
                            (UC_X86_REG_DX, 0), (UC_X86_REG_BP, case["frame"])]:
        cpu.reg_write(register, value)
    call(cpu, 0x1ED3)


ring_fixture_round(9, 160)
for offset, value in [(0x12, case["x"]), (0x16, case["y"]), (0x22, 16)]:
    word(cpu, 0xF000 + offset, value)
cpu.reg_write(UC_X86_REG_DI, 0xF000)
call(cpu, 0x1E61)
word(cpu, word(cpu, 0x90A0) + 0x1A, -2)
meters = sprite_draw_trace(cpu)
draw_list = draw_list_trace(cpu)
for tick, state in enumerate(case["states"]):
    if tick in (1, 2):
        word(cpu, 0x9188, 1)
    if tick == 1:
        call(cpu, 0x2B80)
    if tick == 2:
        ring_fixture_round(160, 170)
    meters.clear()
    cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x90A0))
    call(cpu, 0x36FC)
    records = [[a, word(cpu, a)] + ([word(cpu, a + off) for off in (0xC, 0x12, 0x16)]
                                     if word(cpu, a) == 0x5C else [])
               for a in listed_actors(cpu, 0x9096)]
    actual = {"records": records, "paint": meters + draw_list(0x9096), "remaining": word(cpu, 0x9188),
              "health": word(cpu, 0x9186), "free": word(cpu, 0x8E7C)}
    assert actual == state, ("ring", tick, actual, state)
print("PASS stage-two ring: DOS pickup birth, stacking, meter and draw order, expiry and free chain")

cpu = startup_pool(1, True)
cpu.mem_write(DS, base64.b64decode(native["bossTwoMap"]))
cpu.mem_write((0x349B + LOAD) * 16, base64.b64decode(native["sharedSprites"]))
cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
cpu.hook_add(UC_HOOK_INTR, lambda uc, interrupt, _: uc.reg_write(
    UC_X86_REG_AX, uc.reg_read(UC_X86_REG_AX) & 0xFF00))
for offset, value in [(0x9190, 100), (0x91AA, 116), (0x9198, 0), (0x304A, 0x5845),
                      (0x9F12, 16), (0x9F16, 16), (0x9188, 999)]:
    word(cpu, offset, value)
for address in listed_actors(cpu, 0x904A):
    if word(cpu, address) == 0x54:
        word(cpu, address + 2, 0x761)
cpu.reg_write(UC_X86_REG_SI, 0x9F00)
call(cpu, 0x3589)
seen_types = set()
draw_list = draw_list_trace(cpu)
for tick, expected in enumerate(native["bossArenaPool"], 1):
    word(cpu, 0x919C, tick)
    call(cpu, 0x373D)
    for sentinel in (0x904A, 0x9096):
        cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
        call(cpu, 0x36FC)
    lists = []
    for sentinel in (0x904A, 0x9096):
        records = []
        for actor in listed_actors(cpu, sentinel):
            kind = word(cpu, actor)
            seen_types.add(kind)
            record = [actor, kind]
            if kind == 0x14:
                record.extend([*fixed_position(cpu, actor), word(cpu, actor + 0xC)])
            elif kind in (0x10C, 0x110):
                record.extend(word(cpu, actor + offset, signed=offset in (0x12, 0x16))
                              for offset in (0x12, 0x16, 0x1C, 0xC, 0xE))
            records.append(record)
        lists.append(records)
    painted = [[0x50] if word(cpu, actor) == 0x50 else
               [word(cpu, actor + 0xC), word(cpu, actor + 0x12, signed=True), word(cpu, actor + 0x16, signed=True)]
               for actor in draw_list(0x904A)]
    actual = {"lists": lists, "painted": painted, "seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C)}
    assert actual == expected, (tick, actual, expected)
assert {0x14, 0x10C, 0x110}.issubset(seen_types)
print("PASS stage-two arena: 900 original ticks of allocation, reused subpixels, and egg/crawler/core draw order")

case = native["mainToTransient"]
cpu = startup_pool(1, True)
cpu.mem_write(DS, base64.b64decode(native["bossTwoMap"]))
cpu.mem_write((0x349B + LOAD) * 16, base64.b64decode(native["sharedSprites"]))
cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
cpu.hook_add(UC_HOOK_INTR, lambda uc, interrupt, _: uc.reg_write(
    UC_X86_REG_AX, uc.reg_read(UC_X86_REG_AX) & 0xFF00))
for offset, value in [(0x9190, 100), (0x9198, 0), (0x919C, 1),
                      (0x9F12, 16), (0x9F16, 16), (0x304A, 0x5845)]:
    word(cpu, offset, value)
main = list(listed_actors(cpu, 0x904A))
core = next(a for a in main if word(cpu, a) == 0x50)
for actor in main:
    if actor != core:
        word(cpu, actor + 2, 0x761)
for offset, value in [(0x1A, 340), (0x20, 2), (0x48, 255)]:
    word(cpu, core + offset, value)
cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
cpu.reg_write(UC_X86_REG_DI, 0xF000)
call(cpu, 0x7F82)
gun = cpu.reg_read(UC_X86_REG_SI)
assert gun == case["address"]
call(cpu, 0x7DC)
cpu.reg_write(UC_X86_REG_DI, core)
call(cpu, 0x77C)
while word(cpu, 0x8E7C):
    call(cpu, 0x1022)
dispatch = []
cpu.hook_add(UC_HOOK_CODE, trace_actor_update, dispatch, begin=LOAD * 16 + 0x3704, end=LOAD * 16 + 0x3704)
for sentinel in (0x904A, 0x9096):
    cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
    call(cpu, 0x36FC)
assert dispatch[-3:] == [(core, 0x50), (gun, 0x14), (gun, 0x14)], dispatch
assert list(listed_actors(cpu, 0x9096)) == [gun]
actual = {"round": [gun, *fixed_position(cpu, gun), word(cpu, gun + 0xC)],
          "main": [[a, word(cpu, a)] for a in listed_actors(cpu, 0x904A)],
          "seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C)}
assert actual == case["expected"], ("main to transient reuse", actual, case["expected"])
print("PASS saturated main walk: a reused gun slot dispatches its boss round in both passes")

case = native["saturatedHatch"]
cpu = startup_pool(1, True)
cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
word(cpu, 0x9190, 1000)
word(cpu, 0x9198, 0)
for address in listed_actors(cpu, 0x904A):
    word(cpu, address + 2, 0x761)
call(cpu, 0x1022)
egg = cpu.reg_read(UC_X86_REG_SI)
assert egg == case["address"]
cpu.reg_write(UC_X86_REG_DI, 0x904A)
call(cpu, 0x77C)
for offset, value in [(0, 0x10C), (2, 0x83BD), (4, 0x853), (0xC, 0x3B8B), (0xE, 1),
                      (0x10, 0x78F4 + 5 * 4), (0x12, 164), (0x16, 90), (0x1A, 2), (0x1C, 2)]:
    word(cpu, egg + offset, value)
while word(cpu, 0x8E7C):
    call(cpu, 0x1022)
draw_list = draw_list_trace(cpu)
for tick, expected in enumerate(case["states"], 1):
    cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
    call(cpu, 0x36FC)
    record = None
    if egg in listed_actors(cpu, 0x904A):
        record = [word(cpu, egg + offset) for offset in (0, 0x12, 0x16, 0x1C, 0xC, 0xE)] + actor_box(cpu, egg)
    actual = {"record": record, "free": word(cpu, 0x8E7C)}
    assert egg not in draw_list(0x904A)
    assert actual == expected, ("hatch into own slot", tick, actual, expected)
print("PASS saturated arena hatch: recycled egg becomes a marked crawler and frees on its next visit")

for case in native["miniArenaPool"]:
    cpu = startup_pool(case["players"], True)
    cpu.mem_write(DS, base64.b64decode(native["bossTwoMap"]))
    cpu.mem_write((0x349B + LOAD) * 16, base64.b64decode(native["sharedSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S2/SPRITES.VGA").read_bytes())
    paths = (ROOT / "S2/PATHS.BIN").read_bytes()
    cpu.mem_write(DS + 0xDE30, paths)
    for i, offset in enumerate(struct.unpack_from("<115H", paths)):
        word(cpu, 0xDE30 + i * 2, offset + 0xDF16)
    skip_calls(cpu, {0xEB3})
    for offset, value in [(0x9190, 2672), (0x91AA, 2688), (0x9198, 0), (0x919A, 1),
                          (0x304A, 0x5845), (0x9F12, 16), (0x9F16, 16), (0x9188, 999)]:
        word(cpu, offset, value)
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x3589)
    wave_types = (0x114, 0x118, 0x11C)
    wave_draw = {0x761, 0x897, 0x853}
    for tick, expected in enumerate(case["states"], 1):
        word(cpu, 0x919C, tick)
        call(cpu, 0xFF0)
        for sentinel in (0x904A, 0x9096):
            cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
            call(cpu, 0x36FC)
        if tick == case["clear"]:
            for register, value in [(UC_X86_REG_AX, 20), (UC_X86_REG_BX, 20), (UC_X86_REG_CX, 2),
                                    (UC_X86_REG_DX, 0), (UC_X86_REG_BP, 0x1FDF)]:
                cpu.reg_write(register, value)
            call(cpu, 0x1ED3)
            call(cpu, 0x2AD0)
        lists = []
        for sentinel in (0x904A, 0x9096):
            records = []
            for actor in listed_actors(cpu, sentinel):
                kind = word(cpu, actor)
                record = [actor, kind]
                if kind in wave_types:
                    if sentinel == 0x904A:
                        draw = word(cpu, actor + 4)
                        assert draw in wave_draw
                        record.extend([*fixed_position(cpu, actor), word(cpu, actor + 0x1A, signed=True),
                                       draw, 0 if draw == 0x761 else word(cpu, actor + 0xC)])
                    else:
                        record.extend(word(cpu, actor + offset, signed=offset in (0x12, 0x16))
                                      for offset in (0x12, 0x16, 0x1C, 0xC))
                records.append(record)
            lists.append(records)
        actual = {"lists": lists, "seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C),
                  "busy": word(cpu, 0x9202), "selectors": [word(cpu, 0x91F4), word(cpu, 0x91F6)],
                  "lights": [word(cpu, 0x91D4 + i * 2) for i in range(8)],
                  "presence": [bool(v) for v in cpu.mem_read(DS + 0x922D, 2)]}
        for key in actual.keys() - {"lists"}:
            assert actual[key] == expected[key], (case["players"], tick, key, actual[key], expected[key])
        for got, want in zip(actual["lists"], expected["lists"]):
            assert len(got) == len(want), (case["players"], tick, got, want)
            for record, reference in zip(got, want):
                assert record == reference, (case["players"], tick, record, reference)
    right, left, centre = [a for a in listed_actors(cpu, 0x904A) if word(cpu, a) == 0x54]
    for actor in (right, left):
        cpu.reg_write(UC_X86_REG_SI, actor)
        call(cpu, 0x7C0)
    for offset, value in [(0x9200, 1), (0x9202, 0), (centre + 0x28, 144), (centre + 0x2A, 64)]:
        word(cpu, offset, value)
    cpu.reg_write(UC_X86_REG_DI, centre)
    cpu.reg_write(UC_X86_REG_AX, 12)
    call(cpu, 0x87D5)
    actual = {"lists": [[[actor, word(cpu, actor)] for actor in listed_actors(cpu, sentinel)]
                        for sentinel in (0x904A, 0x9096)],
              "seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C), "count": word(cpu, 0x9164)}
    assert actual == case["lastEye"], (case["players"], actual, case["lastEye"])
print("PASS stage-two miniboss arena: 1040 DOS ticks of wave dispatch, Z, corpse motion, reuse and last-eye cleanup")

for case in native["mountPools"]:
    cpu = startup_pool(case["players"], True)
    cpu.hook_add(UC_HOOK_INTR, lambda _cpu, _interrupt, _data: None)
    for action, expected in zip(case["script"], case["states"]):
        operation, *args = action
        if operation == "buy":
            call(cpu, word(cpu, 0x381A + args[0] * 2))
        elif operation == "sell":
            cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9136 + args[0] * 4))
            call(cpu, 0x3788)
        elif operation == "exit":
            call(cpu, 0x3319)
        elif operation == "tick":
            for sentinel in (0x8FFE, 0x9096):
                cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
                call(cpu, 0x36FC)
        elif operation == "save":
            call(cpu, 0x35EB)
        elif operation == "loan":
            word(cpu, 0x9162, 170)
            call(cpu, 0x2B22)
        elif operation == "return":
            call(cpu, 0x472D)
            word(cpu, 0x9162, 0)
        elif operation == "restore":
            call(cpu, 0x18F5)
            call(cpu, 0x193C)
            call(cpu, 0x2B22)
        mounts, overlays = [], []
        for actor in listed_actors(cpu, 0x8FFE):
            kind = word(cpu, actor)
            mounts.append([actor, kind] if kind == 4 else [actor, kind,
                          (word(cpu, actor + 6) - 0x9134) // 4, word(cpu, actor + 0x36),
                          word(cpu, actor + 0x34)])
        for actor in listed_actors(cpu, 0x9096):
            kind = word(cpu, actor)
            overlays.append([actor, kind] if kind == 4 else [actor, kind, word(cpu, actor + 0x1C)])
        assert mounts == expected["mount"], (case["players"], action, mounts, expected["mount"])
        assert overlays == expected["overlays"], (case["players"], action, overlays, expected["overlays"])
        address = word(cpu, 0x8E7C)
        for expected_address in expected["free"]:
            assert address == expected_address, (case["players"], action, address, expected_address)
            address = word(cpu, address + 8)
        assert address == 0
print("PASS mount records: purchases, upgrades, sale retirement, Cannon overlays, Nashwan loan and checkpoint reuse")


def worm_scene(cpu, camera, delta, aim_operand=None):
    for offset, value in [(0x9190, camera), (0x91AA, camera + 16), (0x9198, delta)]:
        word(cpu, offset, value)
    call(cpu, 0x655B)
    if aim_operand is not None:
        cpu.reg_write(UC_X86_REG_BX, aim_operand)
    cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
    call(cpu, 0x36FC)
    groups = [[[], None] for _ in range(5)]
    order = []
    for actor in listed_actors(cpu, 0x904A):
        kind = word(cpu, actor)
        if kind not in (0x10C, 0x110, 0x114):
            continue
        slot = word(cpu, actor + 0x22)
        if slot not in order:
            order.append(slot)
        group = groups[slot]
        heading = word(cpu, actor + 0x1C)
        remaining = word(cpu, actor + 0x1A, signed=True)
        if kind == 0x10C:
            group[1] = [*fixed_position(cpu, actor), heading, remaining]
        else:
            x, y = (word(cpu, actor + offset, signed=True) for offset in (0x12, 0x16))
            left, top, right, bottom = (word(cpu, actor + offset, signed=True)
                                        for offset in (0x28, 0x2A, 0x2C, 0x2E))
            group[0].append([x, y, heading, remaining, word(cpu, actor + 0xC),
                             word(cpu, actor + 4) != 0x761,
                             [left - x, top - y, right - left + 1, bottom - top + 1]])
    for parts, _ in groups:
        parts.reverse()
    return [word(cpu, 0x91AA),
            [word(cpu, 0x91F4 + i * 2) for i in range(5)],
            [word(cpu, 0x91D4 + i * 2) for i in range(16)],
            [word(cpu, struct.unpack_from("<H", image, 0x65F6 + i * 10)[0]) for i in range(16)],
            [group if any(group) else None for group in groups], order,
            [[actor, word(cpu, actor)] for actor in listed_actors(cpu, 0x904A)], word(cpu, 0x8E7C)]


for case in native["terrainWormTraces"]:
    cpu = worm_machine()
    route = case["route"]
    if route >= 0:
        word(cpu, 0x91F4, route << 3)
    if case["seeded"]:
        for offset, value in [(0x9F98 + 0x14, 0xF000), (0x9F98 + 0x18, 0x9000),
                              (0x9F98 + 0x1C, 96), (0x9FE4 + 0x1C, 192)]:
            word(cpu, offset, value)
    for tick, state in enumerate(case["states"]):
        if route >= 0:
            cpu.mem_write(DS + 0x9227, b"\xff" * 4)
        actual = worm_scene(cpu, state["camera"], state["delta"], 0x5A5A)
        assert cpu.reg_read(UC_X86_REG_BX) == (state["aimOperand"] & 65535), ("worm aim carry", route, tick, state)
        expected = state["scene"]
        assert actual[:4] == expected[:4], (route, tick, actual[:4], expected[:4])
        assert actual[5:] == expected[5:], (route, tick, actual[5:], expected[5:])
        for slot, (group, wanted) in enumerate(zip(actual[4], expected[4])):
            assert (group is None) == (wanted is None), (route, tick, slot)
            if group is None:
                continue
            parts, driver = group
            wanted_parts, wanted_driver = wanted
            assert driver == wanted_driver, (route, tick, slot, driver, wanted_driver)
            assert len(parts) == len(wanted_parts), (route, tick, slot, len(parts), len(wanted_parts))
            for i, (part, wanted_part) in enumerate(zip(parts, wanted_parts)):
                assert part == wanted_part, (route, tick, slot, i, part, wanted_part)
print("PASS stage-one terrain worms: 16 paths plus natural progression, allocation, reused fields, poses and retirement")

for case in native["terrainWormDeaths"]:
    cpu = worm_machine()
    word(cpu, 0x91F4, 9 << 3)
    cpu.mem_write(DS + 0x9227, b"\xff" * 4)
    worm_scene(cpu, 3240, 1)
    kind = 0x110 if case["body"] else 0x114
    segments = [a for a in listed_actors(cpu, 0x904A) if word(cpu, a) == kind]
    actor = segments[0] if case["reuse"] == "self" else segments[-1]
    word(cpu, actor + 0x12, case["x"])
    word(cpu, actor + 0x16, case["y"])
    if case["reuse"] == "transient":
        call(cpu, 0x1022)
        victim = cpu.reg_read(UC_X86_REG_SI)
        cpu.reg_write(UC_X86_REG_DI, 0x9096)
        call(cpu, 0x77C)
        word(cpu, victim, 0xC)
    if case["reuse"]:
        word(cpu, 0x8E7C, 0)
    word(cpu, 0x304A, case["seed"])
    cpu.reg_write(UC_X86_REG_DI, actor)
    cpu.reg_write(UC_X86_REG_AX, 1)
    call(cpu, word(cpu, actor + 6))
    corpse = word(cpu, 0x90A0)
    draw = draw_list_trace(cpu)

    def corpse_snapshot():
        return [word(cpu, 0x8E7C), word(cpu, corpse),
                *[word(cpu, corpse + offset) for offset in (0x12, 0x16, 0xC)], draw(0x9096)]

    main = [[a, word(cpu, a)] for a in listed_actors(cpu, 0x904A)]
    first = [word(cpu, 0x304A), word(cpu, 0x9152), word(cpu, corpse + 0x1C), corpse, main, corpse_snapshot()]
    assert first == case["first"], (case, first)
    for tick, expected in enumerate(case["states"], 1):
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x90A0))
        call(cpu, 0x36FC)
        actual = corpse_snapshot()
        assert actual == expected, (case["body"], case["reuse"], case["x"], case["y"], tick, actual, expected)
print("PASS stage-one terrain worm corpses: transient allocation, capacity victims, draw, boundaries and delayed free")

for case in native["terrainWormClear"]:
    cpu = worm_machine()
    word(cpu, 0x304A, 0x5845)
    word(cpu, 0x91F4, 9 << 3)
    cpu.mem_write(DS + 0x9227, b"\xff" * 4)
    worm_scene(cpu, 3240, 1)
    if case["full"]:
        word(cpu, 0x8E7C, 0)
    skip_calls(cpu, {0xEB3})
    cpu.reg_write(UC_X86_REG_ES, LOAD + 0x1853)
    call(cpu, 0x2AD0)
    for tick, expected in enumerate(case["states"]):
        if tick:
            word(cpu, 0x9198, 0)
            for sentinel in (0x904A, 0x9096):
                cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
                call(cpu, 0x36FC)
        actual = {
            "main": [[a, word(cpu, a)] for a in listed_actors(cpu, 0x904A)],
            "corpses": [[a, word(cpu, a), word(cpu, a + 0x12, signed=True), word(cpu, a + 0x16, signed=True),
                         word(cpu, a + 0xC), word(cpu, a + 0x1C)] for a in listed_actors(cpu, 0x9096)],
            "free": word(cpu, 0x8E7C), "seed": word(cpu, 0x304A), "score": word(cpu, 0x9152),
        }
        assert actual == expected, ("terrain worm Z", case["full"], tick, actual, expected)
print("PASS stage-one terrain worm Z: segment corpses, driver marking and retirement with spare slots or at capacity")

for case in native["terrainWormContacts"]:
    cpu = worm_machine()
    word(cpu, 0x91F4, 9 << 3)
    cpu.mem_write(DS + 0x9227, b"\xff" * 4)
    worm_scene(cpu, 3240, 1)
    if case["gunEvent"]:
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["gunEvent"]))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        call(cpu, 0x6F7F)
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
        call(cpu, 0x6D22)
    cpu.mem_write(DS, bytes(12000))
    skip_calls(cpu, {0xEB3})
    for offset, value in [(0x9198, 0), (0x919A, 0), (0x304A, case["seed"]), (0x9F0C, case["shipFrame"]),
                          (0x9F12, case["x"]), (0x9F16, case["y"]), (0x9186, case["health"]),
                          (0x9188, case["invincible"]), (0x9164, case["counted"]), (0x991C, 1)]:
        word(cpu, offset, value)
    cpu.mem_write(DS + 0x9223, bytes([255 if case["protectedShip"] else 0]))
    if case["mode"] == "marked":
        tail = next(a for a in listed_actors(cpu, 0x904A) if word(cpu, a) == 0x110)
        cpu.reg_write(UC_X86_REG_SI, tail)
        call(cpu, 0x7C0)
    cpu.mem_write(DS + 0x8F59, bytes([4 if case["mode"] == "steer-in" else 8]))
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x4311)
    for sentinel in (0x904A, 0x9096):
        cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
        call(cpu, 0x36FC)
    actual = {
        "x": word(cpu, 0x9F12), "health": word(cpu, 0x9186), "score": word(cpu, 0x9152),
        "seed": word(cpu, 0x304A), "flash": word(cpu, 0x9F04) == 0x8B9,
        "dying": cpu.mem_read(DS + 0x9224, 1) != b"\0",
        "corpses": [[a, *[word(cpu, a + offset) for offset in
                         ((0, 0x12, 0x16, 0xC) if word(cpu, a) == 0x0C else (0, 0x12, 0x16, 0xC, 0x1C))]]
                    for a in listed_actors(cpu, 0x9096)],
    }
    assert actual == case["expected"], ("terrain worm contact", case["mode"], actual, case["expected"])
print("PASS stage-one terrain worm contact: old hull, raw segment boxes, protection, fatality and same-tick corpses")

for case in native["terrainWormWeapons"]:
    cpu = worm_machine()
    word(cpu, 0x91F4, 9 << 3)
    cpu.mem_write(DS + 0x9227, b"\xff" * 4)
    if case["groundOrder"] == "worm-first":
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["gunEvent"]))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        call(cpu, 0x6F7F)
    worm_scene(cpu, 3240, 1)
    if case["groundOrder"] == "gun-first":
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["gunEvent"]))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        call(cpu, 0x6F7F)
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
        call(cpu, 0x6D22)
    cpu.mem_write(DS, bytes(12000))
    cpu.mem_write((0x349B + LOAD) * 16,
                  base64.b64decode(native["sharedSprites"]) + base64.b64decode(native["weaponSprites"]))
    mode, x = case["mode"], case["x"]
    for offset, value in [(0x9198, 0), (0x919A, 0), (0x304A, case["seed"]), (0x991C, 1)]:
        word(cpu, offset, value)
    if "shades" in mode:
        for offset, value in [(0x9150, 5), (0x9186, 39), (0x9F0C, case["shipFrame"]), (0x9F12, x), (0x9F16, 80)]:
            word(cpu, offset, value)
        tail = next(a for a in listed_actors(cpu, 0x904A) if word(cpu, a) == 0x110)
        if mode == "marked-shades":
            cpu.reg_write(UC_X86_REG_SI, tail)
            call(cpu, 0x7C0)
        if mode == "marked-gun-shades":
            cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
            call(cpu, 0x7C0)
        if mode == "shades-gate":
            width = word(cpu, tail + 0x2C) - word(cpu, tail + 0x28)
            word(cpu, tail + 0x28, x)
            word(cpu, tail + 0x2C, x + width)
        cpu.reg_write(UC_X86_REG_SI, 0x9F00)
        call(cpu, 0x4311)
    cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
    call(cpu, 0x36FC)
    spent = []
    if mode == "drone":
        cpu.mem_write(DS + 0x9C80, b"\xff" * (80 * 8))
        for slot in (0x9C80, 0x9C88):
            cpu.mem_write(DS + slot, struct.pack("<4h", x, 80, 0, 0))
        call(cpu, 0xA95)
        spent = [word(cpu, slot, signed=True) < 0 for slot in (0x9C80, 0x9C88)]
    elif "shades" not in mode:
        projectiles = []
        cannon = mode == "cannon"
        shot_type = 0x30 if cannon else 0x10
        for i in range(2):
            call(cpu, 0x1022)
            shot = cpu.reg_read(UC_X86_REG_SI)
            projectiles.append(shot)
            cpu.reg_write(UC_X86_REG_DI, 0x9096)
            call(cpu, 0x77C)
            survivor = mode == "saturated" and not i
            for offset, value in [(0, shot_type), (2, 0x28B8 if cannon else 0x39EE), (4, 0x853),
                                  (0xC, case["frame"] or 0), (0x12, 220 if survivor else x),
                                  (0x16, 90 if cannon else 80), (0x20, -10 if cannon else -1 if survivor else 0),
                                  (0x34, 1)]:
                word(cpu, shot + offset, value)
        if mode == "saturated":
            word(cpu, 0x8E7C, 0)
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x90A0))
        call(cpu, 0x36FC)
        spent = [word(cpu, shot) != shot_type for shot in projectiles]
    actual = {"main": [[a, word(cpu, a)] for a in listed_actors(cpu, 0x904A)],
              "score": word(cpu, 0x9152), "seed": word(cpu, 0x304A), "spent": spent}
    if "transient" in case["expected"]:
        draw = draw_list_trace(cpu)

        def transient_snapshot():
            return {"free": word(cpu, 0x8E7C), "draw": draw(0x9096),
                    "records": [[a, *[word(cpu, a + offset) for offset in (0, 0x12, 0x16, 0xC)]]
                                for a in listed_actors(cpu, 0x9096)]}

        actual["transient"] = [transient_snapshot()]
        for sentinel in (0x904A, 0x9096):
            cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
            call(cpu, 0x36FC)
        actual["transient"].append(transient_snapshot())
    assert actual == case["expected"], ("terrain worm weapon", case["groundOrder"], mode, actual, case["expected"])
print("PASS stage-one terrain worm targeting: straight rounds, Cannon, Drone and Shades use the original group gate")
print("PASS stage-one mixed gun and worm targets: linked priority, live/marked blockers and attack ordering")
print("PASS stage-one round slots: linked update/draw order, two corpse ticks, and reuse of the killing round at capacity")

for case in native["stageOneGunPool"]:
    cpu = worm_machine()
    word(cpu, 0x9190, 4300)
    word(cpu, 0x991C, 1)
    word(cpu, 0x304A, 0x5845)
    cpu.mem_write((0x349B + LOAD) * 16,
                  base64.b64decode(native["sharedSprites"]) + base64.b64decode(native["weaponSprites"]))
    for event in case["background"]:
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        call(cpu, {1: 0x6F7F, 2: 0x6F00, 3: 0x6FE0}[event[1]])
    for tick, expected in enumerate(case["states"]):
        for offset, value in [(0x9190, expected["camera"]), (0x91AA, expected["ceiling"]), (0x9198, 0)]:
            word(cpu, offset, value)
        if tick == 1 and case["recycle"]:
            call(cpu, 0x1022)
            shot = cpu.reg_read(UC_X86_REG_SI)
            cpu.reg_write(UC_X86_REG_DI, 0x9096)
            call(cpu, 0x77C)
            word(cpu, shot + 0x14, 0xC000)
            word(cpu, shot + 0x18, 0x9000)
            call(cpu, 0x7C0)
            word(cpu, 0x8E7C, 0)
            cpu.mem_write(DS + word(cpu, 0x9054) + 0x48, b"\xff")
        for sentinel in (0x904A, 0x9096):
            cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
            call(cpu, 0x36FC)
        actual = {
            "main": [[a, word(cpu, a), word(cpu, a + 0x1A), cpu.mem_read(DS + a + 0x48, 1)[0],
                      *[word(cpu, a + offset, signed=True) for offset in (0x28, 0x2A, 0x2C, 0x2E)]]
                     for a in listed_actors(cpu, 0x904A)],
            "transient": [[a, word(cpu, a), *fixed_position(cpu, a), word(cpu, a + 0xC), word(cpu, a + 0x1C)]
                          for a in listed_actors(cpu, 0x9096)],
            "seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C),
        }
        for key, value in actual.items():
            assert value == expected[key], ("stage-one map gun pool", case["recycle"], tick, key, value, expected[key])
print("PASS stage-one map gun slots: six constructors, linked RNG, round drift, delayed frees and recycling at capacity")

for case in native["stageOneGroundDeaths"]:
    cpu = worm_machine()
    word(cpu, 0x9190, 4300)
    word(cpu, 0x91AA, 4316)
    word(cpu, 0x991C, 1)
    word(cpu, 0x9F16, 24)
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
    cpu.reg_write(UC_X86_REG_SI, 0xF000)
    patrol = case["event"][1] == 4
    call(cpu, 0x705B if patrol else 0x6F7F)
    target = word(cpu, 0x9054)
    cpu.reg_write(UC_X86_REG_SI, target)
    call(cpu, 0x6E2C if patrol else 0x6D22)
    cell = (40 * ((4300 + word(cpu, target + 0x16)) // 16) + 2 * (word(cpu, target + 0x12) // 16)
            if patrol else word(cpu, target + 0x38))
    mode = case["mode"]
    if mode != "self":
        call(cpu, 0x1022)
        shot = cpu.reg_read(UC_X86_REG_SI)
        cpu.reg_write(UC_X86_REG_DI, 0x9096)
        call(cpu, 0x77C)
        for offset, value in [(0, 0x10), (2, 0x39EE), (4, 0x853),
                              (0x12, case["x"]), (0x16, case["y"]), (0x34, 1)]:
            word(cpu, shot + offset, value)
    if mode != "free":
        word(cpu, 0x8E7C, 0)
    if mode == "self":
        cpu.reg_write(UC_X86_REG_DI, target)
        cpu.reg_write(UC_X86_REG_AX, 2)
        call(cpu, 0x3AA7 if patrol else 0x3B76)
    draw = draw_list_trace(cpu)
    for tick, expected in enumerate(case["states"]):
        if tick or mode != "self":
            for sentinel in (0x904A, 0x9096):
                cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
                call(cpu, 0x36FC)
        actual = {
            "main": [[a, word(cpu, a)] for a in listed_actors(cpu, 0x904A)],
            "transient": [[a, *[word(cpu, a + offset) for offset in (0, 0x12, 0x16, 0xC)]]
                          for a in listed_actors(cpu, 0x9096)],
            "draw": draw(0x9096), "free": word(cpu, 0x8E7C), "score": word(cpu, 0x9152),
            "tiles": [word(cpu, cell + offset) for offset in (0, 2, 40, 42)],
        }
        assert actual == expected, ("stage-one ground death", patrol, mode, tick, actual, expected)
print("PASS stage-one map gun and patrol deaths: explosion frames, tile writes, and release with a free, recycled shot or recycled target slot")

for case in native["stageOnePatrols"]:
    cpu = worm_machine()
    word(cpu, 0x9190, 4300)
    word(cpu, 0x91AA, 4316)
    word(cpu, 0x991C, 1)
    word(cpu, 0x304A, 0x5845)
    word(cpu, 0x9F12, 160)
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
    cpu.reg_write(UC_X86_REG_SI, 0xF000)
    call(cpu, 0x705B)
    patrol = word(cpu, 0x9054)
    draw = draw_list_trace(cpu)
    mode = case["mode"]
    sentinels = (0x904A, 0x9096)
    for tick, expected in enumerate(case["states"]):
        word(cpu, 0x9F16, 100 if tick else 24)
        if tick == 1 and mode != "free":
            victim = patrol
            if mode == "marked":
                call(cpu, 0x1022)
                victim = cpu.reg_read(UC_X86_REG_SI)
                cpu.reg_write(UC_X86_REG_DI, 0x9096)
                call(cpu, 0x77C)
                call(cpu, 0x7C0)
            word(cpu, victim + 0x14, 0xC000)
            word(cpu, victim + 0x18, 0x9000)
            word(cpu, 0x8E7C, 0)
        for sentinel in sentinels:
            cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
            call(cpu, 0x36FC)
        lists = []
        for sentinel in sentinels:
            records = []
            for actor in listed_actors(cpu, sentinel):
                kind = word(cpu, actor)
                state = ([*fixed_position(cpu, actor), word(cpu, actor + 0xC), word(cpu, actor + 0x1C)]
                         if kind == 0x14 else
                         [word(cpu, actor + offset, signed=offset != 0xC)
                          for offset in (0x12, 0x16, 0xC, 0x28, 0x2A, 0x2C, 0x2E)])
                records.append([actor, kind, *state])
            lists.append(records)
        actual = {"seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C),
                  "draw": [draw(sentinel) for sentinel in sentinels], "lists": lists}
        assert actual == expected, ("stage-one patrol", case["event"][6], mode, tick, actual, expected)
print("PASS stage-one patrols: same-slot migration, linked animation/fire/retirement and saturated volleys on both sides")

for case in native["stageOneMountFire"]:
    cpu = startup_pool(1)
    for offset in (0x8E70, 0x991C, 0x991A):
        word(cpu, offset, 1)
    call(cpu, 0x1B43)
    cpu.mem_write(DS, bytes(12000))
    cpu.mem_write((0x349B + LOAD) * 16,
                  base64.b64decode(native["sharedSprites"]) + base64.b64decode(native["weaponSprites"]))
    cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / "S1/SPRITES.VGA").read_bytes())
    skip_calls(cpu, {0xEB3})
    for offset, value in [(0x991C, 1), (0x9190, 4300), (0x91AA, 4316), (0x9198, 0), (0x304A, 0x5845),
                          (0x9F12, 160), (0x9F16, 96)]:
        word(cpu, offset, value)
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x3589)
    for item in case["orders"]:
        call(cpu, word(cpu, 0x381A + item * 2))
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
    cpu.reg_write(UC_X86_REG_SI, 0xF000)
    call(cpu, 0x6F7F)
    cpu.mem_write(DS + word(cpu, 0x9054) + 0x48, b"\xff")
    for tick, expected in enumerate(case["states"], 1):
        word(cpu, 0x919C, tick)
        cpu.mem_write(DS + 0x8FAE, bytes([255 if expected["fire"] else 0]))
        for sentinel in (0x904A, 0x8FFE, 0x9096):
            cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
            call(cpu, 0x36FC)
        mounts = [[actor, word(cpu, actor + 0x36)] for actor in listed_actors(cpu, 0x8FFE)]
        transient = [[actor, kind, *[word(cpu, actor + offset, signed=offset in (0x12, 0x16)) for offset in
                                    ((0x1C,) if kind == 0x40 else (0x12, 0x16, 0xC))]]
                     for actor in listed_actors(cpu, 0x9096) for kind in (word(cpu, actor),)]
        actual = {"fire": expected["fire"], "mounts": mounts, "transient": transient,
                  "seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C)}
        assert actual == expected, ("stage-one mount order", case["orders"], tick, actual, expected)
print("PASS stage-one mixed wall gun, front/rear and Cannon fire: callback order, addresses, frames and RNG")

for case in native["stageOneAimCarry"]:
    cpu = worm_machine()
    mode = case["mode"]
    bank = case["bank"]
    camera = case["camera"]
    _, kind, _, _, _, _, side = case["groundEvent"]
    if bank:
        skip_calls(cpu, {0xE6F, 0xE91, 0xBA5, 0xF5A})
        call(cpu, 0x1869)
        word(cpu, 0x8E70, 1)
        word(cpu, 0x991C, 1)
        word(cpu, 0x991A, 1)
        call(cpu, 0x1B43)
        cpu.mem_write(DS, bytes(12000))
        cpu.mem_write(DS + 0x8F59, bytes([4 if bank < 0 else 8]))
    for offset, value in [(0x9190, camera), (0x91AA, camera + 16), (0x991C, 1), (0x919C, 1), (0x9198, 0),
                          (0x9F12, case["player"][0]), (0x9F16, case["player"][1]), (0x919E, bank),
                          (0x9F0C, case["shipFrame"]), (0xDE30, 0xF100)]:
        word(cpu, offset, value)
    cpu.mem_write(DS + 0xF100, struct.pack("<9h", *case["path"]))
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
    cpu.reg_write(UC_X86_REG_SI, 0xF000)
    cpu.reg_write(UC_X86_REG_BX, 1)
    call(cpu, 0x70F1)
    formation = word(cpu, 0x9054)
    word(cpu, formation + 0x1A, 0 if mode == "moving" else -80)
    cpu.mem_write(DS + formation + 0x48, b"\xff")
    for event in filter(None, (case["groundEvent"], case["leadEvent"])):
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        call(cpu, {1: 0x6F7F, 2: 0x6F00, 3: 0x6FE0, 4: 0x705B}[event[1]])
        if event is case["groundEvent"] and kind != 4:
            gun = word(cpu, 0x9054)
            firing = mode in ("fire", "moving")
            phase = 23 if kind == 3 and firing else (3, 3, 22)[kind - 1]
            word(cpu, gun + 0x1A, phase)
            cpu.mem_write(DS + gun + 0x48, bytes([255 if firing else 0]))
    if mode == "worm":
        word(cpu, 0x91F4, 9 << 3)
        cpu.mem_write(DS + 0x9227, b"\xff" * 4)
        call(cpu, 0x655B)
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x3589)
    word(cpu, 0x304A, case["seed"])
    if mode == "recycled":
        word(cpu, 0x8E7C, 0)
    if bank:
        # Run the real frame update, stopping at the entry to the VGA draw pass.
        cpu.hook_add(UC_HOOK_CODE, lambda uc, *_: uc.reg_write(UC_X86_REG_IP, 0xFF00),
                     begin=LOAD * 16 + 0x36A9, end=LOAD * 16 + 0x36A9)
        cpu.reg_write(UC_X86_REG_BX, 0xBEEF)
        call(cpu, 0x3682)
    else:
        cpu.reg_write(UC_X86_REG_BX, 0)
        for sentinel in (0x904A, 0x9096):
            cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
            call(cpu, 0x36FC)
    actual = {"seed": word(cpu, 0x304A),
              "shots": [[a, word(cpu, a + 0x1C), *fixed_position(cpu, a), word(cpu, a + 0xC)]
                        for a in listed_actors(cpu, 0x9096) if word(cpu, a) == 0x14]}
    assert actual == case["expected"], ("stage-one aimed fire carry", kind, side, mode, actual, case["expected"])
print("PASS corrected stage-one aimed fire: unaffected by map guns and patrols, firing, inactive, culled, moving and recycled")
print("PASS corrected stage-one frame-entry aimed fire: ship and four-jet prepass, banking left and right")
print("PASS corrected stage-one worm aim: guard bounds do not redirect the next waiting formation")

for case in native["stageOneHostileRounds"]:
    cpu = worm_machine()
    boss = case["source"] != "foreground"
    aimed = case["source"] == "boss-aimed"
    mixed = case["source"] == "boss-mixed" or aimed
    camera = case["camera"]
    root = 0x9F4C
    for offset, value in [(0x9190, camera), (0x91AA, camera + 16), (0x991C, 1), (0x304A, 0x5845),
                          (0x9F12, 300), (0x9F16, 24 if boss else 174), (0x9F0C, case["shipFrame"]), (0x9186, 39)]:
        word(cpu, offset, value)
    if boss:
        call(cpu, 0x758F)
    if case["shot"]:
        cpu.mem_write((0x349B + LOAD) * 16, pickup_sprite_bank)
    if not boss or mixed:
        word(cpu, 0xDE30, 0xF100)
        cpu.mem_write(DS + 0xF100, struct.pack("<9h", *case["path"]))
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        cpu.reg_write(UC_X86_REG_BX, 1)
        call(cpu, 0x70F1)
        foreground = word(cpu, 0x9054)
        if aimed:
            word(cpu, foreground + 0x1A, -1200)
    if not boss:
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["gunEvent"]))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        call(cpu, 0x6F7F)
        gun = word(cpu, 0x9054)
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x3589)
    draw = draw_list_trace(cpu)
    for tick, expected in enumerate(case["states"], 1):
        word(cpu, 0x919C, tick)
        firing = tick == case["birth"] and not case["parentReuse"]
        if firing and case["recycle"]:
            call(cpu, 0x1022)
            shot = cpu.reg_read(UC_X86_REG_SI)
            cpu.reg_write(UC_X86_REG_DI, 0x9096)
            call(cpu, 0x77C)
            call(cpu, 0x7C0)
            word(cpu, shot + 0x14, 0xC000)
            word(cpu, shot + 0x18, 0x9000)
            word(cpu, 0x8E7C, 0)
        counter = bytes([255 if firing else 0])
        if tick == case["parentReuse"]:
            word(cpu, 0x8E7C, 0)
            if case["roundParent"]:
                for register, value in [(UC_X86_REG_AX, 130), (UC_X86_REG_BX, 80), (UC_X86_REG_CX, 2),
                                        (UC_X86_REG_DX, 6), (UC_X86_REG_BP, word(cpu, 0x8E72))]:
                    cpu.reg_write(register, value)
                call(cpu, 0x1ED3)
            if case["source"] == "boss-parent-reward":
                for offset, value in [(0x12, 130), (0x16, 130), (0x22, 16)]:
                    word(cpu, 0xF000 + offset, value)
                cpu.reg_write(UC_X86_REG_DI, 0xF000)
                call(cpu, 0x1E61)
            elif case["source"] == "boss-parent-counted":
                cpu.reg_write(UC_X86_REG_CX, 0)
                call(cpu, 0x15E4)
            elif case["source"].startswith("boss-parent-credit"):
                if case["source"].endswith("-wrap"):
                    word(cpu, 0x304A, 0x324B)
                for offset, value in [(0x12, 130), (0x16, 130), (0x34, 0)]:
                    word(cpu, 0xF000 + offset, value)
                cpu.reg_write(UC_X86_REG_DI, 0xF000)
                call(cpu, 0x3AEC)
            if projectile := case["shot"]:
                cannon = projectile["type"] == 0x30
                call(cpu, 0x1022)
                shot = cpu.reg_read(UC_X86_REG_SI)
                cpu.reg_write(UC_X86_REG_DI, 0x9096)
                call(cpu, 0x77C)
                for offset, value in [(0, projectile["type"]), (2, 0x28B8 if cannon else 0x39EE),
                                      (4, 0x853 if cannon else 0x91F), (0xC, projectile["frame"]),
                                      (0xE, struct.unpack_from("<H", image, 0x132E)[0] if cannon else 0),
                                      (0x10, 0x1330), (0x12, projectile["x"]), (0x16, projectile["y"]),
                                      (0x1A, 0), (0x20, projectile["dy"]), (0x34, 0)]:
                    word(cpu, shot + offset, value)
                if not cannon:
                    word(cpu, shot + 0x1C, projectile["dx"])
        if tick == case["blastParent"]:
            for register, value in [(UC_X86_REG_AX, 130), (UC_X86_REG_BX, 130),
                                    (UC_X86_REG_DX, 0x853), (UC_X86_REG_BP, 0x124C)]:
                cpu.reg_write(register, value)
            call(cpu, 0x3326)
        if tick == case["death"]:
            y = word(cpu, root + 0x16) - camera + 68
            for offset, value in [(0x8EB4, 160), (0x8EB6, y), (0x8EB8, 160), (0x8EBA, y)]:
                word(cpu, offset, value)
            cpu.reg_write(UC_X86_REG_DI, root)
            cpu.reg_write(UC_X86_REG_AX, 30)
            call(cpu, 0x714D)
        if boss and (not case["death"] or tick < case["death"]):
            if tick > 1:
                tip = next(a for a in listed_actors(cpu, 0x904A) if word(cpu, a) == 0x100)
                cpu.mem_write(DS + tip + 0x48, counter)
            if mixed:
                cpu.mem_write(DS + foreground + 0x48, b"\xff" if aimed and tick in (11, 14) else counter)
            cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
            call(cpu, 0x36FC)
        elif not boss:
            for actor in (gun, root):
                cpu.mem_write(DS + actor + 0x48, counter)
            cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
            call(cpu, 0x36FC)
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x90A0))
        call(cpu, 0x36FC)
        records = []
        for actor in listed_actors(cpu, 0x9096):
            kind = word(cpu, actor)
            if kind == 4 and (case["death"] or case["shot"] or case["source"] in
                              ("boss-parent-blast", "boss-parent-round-blast", "boss-parent-reward",
                               "boss-parent-counted", "boss-parent-credit", "boss-parent-credit-wrap")):
                state = []
            elif kind in (4, 0x14):
                state = [*fixed_position(cpu, actor), word(cpu, actor + 0xC), word(cpu, actor + 0x1C)]
            else:
                state = [word(cpu, actor + offset, signed=offset != 0xC) for offset in (0x12, 0x16, 0xC)]
                if kind not in (0x0C, 0x10, 0x30):
                    state.extend([word(cpu, actor + 0x1A, signed=True), word(cpu, actor + 0x1C)])
            records.append([actor, kind, *state])
        actual = {"seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C), "count": word(cpu, 0x9164),
                  "draw": draw(0x9096), "records": records}
        if boss:
            main = []
            for actor in listed_actors(cpu, 0x904A):
                kind = word(cpu, actor)
                if kind == 0x50:
                    state = [word(cpu, actor + offset, signed=True) for offset in (0x16, 0x1A, 0x42)]
                elif kind in (0xFC, 0x100):
                    box = [word(cpu, actor + offset, signed=True) for offset in (0x28, 0x2A, 0x2C, 0x2E)]
                    state = [word(cpu, actor + 0x10), *fixed_position(cpu, actor), word(cpu, actor + 0xC),
                             word(cpu, actor + 0x48) & 255, word(cpu, actor + 0x42),
                             *(box if box[0] != 1000 else [1000])]
                else:
                    state = fixed_position(cpu, actor)
                main.append([actor, kind, *state])
            actual.update(main=main, mainDraw=draw(0x904A))
        assert actual == expected, ("stage-one hostile rounds", case["source"], case["recycle"], tick, actual, expected)
print("PASS stage-one foreground and boss rounds: shared list order, recycled fractions, animated poses and release")
print("PASS stage-one boss main list: core and arm addresses, links, boxes and draw order with mixed foreground fire")
print("PASS stage-one boss aim carry: idle tip pose and firing muzzle reach a waiting formation")
print("PASS stage-one boss arm parent: a hostile round replaces the first arm, supplying live position, heading and speed")
print("PASS stage-one boss arm replacements: direct blast, round-to-blast reuse, and moving pod reward")
print("PASS stage-one boss arm credit replacements: counted pair, raw RNG heading and wrapped code address")
print("PASS stage-one boss arm projectile replacements: forward shot, left shot with negative heading, and Cannon")
print("PASS stage-one boss death list: blasts prepend, credits append, surviving rounds persist, and only main clears")

case = native["stageOneCameraEvents"]
cpu = worm_machine()
cpu.mem_write((0x349B + LOAD) * 16, pickup_sprite_bank)
for offset, value in [(0x919C, 3), (0x91AC, 1), (0x8EB0, 0), (0x8EB2, 0), (0x304A, 0x5845),
                      (0x991A, 1), (0x991C, 1), (0x9F12, 300), (0x9F16, 24), (0x91AA, 4316),
                      (0x9192, 4297), (0x9194, 4297)]:
    word(cpu, offset, value)
call(cpu, 0x7637)
word(cpu, 0xDE30, 0xF100)
cpu.mem_write(DS + 0xF100, struct.pack("<6h", *case["path"]))
for field, base in (("events", 0xD274), ("background", 0xDA9E)):
    cpu.mem_write(DS + base, b"".join(struct.pack("<7H", *event) for event in case[field]) + b"\xff\xff")
cpu.mem_write(DS + 0x9C80, b"\xff" * (80 * 8))
cpu.mem_write(DS + 0x9C80, struct.pack("<4h", *case["hit"], 0, 0))
draw = draw_list_trace(cpu)
tiles = lambda: [word(cpu, case["cell"] * 2 + i) for i in (0, 2, 40, 42)]
for tick, expected in enumerate(case["states"], 4):
    cpu.emu_start(LOAD * 16 + 0x3D26, LOAD * 16 + 0x3D47)
    word(cpu, 0x9190, 4300 - tick)
    for sentinel in (0x904A, 0x9096):
        cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
        call(cpu, 0x36FC)
    painted, paint_tiles = draw(0x904A), tiles()
    call(cpu, 0x36D3)
    call(cpu, 0xA95)
    call(cpu, 0x3615)
    actual = {
        "painted": painted, "paintTiles": paint_tiles, "tiles": tiles(),
        "main": [[a, word(cpu, a)] for a in listed_actors(cpu, 0x904A)],
        "drops": [word(cpu, a) for a in listed_actors(cpu, 0x9096) if word(cpu, a) in (0x18, 0x60)],
        "seed": word(cpu, 0x304A), "score": word(cpu, 0x9152),
        "spent": word(cpu, 0x9C80, signed=True) < 0,
    }
    assert actual == expected, ("stage-one camera events", tick, actual, expected)
print("PASS stage-one camera events: mixed birth order, map and sprite paint delay, and Drone credit before registration")

for case in native["formationCredits"]:
    cpu = worm_machine()
    cpu.mem_write((0x349B + LOAD) * 16, pickup_sprite_bank)
    stage = case["stage"]
    if stage > 1:
        cpu.mem_write((0x4489 + LOAD) * 16, (ROOT / f"S{stage}/SPRITES.VGA").read_bytes())
    for offset, value in [(0x919C, 0), (0x91AC, 1), (0x8EB0, 0), (0x8EB2, 0), (0x304A, 0x5845),
                          (0x991A, case["round"]), (0x991C, case["stage"]), (0x9F12, 300), (0x9F16, 174)]:
        word(cpu, offset, value)
    call(cpu, (0x7637, 0x8F68, 0xACCE, 0xC809, 0xE4F7)[stage - 1])
    word(cpu, 0xDE30, 0xF100)
    word(cpu, 0xDE32, 0xF112)
    cpu.mem_write(DS + 0xF100, struct.pack("<15h", *case["path"]))
    skip_calls(cpu, {0xEB3})
    actors = []
    for tick, expected in enumerate(case["states"], 1):
        cpu.emu_start(LOAD * 16 + 0x3D26, LOAD * 16 + 0x3D47)
        word(cpu, 0x9190, 4300 - tick)
        for sentinel in (0x904A, 0x9096):
            cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
            call(cpu, 0x36FC)
        call(cpu, 0x36D3)
        for event in case["events"]:
            if event[0] == 4300 - tick:
                cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
                cpu.reg_write(UC_X86_REG_SI, 0xF000)
                cpu.reg_write(UC_X86_REG_BX, event[1])
                call(cpu, (0x70F1, 0x80CA, 0xABCC, 0xC771, 0xE475)[stage - 1])
                actors.append(word(cpu, 0x9054))
        for action in case["actions"].get(str(tick), []):
            if action == "clear":
                cpu.reg_write(UC_X86_REG_ES, LOAD + 0x1853)
                call(cpu, 0x2AD0)
            elif action == "unlink":
                cpu.reg_write(UC_X86_REG_SI, actors[0])
                call(cpu, 0x7A0)
            else:
                actor = actors[action]
                cpu.reg_write(UC_X86_REG_DI, actor)
                cpu.reg_write(UC_X86_REG_AX, 32767)
                call(cpu, word(cpu, actor + 6))
        actual = {
            "clock": [word(cpu, i) for i in (0x8EB0, 0x8EB2, 0x91AC)],
            "groups": sorted([word(cpu, i), word(cpu, i + 2)]
                             for i in range(0x8E8C, 0x8EAC, 4) if word(cpu, i)),
            "seed": word(cpu, 0x304A), "score": word(cpu, 0x9152),
            "drops": [word(cpu, a) for a in listed_actors(cpu, 0x9096) if word(cpu, a) in (0x18, 0x60)],
        }
        if stage >= 3:
            actual["drops"].sort()
        assert actual == expected, ("formation credits", stage, case["events"], tick, actual, expected)
print("PASS formation credits in all five stages: four-tick groups, size classes, full table, unlink, escape and Z reset")

for case in native["stageOneForegroundPool"]:
    cpu = worm_machine()
    mode = case["mode"]
    saturated_clear = mode.startswith("clear-recycled")
    ground_death = case.get("groundDeath")
    for offset, value in [(0x9190, 4300), (0x91AA, 4316), (0x991C, 1), (0x304A, 0x5845),
                          (0x9F12, 300), (0x9F16, 174), (0x9F0C, case["shipFrame"]), (0x9186, 39),
                          (0x8EB0, 0x100), (0x8EB2, 0x102)]:
        word(cpu, offset, value)
    word(cpu, 0xDE30, 0xF100)
    cpu.mem_write(DS + 0xF100, struct.pack("<9h", *case["path"]))
    if saturated_clear:
        word(cpu, 0x991A, case["round"])
        call(cpu, 0x7637)
        cpu.mem_write((0x349B + LOAD) * 16, pickup_sprite_bank)
    for event_index, event in enumerate(case["events"]):
        if saturated_clear:
            word(cpu, 0x8EB0, 0x100 + event_index * 4)
            word(cpu, 0x8EB2, 0x102 + event_index * 4)
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *event))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        cpu.reg_write(UC_X86_REG_BX, event[1])
        call(cpu, (0x705B if event[1] == 4 else 0x6F7F) if event[0] == 4300 else 0x70F1)
    if mode.startswith("clear-"):
        if saturated_clear:
            word(cpu, 0x919C, 1)
            cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
            call(cpu, 0x36FC)
            word(cpu, 0x8E7C, 0)
        else:
            cpu.reg_write(UC_X86_REG_AX, 290)
            cpu.reg_write(UC_X86_REG_BX, 70)
            cpu.reg_write(UC_X86_REG_CX, 0)
            cpu.reg_write(UC_X86_REG_DX, 0)
            cpu.reg_write(UC_X86_REG_BP, word(cpu, 0x8E72))
            call(cpu, 0x1ED3)
        skip_calls(cpu, {0xEB3})
        cpu.reg_write(UC_X86_REG_ES, LOAD + 0x1853)
        if ground_death:
            pod, ground, trailing = listed_actors(cpu, 0x904A)
            tile_address = word(cpu, ground + 0x38)
            dispatches = []

            def trace_clear(uc, _address, _size, _data):
                actor = uc.reg_read(UC_X86_REG_DI)
                dispatches.append([actor, word(uc, actor), word(uc, actor + 6), uc.reg_read(UC_X86_REG_SI)])

            cpu.hook_add(UC_HOOK_CODE, trace_clear, begin=LOAD * 16 + 0x3A36, end=LOAD * 16 + 0x3A36)
        call(cpu, 0x2AD0)
        if ground_death:
            wall = mode.endswith("-wall")
            assert dispatches == [[pod, 0x64, 0x1E61, 0x8FFE],
                                  [ground, 0x5C, 0x3B76 if wall else 0x3AA7, 0x8FFE]], (mode, dispatches)
            assert word(cpu, trailing) == 0xCC
            actual = {"address": word(cpu, 0x90A0), "x": word(cpu, ground + 0x12, signed=True),
                      "y": word(cpu, ground + 0x16, signed=True), "frame": word(cpu, ground + 0xC),
                      "tiles": [word(cpu, tile_address + i) for i in (0, 2, 40, 42)] if wall else []}
            assert actual == ground_death, (mode, actual, ground_death)
        if saturated_clear:
            replacement = word(cpu, 0x90A0)
            flash = word(cpu, replacement + 4) == 0x8B9
            assert flash == bool(case["flash"]) == mode.endswith("-resist")
            if flash:
                pixels = flash_pixels(cpu, replacement, 0x853)
                assert set(pixels.values()) == {7}
                assert sorted(y * 320 + x for x, y in pixels if y < 192) == case["flash"]
            if "attachmentFlash" in case:
                attachment = word(cpu, replacement + 0x46)
                assert (word(cpu, attachment + 4) == 0x8B9) == case["attachmentFlash"] == flash
                if flash:
                    assert set(flash_pixels(cpu, attachment, 0x853).values()) == {7}
    if mode == "spent":
        call(cpu, 0x1022)
        spent = cpu.reg_read(UC_X86_REG_SI)
        cpu.reg_write(UC_X86_REG_DI, 0x9096)
        call(cpu, 0x77C)
        call(cpu, 0x7C0)
        word(cpu, spent + 0x1C, 5)
    if mode in ("successor", "spent", "self", "orphan"):
        word(cpu, 0x8E7C, 0)
    if mode == "orphan":
        for register, value in [(UC_X86_REG_AX, 260), (UC_X86_REG_BX, 80), (UC_X86_REG_CX, 2),
                                (UC_X86_REG_DX, 6), (UC_X86_REG_BP, word(cpu, 0x8E72))]:
            cpu.reg_write(register, value)
        call(cpu, 0x1ED3)
    if "type" in case:
        target = word(cpu, 0x9052)
        cpu.reg_write(UC_X86_REG_DI, target)
        cpu.reg_write(UC_X86_REG_AX, 127)
        call(cpu, word(cpu, target + 6))
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x3589)
    draw = draw_list_trace(cpu)
    sentinels = [0x904A, 0x9096]
    for tick, expected in enumerate(case["states"]):
        if mode == "orphan" and tick == 13:
            for register, value in [(UC_X86_REG_AX, 64), (UC_X86_REG_BX, 100),
                                    (UC_X86_REG_DX, 0x853), (UC_X86_REG_BP, 0x124C)]:
                cpu.reg_write(register, value)
            call(cpu, 0x3326)
        if mode == "successor":
            pod = word(cpu, 0x9054)
            cpu.mem_write(DS + pod + 0x48, bytes([255 if tick <= 1 else 0]))
            if tick == 1:
                word(cpu, 0x9F4C + 0x14, 0xC000)
                word(cpu, 0x9F4C + 0x18, 0x9000)
        if tick:
            word(cpu, 0x919C, tick + saturated_clear)
            for sentinel in sentinels:
                cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
                call(cpu, 0x36FC)
        lists = []
        for sentinel in sentinels:
            records = []
            for actor in listed_actors(cpu, sentinel):
                kind = word(cpu, actor)
                state = []
                if kind != 4:
                    if sentinel == 0x904A or kind == 0x14:
                        state = [*fixed_position(cpu, actor), word(cpu, actor + 0xC)]
                    else:
                        state = [word(cpu, actor + i, signed=i != 0xC) for i in (0x12, 0x16, 0xC)]
                    if sentinel == 0x904A:
                        state.extend(word(cpu, actor + i, signed=True) for i in (0x28, 0x2A, 0x2C, 0x2E))
                        state.append(word(cpu, actor + 0x48) & 255)
                    elif kind == 0x14:
                        state.append(word(cpu, actor + 0x1C))
                    elif kind != 0x0C:
                        state.extend([word(cpu, actor + 0x1A, signed=True), word(cpu, actor + 0x1C)])
                records.append([actor, kind, *state])
            lists.append(records)
        actual = {"seed": word(cpu, 0x304A), "free": word(cpu, 0x8E7C), "score": word(cpu, 0x9152),
                  "draw": [draw(sentinel) for sentinel in sentinels], "lists": lists}
        assert actual == expected, ("stage-one foreground pool", mode, case.get("type"), tick, actual, expected)
print("PASS stage-one foreground pool: linked composites, cached bounds and retirement, and a twice-visited recycled shot")
print("PASS stage-one orphan attachment: slot position during flight, after unlinking, and after reuse by a blast")
print("PASS stage-one formation deaths: explosions, globes and pod rewards with free, spent and self-reused slots")
print("PASS stage-one Z: mixed pod, formation, wall-gun and hostile-round dispatch in both main-list orders")
print("PASS saturated stage-one Z: recycled pod reward inherits the saved formation's fatal or flashing hit")
print("PASS saturated stage-one Z: a reward inherits wall-gun or patrol damage, score and death behavior")

for case in native["stageOneFlashes"]:
    cpu = worm_machine()
    mode = case["mode"]
    root = 0x9F4C
    orphan = isinstance(mode, str) and mode.startswith("orphan-")
    retired = mode in ("orphan-round-marked", "orphan-round-free")
    if mode == "formation" or orphan:
        cpu.mem_write((0x349B + LOAD) * 16, pickup_sprite_bank)
        word(cpu, 0x9190, 4300)
        word(cpu, 0x991A, 2 if orphan else 3)
        if orphan:
            for offset, value in [(0x304A, 0x5845), (0x8EB0, 0x100), (0x8EB2, 0x102),
                                  (0x919C, 1), (0x9F12, 300), (0x9F16, 174)]:
                word(cpu, offset, value)
        call(cpu, 0x7637)
        word(cpu, 0xDE30, 0xF100)
        cpu.mem_write(DS + 0xF100, struct.pack("<6h", *case["path"]))
        cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        cpu.reg_write(UC_X86_REG_BX, 7)
        call(cpu, 0x70F1)
        targets = [root, word(cpu, root + 0x46)]
        if orphan:
            free = word(cpu, 0x8E7C)
            word(cpu, 0x8E7C, 0)
            cpu.reg_write(UC_X86_REG_AX, 150)
            cpu.reg_write(UC_X86_REG_BX, 80)
            cpu.reg_write(UC_X86_REG_CX, 2)
            cpu.reg_write(UC_X86_REG_DX, 0)
            cpu.reg_write(UC_X86_REG_BP, word(cpu, 0x8E72))
            call(cpu, 0x1ED3)
            if mode == "orphan-blast":
                cpu.reg_write(UC_X86_REG_AX, 150)
                cpu.reg_write(UC_X86_REG_BX, 80)
                cpu.reg_write(UC_X86_REG_DX, 0x853)
                cpu.reg_write(UC_X86_REG_BP, 0x124C)
                call(cpu, 0x3326)
            elif mode == "orphan-reward":
                source = 0xF200
                word(cpu, source + 0x12, 150)
                word(cpu, source + 0x16, 80)
                word(cpu, source + 0x22, 16)
                cpu.reg_write(UC_X86_REG_DI, source)
                call(cpu, 0x1E61)
            elif mode == "orphan-credit":
                word(cpu, 0xF212, 150)
                word(cpu, 0xF216, 80)
                word(cpu, 0xF234, 0)
                cpu.reg_write(UC_X86_REG_DI, 0xF200)
                call(cpu, 0x3AEC)
            elif mode == "orphan-counted":
                word(cpu, 0x304A, 55)
                cpu.reg_write(UC_X86_REG_CX, 0)
                call(cpu, 0x15E4)
            assert word(cpu, 0x90A0) == root
            word(cpu, 0x8E7C, free)
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
        call(cpu, 0x36FC)
        if orphan:
            cpu.reg_write(UC_X86_REG_SI, root)
            call(cpu, 0x36FC)
            if mode == "orphan-cannon":
                word(cpu, 0x8E7C, 0)
                word(cpu, 0xF212, 150)
                word(cpu, 0xF216, 91)
                cpu.reg_write(UC_X86_REG_SI, 0xF200)
                call(cpu, 0x24C4)
                assert word(cpu, 0x90A0) == root
                word(cpu, 0x8E7C, free)
            if retired:
                cpu.reg_write(UC_X86_REG_SI, root)
                call(cpu, 0x7C0)
                if mode == "orphan-round-free":
                    call(cpu, 0x7A0)

            def shoot(full=False):
                if retired:
                    cpu.reg_write(UC_X86_REG_DI, targets[-1])
                    cpu.reg_write(UC_X86_REG_AX, 1)
                    call(cpu, 0x3A39)
                    return
                x, y = case["fire"]
                call(cpu, 0x1022)
                shot = cpu.reg_read(UC_X86_REG_SI)
                cpu.reg_write(UC_X86_REG_DI, 0x9096)
                call(cpu, 0x77C)
                for offset, value in [(0, 0x10), (2, 0x39EE), (4, 0x853), (0xE, 2),
                                      (0x12, x), (0x16, y), (0x1C, 0), (0x20, 0), (0x34, 0)]:
                    word(cpu, shot + offset, value)
                if full:
                    word(cpu, 0x8E7C, 0)
                call(cpu, 0x39EE)
                assert word(cpu, shot) == (0x60 if full else 4)

            shoot()
        else:
            cpu.reg_write(UC_X86_REG_DI, targets[-1])
            cpu.reg_write(UC_X86_REG_AX, 1)
            call(cpu, 0x3A39)
        flash, normal = 0x8B9, 0x853
    else:
        tiles = (ROOT / "S1/MODS.VGA").read_bytes()
        planes = struct.iter_unpack(">4H", tiles)
        cpu.mem_write(DS + 0x5538, b"".join(struct.pack(">H", a | b | c | d) for a, b, c, d in planes))
        word(cpu, 0x9190, 0)
        call(cpu, 0x758F)
        for tick in range(1, (2 if mode == "arm" else mode) + 1):
            word(cpu, 0x919C, tick)
            cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
            call(cpu, 0x36FC)
        if mode == "arm":
            arm = word(cpu, 0x9054)
            assert word(cpu, arm + 6) == 0x3A99
            cannon = case["cannon"]
            cpu.mem_write((0x349B + LOAD) * 16,
                          base64.b64decode(native["sharedSprites"]) + base64.b64decode(native["weaponSprites"]))
            call(cpu, 0x1022)
            shot = cpu.reg_read(UC_X86_REG_SI)
            cpu.reg_write(UC_X86_REG_DI, 0x9096)
            call(cpu, 0x77C)
            for offset, value in [(0, 0x30), (2, 0x28B8), (4, 0x853), (0xE, 2),
                                  (0xC, cannon["frame"]), (0x12, cannon["x"]), (0x16, cannon["y"])]:
                word(cpu, shot + offset, value)
            call(cpu, 0x28B8)
            assert word(cpu, shot) == 4 and cannon["spent"]
            assert word(cpu, arm) == 0xFC and word(cpu, arm + 4) == 0x853 and case["pixels"] == [[]]
            continue
        else:
            for offset, value in [(0x8EB4, 160), (0x8EB6, 84), (0x8EB8, 160), (0x8EBA, 84)]:
                word(cpu, offset, value)
            cpu.reg_write(UC_X86_REG_DI, root)
            cpu.reg_write(UC_X86_REG_AX, 1)
            call(cpu, 0x714D)
            targets = [root]
            flash, normal = 0x7569, 0x7520
    for actor, expected in zip(targets, case["pixels"], strict=True):
        assert word(cpu, actor + 4) == flash, (mode, hex(actor), hex(word(cpu, actor + 4)))
        if mode == "orphan-round-free" and actor == root:
            assert not expected and actor not in listed_actors(cpu, 0x9096)
            continue
        pixels = flash_pixels(cpu, actor, normal)
        assert set(pixels.values()) == {7}, (mode, hex(actor), set(pixels.values()))
        actual = sorted(y * 320 + x for x, y in pixels if y < 192)
        assert actual == expected, ("stage-one flash", mode, actor, len(actual), len(expected),
                                    sorted(set(actual) ^ set(expected))[:20])
    if orphan:
        shoot(mode == "orphan-round-full")
        lists = []
        for sentinel in (0x904A, 0x9096):
            records = []
            for actor in listed_actors(cpu, sentinel):
                kind = word(cpu, actor)
                state = [] if kind == 4 else [word(cpu, actor + offset, signed=offset != 0xC)
                                              for offset in (0x12, 0x16, 0xC)]
                records.append([actor, kind, *state])
            lists.append(records)
        actual = {"seed": word(cpu, 0x304A), "score": word(cpu, 0x9152), "lists": lists, "count": word(cpu, 0x9164)}
        assert actual == case["death"], ("stage-one orphan hit", mode, actual, case["death"])
print("PASS stage-one hit flashes: composite and boss masks, VGA index 7, draw reset and Cannon spent on unflashed arm")
print("PASS stage-one orphan hits: recycled hostile round and blast share the old root's health, flash, death and reward")
print("PASS stage-one orphan hits: a marked round still flashes, a freed round does not, and both retain damage fields")
print("PASS stage-one orphan hits: pod rewards, ordinary and counted credits, and Cannons retain damage fields")

for case in native["stageOneDronePaint"]:
    cpu = worm_machine()
    formation = case["mode"] == "formation"
    for offset, value in [(0x9190, 4300), (0x91AA, 4316), (0x9198, 0), (0x9F12, 300),
                          (0x9F16, 174), (0xDE30, 0xF100)]:
        word(cpu, offset, value)
    if formation:
        call(cpu, 0x7637)
        word(cpu, 0x8EB0, 0x100)
        word(cpu, 0x8EB2, 0x102)
        cpu.mem_write(DS + 0xF100, struct.pack("<6h", *case["path"]))
    cpu.mem_write(DS + 0xF000, struct.pack("<7H", *case["event"]))
    cpu.reg_write(UC_X86_REG_SI, 0xF000)
    cpu.reg_write(UC_X86_REG_BX, 7)
    call(cpu, 0x70F1 if formation else 0x6F7F)
    cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
    call(cpu, 0x36FC)
    word(cpu, 0x304A, 0x5845)
    cpu.mem_write(DS + 0x9C80, b"\xff" * (80 * 8))
    cpu.mem_write(DS + 0x9C80, struct.pack("<4h", *case["hit"], 0, 0))
    draw = draw_list_trace(cpu)
    for tick, expected in enumerate(case["states"], 2):
        word(cpu, 0x919C, tick)
        for sentinel in (0x904A, 0x9096):
            cpu.reg_write(UC_X86_REG_SI, word(cpu, sentinel + 0xA))
            call(cpu, 0x36FC)
        painted = draw(0x904A) + draw(0x9096)
        tiles = [] if formation else [word(cpu, case["cell"] * 2 + i) >> 6 for i in (0, 2, 40, 42)]
        call(cpu, 0xA95)
        actual = {"painted": painted, "map": tiles, "seed": word(cpu, 0x304A), "score": word(cpu, 0x9152),
                  "spent": word(cpu, 0x9C80, signed=True) < 0,
                  "transient": [[a, *[word(cpu, a + i) for i in (0, 0x12, 0x16, 0xC)]]
                                for a in listed_actors(cpu, 0x9096)]}
        assert actual == expected, ("stage-one lethal Drone paint", case["mode"], tick, actual, expected)
print("PASS stage-one lethal Drone paint: formation sprites and gun tiles survive the impact frame, drops paint next tick")


for case in native["foreground"]:
    cpu = foreground_machine(case["stage"])
    actor = 0xA100
    type_four = case["type"] == 4
    template = 0x9630 if type_four else [0x6285, 0x7736, 0x959A, 0xB028, 0xCC9E][case["stage"] - 1]
    sequence = struct.unpack_from("<H", image, template + 10)[0]
    animation, duration = struct.unpack_from("<HH", image, sequence)
    for offset, value in [(0, 0xC8), (0xC, animation), (0xE, duration), (0x10, sequence + 4),
                          (0x12, case["x"]), (0x16, case["y"]), (0x38, 0xA000), (0x3A, 0xA000),
                          (0x42, 0 if type_four else 3), (0x48, (case["rate"] << 8) | 250)]:
        word(cpu, actor + offset, value)
    cpu.mem_write(DS + 0xA000, struct.pack("<6h", 2, case["heading"], 0, 0, 1000, 0))
    for offset, value in [(0x304A, 0x5845), (0x9F12, 160), (0x9F16, 174)]:
        word(cpu, offset, value)
    cpu.reg_write(UC_X86_REG_BX, 0)
    for tick, expected in enumerate(case["states"]):
        first = word(cpu, 0x90A0)
        cpu.reg_write(UC_X86_REG_SI, actor)
        call(cpu, 0x9A2B if type_four else 0x480B)
        actual = [*fixed_position(cpu, actor), word(cpu, actor + 0x48) & 255, word(cpu, 0x304A),
                  struct.unpack("<h", struct.pack("<H", cpu.reg_read(UC_X86_REG_BX)))[0],
                  word(cpu, actor + 0xC)]
        bullet = word(cpu, 0x90A0)
        if bullet != first:
            actual.append([word(cpu, bullet + offset, signed=True) for offset in (0x12, 0x16, 0x1C)]
                          + [word(cpu, bullet + 0xC)])
        assert actual == expected, (case["stage"], case["type"], case["rate"], tick, actual, expected)
print("PASS corrected foreground firing: 1,600 updates across five stages and six directional entry cases")

for case in native["foregroundBullets"]:
    cpu = foreground_machine(case["stage"])
    for offset, value in [(0x9F0C, 0x077A), (0x9F12, 160), (0x9F16, 174),
                          (0x9186, 39), (0x9198, case["scroll"]), (0x8E80, case["dive"])]:
        word(cpu, offset, value)
    cpu.reg_write(UC_X86_REG_SI, 0x9F00)
    call(cpu, 0x3589)
    for register, value in [(UC_X86_REG_AX, case["x"]), (UC_X86_REG_BX, case["y"]),
                            (UC_X86_REG_CX, case["direction"]), (UC_X86_REG_DX, 6),
                            (UC_X86_REG_BP, word(cpu, 0x8E72))]:
        cpu.reg_write(register, value)
    call(cpu, 0x1ED3)
    bullet = word(cpu, 0x90A0)
    cpu.reg_write(UC_X86_REG_SI, bullet)
    for tick, expected in enumerate(case["states"]):
        call(cpu, 0x1F4D)
        actual = [*fixed_position(cpu, bullet), word(cpu, bullet) == 4,
                  word(cpu, 0x9186), word(cpu, bullet + 0xC)]
        assert actual == expected, (case["stage"], case["direction"], tick, actual, expected)
print("PASS foreground projectiles: 45 flight, culling, dive and sprite-hitbox cases")

for case in native["composites"]:
    stage = case["stage"]
    cpu = foreground_machine(stage)
    paths = (ROOT / f"S{stage}/PATHS.BIN").read_bytes()
    cpu.mem_write(DS + 0xDE30, paths)
    for i, offset in enumerate(struct.unpack_from("<115H", paths)):
        word(cpu, 0xDE30 + i * 2, offset + 0xDF16)
    for offset, value in [(0x9052, 0x904A), (0x9054, 0x904A), (0x304A, 0x5845),
                          (0x9F12, 160), (0x9F16, 174), (0x991A, 1),
                          (0x8EB0, 0x100), (0x8EB2, 0x102)]:
        word(cpu, offset, value)
    call(cpu, {1: 0x7637, 3: 0xACCE, 4: 0xC809}[stage])
    event = case["event"]
    cpu.mem_write(DS + 0xA500, struct.pack("<7H", *event))
    cpu.reg_write(UC_X86_REG_SI, 0xA500)
    cpu.reg_write(UC_X86_REG_BX, event[1])
    call(cpu, {1: 0x70F1, 3: 0xABCC, 4: 0xC771}[stage])
    actors = [0xB000 + i * 0x4C for i in range(len(case["states"][0][1]))]
    for tick, expected in enumerate(case["states"]):
        if tick:
            cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x9054))
            cpu.reg_write(UC_X86_REG_BX, 0)
            call(cpu, 0x36FC)
        actual = [word(cpu, 0x304A), [[*fixed_position(cpu, actor), word(cpu, actor + 0x1C),
                   word(cpu, actor + 0x1A, signed=True), word(cpu, actor + 0x48) & 255,
                   int(word(cpu, actor) in (0, 4)),
                   0 if word(cpu, actor) in (0, 4) else word(cpu, actor + 0xC)] for actor in actors]]
        assert actual == expected, (stage, event, tick, actual, expected)
    if case["death"]:
        next_free = word(cpu, 0x8E7C)
        num_parts = len(actors) // event[2]
        for tail in actors[num_parts - 1::num_parts]:
            cpu.reg_write(UC_X86_REG_DI, tail)
            cpu.reg_write(UC_X86_REG_AX, 127)
            call(cpu, 0x3A39)
        effects, credits = [], []
        for actor in range(next_free, word(cpu, 0x8E7C), 0x4C):
            kind = word(cpu, actor)
            x, y = [word(cpu, actor + offset, signed=True) for offset in (0x12, 0x16)]
            if kind == 12:
                large_frame = struct.unpack_from("<H", image, 0x124C)[0]
                frames = []
                cpu.reg_write(UC_X86_REG_SI, actor)
                for _ in range(10):
                    if word(cpu, actor) == 4:
                        break
                    frames.append(word(cpu, actor + 0xC))
                    call(cpu, 0x3998)
                assert word(cpu, actor) == 4
                effects.append([x, y, frames[0] == large_frame, frames])
            else:
                assert kind in (0x18, 0x60)
                credits.append([x, y, 100 if kind == 0x18 else 50,
                                word(cpu, actor + 0x1A), word(cpu, actor + 0x1C) & 7])
        actual = {"seed": word(cpu, 0x304A), "score": word(cpu, 0x9152),
                  "dead": [word(cpu, actor) == 4 for actor in actors], "effects": effects, "credits": credits}
        assert actual == case["death"], (stage, event, actual, case["death"])
print("PASS six composite formations: construction, independent poses, shared death, score and credit")

for case in native["rewards"]:
    cpu = foreground_machine(1)
    pod = 0xA100
    for offset, value in [(0x12, case["x"]), (0x16, case["y"]), (0x22, case["id"])]:
        word(cpu, pod + offset, value)
    word(cpu, 0x8E80, 1)
    cpu.reg_write(UC_X86_REG_DI, pod)
    call(cpu, 0x1E61)
    reward = word(cpu, 0x90A0)
    cpu.reg_write(UC_X86_REG_SI, reward)
    for tick, expected in enumerate(case["states"]):
        actual = [word(cpu, reward + offset, signed=True) for offset in (0x12, 0x16, 0x1A, 0x1C)]
        actual.append(word(cpu, reward + 0xC))
        assert actual == expected, (case["id"], case["x"], case["y"], tick, actual, expected)
        call(cpu, 0x28DF)
    assert (word(cpu, reward) == 4) == case["removed"], case
print("PASS all 19 pod rewards: animation, center-seeking motion, orbit and expiry from two positions")

for case in native["stageTransitions"]:
    cpu = startup_pool(1)
    skip_calls(cpu, {0xD5F, 0x18F5, 0x193C, 0xF78, 0x5926, 0x5CC5, 0x985, 0x80F, 0xA2F, 0xE2B, 0xD81})
    word(cpu, word(cpu, 0x9136) + 0x34, 2)
    call(cpu, 0x3246)
    for offset, value in [(0x991C, case["stage"]), (0x991A, case["round"]), (0x91B0, 2),
                          (0x9152, 70020), (0x9154, 1), (0x915A, 70245), (0x915C, 1),
                          (0x9F12, 137), (0x9F16, 120), (0x9186, 17), (0x918A, 2),
                          (0x8F5D, 0xFF), (0x8E70, 1)]:
        word(cpu, offset, value)
    cpu.emu_start(LOAD * 16 + 0x40A7, LOAD * 16 + 0x417E, count=100000)
    assert cpu.reg_read(UC_X86_REG_IP) == 0x417E
    actual = [word(cpu, 0x991C), word(cpu, 0x991A), word(cpu, 0x91B0) - 1,
              word(cpu, 0x9152) + (word(cpu, 0x9154) << 16),
              word(cpu, 0x915A) + (word(cpu, 0x915C) << 16),
              word(cpu, 0x9166) + (word(cpu, 0x9168) << 16),
              *[word(cpu, offset) for offset in (0x9F12, 0x9F16, 0x9186, 0x918A)],
              word(cpu, word(cpu, 0x9136) + 0x34),
              *[word(cpu, offset) for offset in (0x9190, 0x91AA, 0x991E)],
              word(cpu, word(cpu, 0x913A) + 0x36) if word(cpu, 0x9138) else 0]
    assert actual == case["state"], (case, actual)
    if case["stage"] == 5:
        assert word(cpu, 0x916A) == 0x94 and word(cpu, 0x916C) == 0 and word(cpu, 0x916E) == 0
print("PASS stage and post-victory transitions: score carry, equipment reset on wrap, wallet and extra continue")

for case in native["protection"]:
    cpu = machine()
    word(cpu, 0x9186, case["energy"])
    word(cpu, 0x9164, case["counted"])
    if case["shield"]:
        call(cpu, 0x2ABE)
    for hit, expected in zip(case["hits"], case["states"]):
        cpu.reg_write(UC_X86_REG_AX, hit)
        call(cpu, 0x3C4F)
        flags = word(cpu, 0x9223)
        assert [word(cpu, 0x9186), bool(flags & 0xFF), bool(flags >> 8)] == expected
    skip_calls(cpu, {0x4A69, 0xE91})
    cpu.emu_start(LOAD * 16 + 0x3FCC, LOAD * 16 + 0x407E, count=100000)
    assert cpu.reg_read(UC_X86_REG_IP) == 0x407E
    assert word(cpu, 0x9223) & 0xFF == 0
print("PASS original Protection: consecutive hits, rounded half damage, fatal boundary and shop reset")

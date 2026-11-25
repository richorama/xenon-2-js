"""Compare the native run screens, shop and equipment with DOS execution."""

import base64
import json
from pathlib import Path
import struct
import subprocess

from unicorn import (Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_CODE, UC_HOOK_INSN, UC_HOOK_INTR,
                     UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE)
from unicorn.x86_const import (
    UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_BP, UC_X86_REG_CS, UC_X86_REG_CX,
    UC_X86_REG_DI, UC_X86_REG_DS, UC_X86_REG_DX, UC_X86_REG_ES, UC_X86_REG_IP,
    UC_X86_REG_SI, UC_X86_REG_SP, UC_X86_REG_SS, UC_X86_INS_OUT,
)

ROOT = Path(__file__).resolve().parent.parent
LOAD = 0x1000
DS = (LOAD + 0x1853) * 16
exe = (ROOT / "XENON2.EXE").read_bytes()
image = bytearray(exe[0x800:])
for index in range(struct.unpack_from("<H", exe, 6)[0]):
    offset, segment = struct.unpack_from("<HH", exe, 0x22 + index * 4)
    position = segment * 16 + offset
    value = struct.unpack_from("<H", image, position)[0]
    struct.pack_into("<H", image, position, (value + LOAD) & 65535)

native = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e", """
import {readFileSync} from 'node:fs';
import {unpack} from './src/formats.js';
import {Game as NativeGame,frameAt} from './src/game.js';
import {ShopScreen} from './src/shop-screen.js';
import {buy,sell,grantReward} from './src/shop.js';
import {cannonFrame,moveLaserBeam,updateCannons,updateLaserAndDrone,
 weaponAttachment,updateWeaponMounts} from './src/weapons.js';
import {loadTestCampaign} from './test/helpers.js';
const a=loadTestCampaign(),scenes=[],stock=[],nashwan=[],beams=[],cannons=[],mounts=[],postureMounts=[],electro=[],bombs=[],flames=[],mines=[],seekers=[];
class Game extends NativeGame {
 start(stage){super.start(stage);this.resetDive();}
}
const runScreens=[];
for(const continues of [0,1,2]){
 const g=new NativeGame(a);g.start();
 g.seed=0x5845;
 g.player.lives=1;
 g.continues=continues;
 g.finishDeath();
 const snapshot=()=>[g.seed,Buffer.from(g.runScreen.pixels).toString('base64')];
 const prompt={},gameover={},attract={};
 for(let frame=1;g.status==='continue';frame++){
  if([1,2,8,9,24,55,79].includes(frame))prompt[frame]=snapshot();
  g.update();
 }
 for(let frame=1;frame<=30;frame++){
  if([1,2,16,30].includes(frame))gameover[frame]=snapshot();
  g.update();
 }
 if(g.status!=='ready')throw Error('Game over did not return to attract mode');
 for(let frame=0;frame<=18;frame++){
  if([0,1,18].includes(frame))attract[frame]=snapshot();
  g.update();
 }
 runScreens.push({continues,prompt,gameover,attract});
}
const readyScreens=[];
for(const [player,checkpoint,stage,startup] of [[1,false,0],[2,false,0],[1,true,0],[1,true,2],[1,true,5],[1,true,1],[1,false,1,true]]){
 const g=new NativeGame(a);g.start(stage===1&&!startup?5:stage>1?stage-1:1,checkpoint?1:2,startup);
 const turn=player===1?g:g.partner;
 if(!startup)turn.seed=0x5845;
 const capture=()=>[turn.seed,Buffer.from(turn.runScreen.pixels).toString('base64')];
 let loading;
 if(stage){
  if(!startup)turn.completeStage(stage);
  loading=capture();
  turn.update();
 } else if(checkpoint)turn.finishDeath();
 else turn.enterTurn();
 const frames=Array.from({length:5},(_,i)=>{
  if(i)turn.update();
  return capture();
 });
 if(!turn.continueRun()||turn.status!=='playing')throw Error('ready confirmation did not resume');
 readyScreens.push({player,checkpoint,stage,loading,frames,seed:turn.seed});
}
const attract=new NativeGame(a);
attract.openAttract();
const attractFrames={};
for(let frame=0;frame<=519;frame++){
 if([0,17,18,35,36,53,54,71,72,90,108,430,431,432,433,517,518,519].includes(frame)){
  attractFrames[frame]=[attract.seed,Buffer.from(attract.runScreen.pixels).toString('base64')];
 }
 attract.update();
}
const menuScreens=[];
for(const inputs of [[16],[1,16,0,16,2,2,1,1,16,1,16]]){
 const g=new NativeGame(a);g.openMenu();
 let music=true;
 const snapshot=()=>[g.seed,Buffer.from(g.runScreen.pixels).toString('base64')];
 const frames=[snapshot()];
 for(const bits of inputs){
  g.update({music});frames.push(snapshot());
  if(bits===1 || bits===2)g.moveMenu(bits===1?-1:1);
  if(bits===16 && g.menuSelection===2)music=!music;
 }
 menuScreens.push({inputs,frames,mode:g.menuSelection+1,music});
}
const scoreScreens=[];
for(const [score,scores] of [
 [0,[]], [0x8000,[]], [200,[900,800,700,600,500,450,400,300,200,100]],
 [10000042,[900,800,700,600,500,450,400,300,200,100]], [null,[]],
]){
 const g=new NativeGame(a);
 if(score!==null)g.start();
 g.highScores.forEach((entry,i)=>{if(scores.length)Object.assign(entry,{score:scores[i],initials:'AB'+i});});
 const initial=g.highScores.map(x=>({...x}));
 g.seed=0x5845;
 if(score===null)g.showScores();
 else {g.score=score;g.player.lives=1;g.finishDeath();}
 const inputs=score===null?[0,0,0,0,0,0,0,0,16]:[4,4,4,4,4,8,8,16,8,8,8,8,8,0,16,4,16,...Array(18).fill(0)];
 const frames={};
 const sample=frame=>{if([0,1,2,5,6,8,9,13,16,17,18,34].includes(frame))
  frames[frame]=[g.seed,Buffer.from(screen.pixels).toString('base64')];};
 const screen=g.runScreen;
 let count=0;
 if(g.status.startsWith('score-')){
  sample(count++);
  for(const input of inputs){
   g.update({left:input===4,right:input===8,confirm:input===16});
   sample(count++);
  }
  if(g.status.startsWith('score-'))throw Error('Score screen did not return');
 }
 scoreScreens.push({score,initial,inputs,frames,count,scores:g.highScores});
}
const sampleSlots=s=>{
 s.game.seed=(0x5845+s.age)&65535;
 s.blink=false;
 for(const slot of s.slots){
  slot.timer=slot.id?3:0;
  if(slot.id)slot.iconFrame=s.age%a.shopArt.icons[slot.id].length-1;
 }
 s.prepareSlots();
};
for(const phase of ['sell','buy'])for(const age of [0,4,8,12,16,20,25,32,40,80,100]){
 const g=new Game(a);g.start();g.credits=1234567;g.openShop(1);
 g.replaceWeapon(5,{id:8,power:2});
 g.replaceWeapon(1,{id:18,power:1});
 g.replaceWeapon(0,{id:14,power:2});
 const s=new ShopScreen(g);s.phase=phase;s.age=age;s.textAge=0;s.message='';s.fillSlots();
 sampleSlots(s);
 scenes.push({phase,age,credits:g.credits,slots:s.slots.map(x=>x.id),pixels:Buffer.from(s.draw()).toString('base64')});
}
for(const message of [a.shopArt.prompts.buy,a.shopArt.prompts.unavailable,
 a.shopArt.labels[6]+a.shopArt.prompts.cost+'600',
 a.shopArt.labels[8]+a.shopArt.prompts.power+'3'+a.shopArt.prompts.sale+'2500']){
 const g=new Game(a);g.start();g.credits=1234567;g.openShop(1);
 const s=new ShopScreen(g);s.phase='buy';s.age=80;s.textAge=1000;s.message=message;s.fillSlots();
 sampleSlots(s);
 scenes.push({phase:'buy',age:80,message,credits:g.credits,slots:s.slots.map(x=>x.id),
  pixels:Buffer.from(s.draw()).toString('base64')});
}
for(const selection of [0,20,21])for(const page of [0,19]){
 const g=new Game(a);g.start(5);g.credits=1234567;g.openShop(5);g.shopBudget=6000;
 const s=new ShopScreen(g);s.phase='buy';s.page=page;s.age=80;s.textAge=0;s.message='';
 s.greetingLine=undefined;
 s.selection=selection;s.fillSlots();
 sampleSlots(s);
 scenes.push({phase:'buy',age:80,selection,credits:g.credits,slots:s.slots.map(x=>x.id),
  pixels:Buffer.from(s.draw()).toString('base64')});
}
for(let mouth=0;mouth<4;mouth++){
 const g=new Game(a);g.start();g.credits=1234567;g.openShop(1);
 const s=new ShopScreen(g);s.phase='buy';s.age=80;s.textAge=0;s.message='';s.mouth=mouth;s.fillSlots();
 sampleSlots(s);
 scenes.push({phase:'buy',age:80,mouth,credits:g.credits,slots:s.slots.map(x=>x.id),
  pixels:Buffer.from(s.draw()).toString('base64')});
}
for(const [profile,power] of [['held',null],['taps',null],['release',null],['held',0],['taps',1],['release',2]]){
 const g=new Game(a);g.start();g.inventory[0]={id:14,power:1};g.credits=100000;
 g.openShop(1);
 if(power===null)buy(g,6);
 else {
  for(const id of [18,18,19])if(!buy(g,id).ok)throw new Error('Cannot equip Laser/Drone');
  for(const weapon of g.inventory.slice(1).filter(Boolean))weapon.power=power;
 }
 g.continueRun();const states=[];
 for(let tick=0;tick<100;tick++){
  g.playerTrail.shift();g.playerTrail.push({x:g.player.x,y:g.player.y});
  g.player.x=140+tick%13;g.player.y=90+tick%17;
  const held=profile==='held'||(profile==='taps'?tick%9<2:tick<12);
  const fire=held&&(profile==='taps'?tick%9===0:tick%(profile==='held'?2:8)===0);
  updateCannons(g,fire);
  updateLaserAndDrone(g,fire,held);
  const shots=g.shots.splice(0);
  const droneShots=g.droneShots.filter(Boolean).map(s=>[s.x,s.y,s.dx,s.dy]);
  g.droneShots.fill(null);
  for(const shot of shots)if(shot.beam)moveLaserBeam(shot);
  states.push({x:g.player.x,y:g.player.y,anchor:g.playerTrail[0],fire,held,
   cannons:g.inventory.filter(w=>w?.id===15).map(w=>cannonFrame(g,w).offset+8),
   lasers:g.inventory.filter(w=>w?.id===18).map(w=>g.weaponFire.get(w).cooldown-1),
   drone:g.weaponFire.get(g.inventory[5]).cooldown,
   shots:shots.map(s=>s.beam
    ?[0x24,s.x-s.beam.inset,s.y,s.beam.length]:[0x30,s.x,s.y,s.frames[0].offset+8]),
   droneShots});
 }
 nashwan.push({profile,power,inventory:g.inventory,states});
}
for(const profile of ['held','taps']){
 const g=new Game(a);g.start();g.credits=100000;g.openShop(1);
 for(let i=0;i<4;i++)if(!buy(g,15).ok)throw new Error('Cannot install cannon');
 g.continueRun();g.inventory[0]=null;
 g.assets={...g.assets,events:[],background:[]};
 g.invincible=1000;
 g.ground=Array.from({length:2},()=>({ground:true,spriteActor:true,health:10000,
  update(){},bounds(){return {x:90,y:12,w:120,h:26};}}));
 const states=[];
 for(let tick=0;tick<100;tick++){
  g.player.x=140+tick%13;g.player.y=65+tick%43;g.sounds=[];
  g.update({fire:profile==='held'||tick%9===0});
  states.push({x:g.player.x,y:g.player.y,fire:g.sounds.includes('shot'),
   mounts:g.inventory.slice(1,5).map((w,i)=>{
    const [x,y]=g.assets.logic.auxiliaryMounts[i];
    return [g.player.x+x,g.player.y+y,cannonFrame(g,w).offset+8];
   }),
   shots:g.shots.map(s=>{
    const b=g.bounds(g.sprite(s.frame),s.x,s.y);
    return [s.x,s.y,s.frame.offset+8,b.x,b.y,b.x+b.w-1,b.y+b.h-1];
   }),
   health:g.ground.map(target=>target.health)});
 }
 cannons.push({profile,states});
}
const equip=g=>g.inventory.map(w=>w?[w.id,w.power]:null);
const resale=[];
for(const extras of [[],[15],[6]]){
 const g=new Game(a);
 g.start();g.credits=50000;g.openShop(1);
 const orders=[21,18,14,14];
 for(const id of orders)if(!buy(g,id).ok)throw Error('Cannot equip resale fixture');
 const screen=new ShopScreen(g);
 const stock=screen.slots.map(({id})=>id);
 if(!sell(g,screen.slots[0].slot).ok)throw Error('Cannot sell resale fixture');
 const sold=[equip(g),g.firePeriod,g.credits];
 for(const id of extras)if(!buy(g,id).ok)throw Error('Cannot finish resale fixture');
 const beforeExit=[equip(g),g.firePeriod,g.credits];
 g.checkpoint.credits=123;
 g.continueRun();
 const saved=equip(g.checkpoint),wallet=g.checkpoint.credits;
 resale.push({orders,extras,stock,sold,beforeExit,saved,wallet});
}
const powerups=[];
for(const [starter,orders] of [[0,[18,8]],[2,[8]]]){
 const g=new Game(a);
 g.start();g.credits=50000;g.openShop(1);
 g.inventory[0].power=starter;
 for(const id of orders)if(!buy(g,id).ok)throw Error('Cannot equip Powerup fixture');
 const before=equip(g);
 const paid=buy(g,12).ok;
 const after=equip(g);
 g.inventory.forEach((weapon,slot)=>{if(weapon)weapon.power=before[slot][1];});
 grantReward(g,6);
 powerups.push({starter,orders,paid,after,reward:equip(g)});
}
const mounted=a.shop.filter(item=>item.mounts&&item.id!==1).map(item=>[item.id]);
for(const orders of [...mounted,[18,17,15,18,17],[17,17,17,17],[21,23,23],[23,23,8,23],
 [8,21,-14],[8,-6],[10,-5],[13,-12],[9,9,13],[13,-9],[20,20,20,20]]){
 const g=new Game(a);
 g.start(); g.credits=100000; g.openShop(1);
 const results=orders.map(id=>{
  if(id<0){grantReward(g,-id-1);return [null,equip(g)];}
  return [buy(g,id).ok,equip(g)];
 });
 g.continueRun();
 const states=[];
 for(let i=0;i<32;i++){
  g.player.x=137+i%23;g.player.y=93+i%19;
  g.playerTrail[0]={x:131+i%23,y:89+i%19};
  const fire=orders.includes(17)&&i%7===0;
  updateWeaponMounts(g,fire);
  const overlays=[];
  const art=g.inventory.map((w,slot)=>{
   if(!w)return null;
   const m=weaponAttachment(g,slot,w);
   if(!m)return null;
   const frame=frameAt(m.frames,m.age);
   if(!g.sprite(frame))throw new Error('Unresolved attachment');
   if(m.overlay)overlays.push([frameAt(m.overlay,m.age).offset+8,m.x,m.y]);
   return [frame.offset+8,m.x,m.y];
  });
  const shots=g.shots.splice(0).map(s=>[s.x,s.y,s.dy,s.frame.offset+8]);
  states.push({player:{...g.player},trail:g.playerTrail[0],fire,art,shots,overlays});
 }
 mounts.push({orders,results,states});
}
for(const orders of [[15,17,18,8],[14,15,17,18,19],[15,17,18,11],[15,17,18,9],[20,15,17,18,13]]){
 const g=new NativeGame(a);g.start();
 g.player.x=160;g.player.y=96;
 g.playerTrail=Array.from({length:3},()=>({x:160,y:96}));
 g.credits=100000;g.openShop(1);
 for(const item of orders)if(!buy(g,item).ok)throw new Error('Cannot equip posture fixture');
 g.continueRun();
 g.camera=g.endCamera=4000;
 g.eventStreamsClosed=true;
 g.shipTouchesTerrain=()=>false;
 if(g.inventory[0]?.id===1)g.inventory[0]=null;
 const pointer=f=>(f.offset+8)|f.bank;
 const states=[];
 for(let tick=0;tick<61;tick++){
  if(tick===46)g.killPlayer();
  const dying=g.status==='dying',deathAge=g.deathAge;
  const fire=!dying&&g.posture>0;
  g.update({fire,dive:tick===11||tick===35,right:tick%16<7,left:tick%16>=9});
  const mounts=g.inventory.map((w,slot)=>{
   const m=w&&weaponAttachment(g,slot,w);
   return m?[pointer(frameAt(m.frames,m.age)),m.x,m.y]:null;
  });
  const overlays=g.inventory.flatMap((w,slot)=>{
   const m=w&&weaponAttachment(g,slot,w);
   return m?.overlay?[[pointer(frameAt(m.overlay,m.age)),m.overlayPosition.x,m.overlayPosition.y]]:[];
  });
  const logic=g.assets.logic;
  const ship=dying?frameAt(logic.playerDeath,deathAge):g.divePose?logic.diveFrames[g.divePose]:logic.playerBank[g.control.bank+6];
  states.push({player:[g.player.x,g.player.y],trail:g.playerTrail[0],
   posture:g.mountPosture,ship:pointer(ship),mounts,overlays,fire,shots:g.shots.length});
 }
 postureMounts.push({orders,states});
}
for(const profile of ['immediate','sweep','boundary','redock']){
 const g=new Game(a);g.start();g.credits=100000;g.openShop(1);
 if(!buy(g,11).ok)throw new Error('Cannot equip Electro Ball');
 g.continueRun();g.inventory[0]=null;
 g.assets={...g.assets,events:[],background:[]};
 g.invincible=1000;
 g.player.x=160;g.player.y=90;
 g.playerTrail=Array.from({length:3},()=>({x:160,y:90}));
 g.ground=Array.from({length:2},()=>({ground:true,spriteActor:true,health:10000,
  update(){},bounds(){return {x:112,y:100,w:100,h:50};}}));
 const states=[];
 for(let tick=0;tick<120;tick++){
  const fire=profile==='immediate'?tick<50||tick>80:profile==='redock'?tick%24>=4&&tick%24!==10:tick>=4&&tick<75;
  const input={fire,right:profile==='boundary'?tick<36:tick%60<27,
   left:profile==='boundary'?tick>=36&&tick<75:tick%60>=30,
   up:profile==='boundary'?tick<30:tick%40<13,down:profile==='boundary'?tick>=37&&tick<80:tick%40>=24};
  const before=[g.player.x,g.player.y];
  g.update(input);
  const ball=g.electroBall,m=weaponAttachment(g,5,g.inventory[5]),frame=frameAt(m.frames,m.age);
  const b=g.bounds(g.sprite(frame),m.x,m.y);
  states.push({before,player:[g.player.x,g.player.y],trail:g.playerTrail[0],fire,
   pose:[m.x,m.y,frame.offset+8,{idle:0,active:1,returning:65535}[ball.phase]],
   box:ball.phase==='active'?[b.x,b.y,b.x+b.w-1,b.y+b.h-1]:null,
   health:g.ground.map(target=>target.health)});
 }
 electro.push({profile,states});
}
for(const [profile,y] of [['rapid',48],['held',96],['taps',174]]){
 const g=new Game(a);g.start();g.credits=100000;g.openShop(1);
 if(!buy(g,21).ok)throw new Error('Cannot equip Bomb');
 g.continueRun();g.inventory[0]=null;
 g.assets={...g.assets,events:[],background:[]};
 g.invincible=1000;
 g.ground=[[112,10,88,18],[130,32,55,17]].map(([x,y,w,h])=>({
  ground:true,spriteActor:true,health:10000,update(){},bounds(){return {x,y,w,h};}
 }));
 const states=[];
 for(let tick=0;tick<120;tick++){
  g.player.x=130+tick%29;g.player.y=y;
  g.sounds=[];
  if(profile==='rapid')g.player.autofire=3;
  g.update({fire:profile!=='taps'||tick%5===0});
  states.push({x:g.player.x,y:g.player.y,fire:g.sounds.includes('shot'),seed:g.seed,
   reload:(g.weaponAges.get(g.inventory[6])||0)-1,
   bombs:g.shots.map(s=>[s.x,s.y,s.fuse,s.frame.offset+8]),
   blasts:g.effects.map(e=>[e.x,e.y,frameAt(e.frames,e.age).offset+8]),
   health:g.ground.map(target=>target.health)});
 }
 bombs.push({profile,states});
}
for(const power of [0,1])for(const profile of ['sweep','tap','repress']){
 const g=new Game(a);g.start();g.credits=100000;g.openShop(1);
 if(!buy(g,power?13:9).ok)throw new Error('Cannot equip Mine');
 g.continueRun();g.inventory[0]=null;
 g.assets={...g.assets,events:[],background:[]};
 g.invincible=1000;
 g.player.x=160;g.player.y=96;
 g.ground=[[0,0,320,80],[0,20,320,56]].map(([x,y,w,h])=>({
  ground:true,spriteActor:true,health:10000,update(){},bounds(){return {x,y,w,h};}
 }));
 const states=[];
 for(let tick=0;tick<160;tick++){
  const fire=profile==='tap'?tick%30<4:profile==='repress'?tick<60||tick>=65&&tick<90:tick<76;
  const right=tick<34||tick>=64&&tick<78,left=tick>=40&&tick<64;
  const down=tick>=34&&tick<44,up=tick>=49&&tick<58;
  g.update({fire,up,down,left,right});
  const m=weaponAttachment(g,5,g.inventory[5]);
  states.push({x:g.player.x,y:g.player.y,seed:g.seed,
   input:(fire?128:0)|(up?1:0)|(down?2:0)|(left?4:0)|(right?8:0),
   pose:[m.x,m.y,g.mine.phase,frameAt(m.frames,m.age).offset+8],
   charges:g.shots.map(s=>[s.x,s.y,s.fuse,s.frame.offset+8]),
   blasts:g.effects.map(e=>[e.x,e.y,frameAt(e.frames,e.age).offset+8]),
   health:g.ground.map(target=>target.health)});
 }
 mines.push({power,profile,states});
}
for(const profile of ['none','moving','blocked']){
 const g=new Game(a);g.start();g.credits=100000;g.openShop(1);
 if(!buy(g,23).ok)throw new Error('Cannot equip Homing Missile');
 g.continueRun();g.inventory[0]=null;
 g.assets={...g.assets,events:[],background:[]};
 g.invincible=1000;
 g.ground=Array.from({length:profile==='none'?0:2},()=>({
  ground:true,spriteActor:true,health:10000,update(){},bounds(){return this.box;}
 }));
 const states=[];
 for(let tick=0;tick<160;tick++){
  g.player.x=160;g.player.y=96;g.sounds=[];
  const fire=profile==='none'?tick%23<4:true;
  const bounds=g.ground.map((target,i)=>{
   const y=profile==='blocked'?96:tick>=34&&tick<48&&!i?-70:30+i*46;
   const x=profile==='blocked'?120+i*60:70+i*145+(tick%30);
   target.box={x,y,w:20,h:18};
   return [x,y,x+19,y+17];
  });
  g.update({fire});
  states.push({x:g.player.x,y:g.player.y,seed:g.seed,bounds,fire:g.sounds.includes('shot'),
   reload:(g.weaponAges.get(g.inventory[5])||0)-1,
   seekers:g.shots.map(s=>[s.x,s.y,s.phase,s.direction,s.frame.offset+8,g.ground.indexOf(s.target)]),
   blasts:g.effects.map(e=>[e.x,e.y,frameAt(e.frames,e.age).offset+8]),
   health:g.ground.map(target=>target.health)});
 }
 seekers.push({profile,states});
}
for(const power of [0,1,2])for(const profile of ['held','taps','release']){
 const g=new Game(a);g.start();g.credits=100000;g.openShop(1);
 if(!buy(g,20).ok)throw new Error('Cannot equip Flamer');
 for(let i=0;i<power;i++)if(!buy(g,12).ok)throw new Error('Cannot upgrade Flamer');
 g.continueRun();
 g.assets={...g.assets,events:[],background:[]};
 g.invincible=1000;
 g.ground=[[112,10,88,18],[130,32,55,17]].map(([x,y,w,h])=>({
  ground:true,spriteActor:true,health:10000,update(){},bounds(){return {x,y,w,h};}
 }));
 const states=[];
 for(let tick=0;tick<120;tick++){
  g.player.x=tick%5<2?140+tick%29:tick%5===2?16:302;
  g.player.y=16+tick*13%150;
  const fire=profile==='held'||(profile==='taps'?tick%5===0:tick%24<14);
  g.update({fire});
  states.push({x:g.player.x,y:g.player.y,fire,seed:g.seed,
   flames:g.shots.map(s=>{
    const b=g.bounds(g.sprite(s.frame),s.x,s.y);
    return {pose:[s.x,s.xFixed&65535,s.y,s.frame.offset+8,s.dxFixed/1024,Number(s.damaging)],
     box:s.damaging?[b.x,b.y,b.x+b.w-1,b.y+b.h-1]:null};
   }),
   health:g.ground.map(target=>target.health)});
 }
 flames.push({power,profile,states});
}
for(const power of [0,1,2])for(const moving of [false,true])for(const initialY of [30,110,190]){
 const g=new Game(a);g.start();
 g.inventory[1]={id:18,power};
 g.player.x=146;g.player.y=initialY-16;
 updateLaserAndDrone(g,true,true);
 const [shot]=g.shots,states=[];
 for(let tick=0;tick<20;tick++){
  if(moving){g.player.x++;g.player.y+=2;}
  updateLaserAndDrone(g,false,false);
  const b=moveLaserBeam(shot);
  states.push({parent:[g.player.x-26,g.player.y+16],x:shot.x-shot.beam.inset,y:shot.y,length:shot.beam.length,
   dead:shot.dead,box:!shot.dead&&b.h?[b.x,b.y,b.x+b.w-1,b.y+b.h-1,shot.damage]:null});
  if(shot.dead)break;
 }
 beams.push({power,initialY,moving,states});
}
for(const stage of [1,3,5])for(const cap of [500,600,2000,6000])for(const credits of [0,599,600,4000,100000])for(const page of [0,19]){
 const g=new Game(a);g.start(stage);g.status='shop';g.shopBudget=cap;g.credits=credits;
 const s=new ShopScreen(g);s.phase='buy';s.page=page;s.fillSlots();
 stock.push({stage,cap,credits,page,actualPage:s.page,slots:s.slots.map(x=>x.id)});
}
const advice=[];
for(const stage of [1,2,3,4,5])for(const returning of [false,true]){
 const g=new NativeGame(a);g.start(stage);g.credits=10000;
 if(returning){g.openShop(stage);g.continueRun();}
 g.openShop(stage);g.randomWord=()=>5;
 const s=new ShopScreen(g);
 for(let frame=0;frame<150&&s.busy;frame++)s.update();
 if(s.busy)throw Error('Shop opening never finished');
 s.phase='buy';s.age=80;s.fillSlots();
 const states=[];
 for(let i=0;i<4;i++){
  const before=g.credits;
  s.activate(0);
  while(s.busy)s.update();
  if(!s.activate(21))throw Error('Missing advice purchase');
  const cash=s.message;
  let winks=0;
  for(let tick=0;tick<60&&s.busy;tick++){s.update();if(s.wink&&!s.blink)winks++;}
  if(s.busy)throw Error('Advice never finished');
  states.push({cash,reply:s.message,cost:before-g.credits,credits:g.credits,winks});
 }
 advice.push({stage,returning,states});
}
const payments=[];
for(const stage of [1,5]){
 const g=new NativeGame(a);g.start(stage);g.credits=10000;g.openShop(stage);
 const s=new ShopScreen(g);
 s.age=80;s.phase='buy';s.greetingLine=undefined;s.fillSlots();
 for(const [i,slot] of s.slots.entries())Object.assign(slot,{id:i===1?3:0,timer:i===1?8:0});
 const {cash,room}=s.art.prompts;
 const crop=()=>{
  const pixels=s.draw();
  return Buffer.concat(Array.from({length:42},(_,row)=>
   pixels.subarray((118+row)*320+220,(118+row)*320+300))).toString('base64');
 };
 const sample=()=>{
  const frames=[];
  for(let i=0;i<60&&s.busy;i++){
   s.update();
   if(s.busy)frames.push([g.seed,s.mouth,s.blink,s.brow,g.credits,g.player.speed]);
  }
  if(s.busy)throw Error('Purchase dialogue never finished');
  return {frames,pixels:crop()};
 };
 g.seed=0x5845;
 s.activate(1);
 const quote=sample();
 g.seed=0x5845;s.browTicks=0;s.slots[1].timer=8;
 if(!s.activate(21)||s.message!==cash||g.credits!==10000||g.player.speed!==0)throw Error('Payment ordering');
 const payment=sample();
 g.player.speed=2;
 s.activate(1);sample();
 g.seed=0x5845;s.browTicks=0;s.slots[1].timer=8;
 if(s.activate(21)||s.message!==room)throw Error('Unexpected successful purchase');
 const denied={credits:g.credits,...sample()};
 payments.push({stage,quote,payment,denied});
}
const shutters=[];
{
 const g=new NativeGame(a);g.start();g.credits=10000;g.openShop(1);
 const s=new ShopScreen(g);
 s.age=80;s.setMessage('');s.browTicks=0;
 g.seed=0x5845;
 s.activate(20);
 const frames=[],intro=[];
 const face=()=>[g.seed,s.mouth,s.blink,s.brow];
 const crop=(x,y,w,h)=>{
  const pixels=s.draw();
  return Buffer.concat(Array.from({length:h},(_,row)=>
   pixels.subarray((y+row)*320+x,(y+row)*320+x+w))).toString('base64');
 };
 for(let i=0;i<60&&s.busy;i++){
  s.update();
  if(s.transition!==undefined){
   frames.push({face:face(),timer:s.hatchTimer,ids:s.slots.map(slot=>slot.id),phase:s.phase,
    pixels:crop(4,4,32,28),actions:crop(4,168,73,23)});
  }else if(s.busy)intro.push(face());
 }
 if(s.busy||s.phase!=='buy')throw Error('Shutter transition never reached buying');
 shutters.push({frames,intro,credits:g.credits,budget:g.shopBudget,pixels:crop(220,118,80,42)});
}
const shopEntry=[];
for(const victory of [false,true]){
 const g=new NativeGame(a);g.start(victory?5:1);g.credits=10000;
 if(victory)g.beginVictory();else g.openShop(1);
 g.seed=0x5845;
 const s=new ShopScreen(g),frames=[];
 while(s.handFrame===undefined&&frames.length<50){
  frames.push({face:[g.seed,s.mouth,s.blink,s.brow],timer:s.hatchTimer,pixels:Buffer.from(s.draw()).toString('base64')});
  s.update();
 }
 shopEntry.push({victory,frames});
}
const shopExit=[];
for(const victory of [false,true]){
 const g=new NativeGame(a);g.start(victory?5:1);g.credits=10000;
 if(victory)g.beginVictory();else g.openShop(1);
 const s=new ShopScreen(g);
 s.age=80;
 if(victory){
  s.setMessage(s.art.ending[2]);s.exitFrame=0;
 }else{
  s.phase='buy';s.fillSlots();s.setMessage(s.art.prompts.buy);s.activate(20);
 }
 s.textAge=100;
 g.seed=0x5845;
 const crop=(x,y,w,h)=>Buffer.concat(Array.from({length:h},(_,row)=>
  s.pixels.subarray((y+row)*320+x,(y+row)*320+x+w))).toString('base64');
 const frames=[],ending=[];
 while(g.status===(victory?'ending':'shop')&&s.exitFrame<280){
  s.update();
  s.draw();
  if(s.exitFrame<=47){
   frames.push({face:[g.seed,s.mouth,s.blink,s.brow],timer:s.hatchTimer,status:g.status,
    hatch:crop(4,4,32,28),shutters:crop(208,0,112,182)});
  }
  if(victory&&s.exitFrame>=47&&g.status==='ending'){
   const cross=s.pixels[101*320+165]===7;
   const phase=ending[cross?0:1]??={ticks:0,pixels:crop(0,0,320,200)};
   phase.ticks++;
  }
 }
 shopExit.push({victory,frames,ending,status:g.status});
}
const victoryDialogue=[];
{
 const g=new NativeGame(a);g.start(5);g.beginVictory();
 const s=new ShopScreen(g);
 s.age=80;g.seed=0x5845;
 while(s.exitFrame===undefined&&victoryDialogue.length<120){
  s.update();s.draw();
  victoryDialogue.push({face:[g.seed,s.mouth,s.blink,s.brow],
   text:Buffer.concat(Array.from({length:63},(_,row)=>
    s.pixels.subarray((118+row)*320+220,(118+row)*320+300))).toString('base64')});
 }
}
const greeting=[];
{
 const g=new NativeGame(a);g.start(5);g.credits=10000;g.openShop(5);
 const s=new ShopScreen(g);
 for(let i=0;i<75;i++)s.update();
 g.seed=0x5845;
 s.browTicks=0;
 for(let i=0;i<100&&s.busy;i++){
  s.update();
  if(!s.busy)break;
  if(greeting.at(-1)?.message!==s.message)greeting.push({message:s.message,frames:[]});
  const entry=greeting.at(-1),pixels=s.draw();
  entry.frames.push([g.seed,s.mouth,s.blink,s.brow]);
  entry.pixels=Buffer.concat(Array.from({length:42},(_,row)=>
   pixels.subarray((118+row)*320+220,(118+row)*320+300))).toString('base64');
 }
 if(s.busy||s.phase!=='sell')throw Error('Stage five greeting never reached the sell menu');
}
const hand=[];
{
 const g=new NativeGame(a);g.start();g.openShop(1);
 const s=new ShopScreen(g);
 for(let i=0;i<40;i++)s.update();
 g.seed=0x5845;
 while(hand.length<50){
  s.update();
  if(s.handFrame===undefined)break;
  s.pixels.fill(9);
  s.drawHand();
  hand.push({seed:g.seed,blink:s.blink,brow:s.brow,pixels:Buffer.concat(Array.from({length:60},(_,row)=>
   s.pixels.subarray((80+row)*320+256,(81+row)*320))).toString('base64')});
 }
}
const saleQuotes=[];
for(const [id,power] of [[15,0],[18,2]]){
 const g=new NativeGame(a);g.start();g.credits=10000;g.openShop(1);
 g.replaceWeapon(1,{id,power});
 const s=new ShopScreen(g);
 s.age=80;s.slots[0].timer=8;g.seed=0x5845;
 s.activate(0);
 const frames=[],hand=[];
 const amount=s.saleQuote.amount;
 const crop=(x,y,w,h)=>Buffer.concat(Array.from({length:h},(_,row)=>
  s.pixels.subarray((y+row)*320+x,(y+row)*320+x+w))).toString('base64');
 while(s.busy&&frames.length<100){
  s.update();
  if(!s.busy)break;
  frames.push([g.seed,s.mouth,s.blink,s.brow]);
  if(s.saleQuote.frame<47){
   s.pixels.fill(9);s.drawHand();
   hand.push(crop(224,64,64,52));
  }
 }
 if(s.busy||hand.length!==47)throw Error('Sale quote never finished');
 s.draw();
 saleQuotes.push({id,power,amount,frames,hand,pixels:crop(220,118,80,42)});
}
const flicker=[];
{
 const g=new NativeGame(a);g.start(5);g.credits=1234567;g.openShop(5);g.shopBudget=6000;
 const s=new ShopScreen(g);s.phase='buy';s.age=80;s.greetingLine=undefined;s.setMessage('');
 s.fillSlots();
 g.seed=0x5845;
 s.slots.forEach((slot,i)=>slot.timer=4+i%11);
 for(let i=0;i<48;i++){
  const repage=i===22?19:i===43?0:undefined;
  if(repage!==undefined){s.page=repage;s.fillSlots();}
  s.update();
  let pixels;
  if([0,1,2,3,7,10,21,22,23,26,42,43,47].includes(i)){
   s.pixels.fill(0);s.drawSlots();
   pixels=Buffer.concat([0,1,6,19].flatMap(index=>{
    const x=4+index%5*41,y=4+Math.floor(index/5)*41;
    return Array.from({length:28},(_,row)=>s.pixels.subarray((y+row)*320+x,(y+row)*320+x+32));
   })).toString('base64');
  }
  flicker.push({repage,pixels,seed:g.seed,slots:s.slots.map(({id,timer,iconFrame})=>[id,timer,iconFrame])});
 }
}
console.log(JSON.stringify({scenes,stock,advice,payments,shutters,shopEntry,shopExit,victoryDialogue,greeting,hand,saleQuotes,flicker,nashwan,beams,cannons,mounts,resale,powerups,postureMounts,electro,bombs,flames,mines,seekers,runScreens,readyScreens,scoreScreens,
 attractFrames,menuScreens,frontPalette:a.runScreenArt.frontPalette,
 graphics:Buffer.from(unpack(readFileSync('GR.DAT'))).toString('base64'),
 sprites:Buffer.concat(['X2SPR.DAT','X2WEAPS.DAT','SHOP.DAT'].map(f=>Buffer.from(unpack(readFileSync(f))))).toString('base64')}));
""",
], cwd=ROOT, text=True))


def word(cpu, offset, value=None):
    if value is not None:
        cpu.mem_write(DS + offset, struct.pack("<H", value & 65535))
    return struct.unpack("<H", cpu.mem_read(DS + offset, 2))[0]


def call(cpu, address, count=2000000):
    cpu.reg_write(UC_X86_REG_CS, LOAD)
    cpu.reg_write(UC_X86_REG_DS, LOAD + 0x1853)
    cpu.reg_write(UC_X86_REG_ES, LOAD + 0x1853)
    cpu.reg_write(UC_X86_REG_SP, 0xFFFC)
    cpu.mem_write(0x9FFFC, b"\x00\xff")
    cpu.emu_start(LOAD * 16 + address, 0x1FF00, count=count)
    ip = cpu.reg_read(UC_X86_REG_IP)
    assert ip == 0xFF00, (hex(address), hex(cpu.reg_read(UC_X86_REG_CS)), hex(ip))


def machine(vga=False, color_care=0):
    cpu = Uc(UC_ARCH_X86, UC_MODE_16)
    cpu.mem_map(0, 0x100000)
    cpu.mem_write(LOAD * 16, bytes(image))
    cpu.reg_write(UC_X86_REG_SS, 0x9000)
    cpu.mem_write(0x90010, b"\xc7\x00")
    if not vga:
        return cpu, None
    cpu.mem_write((LOAD + 0x2824) * 16, base64.b64decode(native["graphics"]))
    cpu.mem_write((LOAD + 0x349B) * 16, base64.b64decode(native["sprites"]))
    planes = [bytearray(65536) for _ in range(4)]
    registers = [0] * 9
    registers[7] = color_care
    registers[8] = 255
    state = {"mask": 15, "seq": 0, "gc": 0}
    latches = [0] * 4

    def out(_cpu, port, size, value, _data):
        if port in (0x3C4, 0x3CE):
            key = "seq" if port == 0x3C4 else "gc"
            state[key] = value & 255
            if size == 2:
                out(_cpu, port + 1, 1, value >> 8, _data)
        elif port == 0x3C5 and state["seq"] == 2:
            state["mask"] = value
        elif port == 0x3CF and state["gc"] < 9:
            registers[state["gc"]] = value

    def read(uc, _access, address, size, _value, _data):
        values = bytearray()
        for offset in range(address - 0xA0000, address - 0xA0000 + size):
            for plane in range(4):
                latches[plane] = planes[plane][offset]
            if registers[5] & 8:
                result = 255
                for plane in range(4):
                    if registers[7] & (1 << plane):
                        result &= ~(latches[plane] ^ (255 if registers[2] & (1 << plane) else 0)) & 255
                values.append(result)
            else:
                values.append(latches[registers[4] & 3])
        uc.mem_write(address, bytes(values))

    def write(_cpu, _access, address, size, value, _data):
        for index in range(size):
            offset = address - 0xA0000 + index
            byte = (value >> (index * 8)) & 255
            rotation = registers[3] & 7
            byte = ((byte >> rotation) | (byte << (8 - rotation))) & 255
            mode = registers[5] & 3
            for plane in range(4):
                if not state["mask"] & (1 << plane):
                    continue
                if mode == 1:
                    planes[plane][offset] = latches[plane]
                    continue
                mask = registers[8]
                source = byte
                if mode == 2:
                    source = 255 if byte & (1 << plane) else 0
                elif mode == 3 or registers[1] & (1 << plane):
                    source = 255 if registers[0] & (1 << plane) else 0
                if mode == 3:
                    mask &= byte
                operation = (registers[3] >> 3) & 3
                if operation == 1:
                    source &= latches[plane]
                elif operation == 2:
                    source |= latches[plane]
                elif operation == 3:
                    source ^= latches[plane]
                planes[plane][offset] = (source & mask) | (latches[plane] & (~mask & 255))

    cpu.hook_add(UC_HOOK_INSN, out, None, 1, 0, UC_X86_INS_OUT)
    cpu.hook_add(UC_HOOK_MEM_READ, read, begin=0xA0000, end=0xAFFFF)
    cpu.hook_add(UC_HOOK_MEM_WRITE, write, begin=0xA0000, end=0xAFFFF)
    word(cpu, 0x4259, 0x2000)
    word(cpu, 0x425B, 0)
    word(cpu, 0x3044, 0)
    return cpu, planes


def hook_run_frames(cpu, compare):
    flip = 0xF290 + 0x131E
    def run_screen_frame(uc, address, _size, _data):
        offset = address - LOAD * 16
        sp = uc.reg_read(UC_X86_REG_SP)
        uc.reg_write(UC_X86_REG_IP, struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0])
        uc.reg_write(UC_X86_REG_SP, sp + 2)
        if offset != flip:
            return
        uc.reg_write(UC_X86_REG_CS, struct.unpack("<H", uc.mem_read(0x90002 + sp, 2))[0])
        uc.reg_write(UC_X86_REG_SP, sp + 4)
        page = word(uc, 0x425B)
        word(uc, 0x425B, word(uc, 0x4259))
        word(uc, 0x4259, page)
        compare(page)

    for offset in (0xD81, 0x5950, flip):
        cpu.hook_add(UC_HOOK_CODE, run_screen_frame, begin=LOAD * 16 + offset, end=LOAD * 16 + offset)


def compare_run_frame(cpu, planes, page, expected, label):
    if expected is None:
        return
    pixels = bytes(sum((1 << plane) for plane in range(4)
                       if planes[plane][page + i // 8] & (0x80 >> (i & 7)))
                   for i in range(64000))
    wanted = base64.b64decode(expected[1])
    mismatch = sum(a != b for a, b in zip(pixels, wanted))
    first = next((i for i in range(len(pixels)) if pixels[i] != wanted[i]), 0)
    assert not mismatch, (label, mismatch, (first % 320, first // 320), pixels[first], wanted[first])
    assert word(cpu, 0x304A) == expected[0], (label, word(cpu, 0x304A), expected[0])


def frontend_machine():
    cpu, planes = machine(True, color_care=15)
    word(cpu, 0x3044, 3)
    word(cpu, 0x304A, 0x5845)
    palette_writes = []

    def bios(uc, number, _data):
        ax = uc.reg_read(UC_X86_REG_AX)
        if number == 0x80:
            assert ax >> 8 in (1, 2)
            return
        assert number == 0x10 and ax == 0x1012, (number, hex(ax))
        if uc.reg_read(UC_X86_REG_BX):
            return
        assert uc.reg_read(UC_X86_REG_CX) == 16
        dac = uc.mem_read(DS + uc.reg_read(UC_X86_REG_DX), 48)
        palette = [[round(rgb * 255 / 63) for rgb in dac[i:i + 3]] for i in range(0, 48, 3)]
        assert palette == native["frontPalette"]
        palette_writes.append(True)

    cpu.hook_add(UC_HOOK_INTR, bios)
    return cpu, planes, palette_writes


for case in native["runScreens"]:
    cpu, planes, palette_writes = frontend_machine()
    word(cpu, 0x91B0, case["continues"])
    word(cpu, 0x33BC, 0)
    counts = {"continue": -1, "gameover": 0, "attract": -1}
    screen = "continue"

    def compare(page):
        counts[screen] += 1
        frames = case["prompt" if screen == "continue" else screen]
        compare_run_frame(cpu, planes, page, frames.get(str(counts[screen])),
                          (screen, case["continues"], counts[screen]))
        if screen == "attract" and counts[screen] == 18:
            cpu.mem_write(DS + 0x8F5B, b"\xff")

    def trace_game_over(uc, address, _size, _data):
        global screen
        offset = address - LOAD * 16
        if offset == 0x5863:
            screen = "attract"
        elif offset == 0x3CC2:
            uc.reg_write(UC_X86_REG_IP, 0xFF00)
        else:
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)

    hook_run_frames(cpu, compare)
    if case["continues"]:
        call(cpu, 0x5C0F, count=10000000)
        assert counts["continue"] == 79
    screen = "gameover"
    word(cpu, 0x8E6A, 0xFFFC)
    word(cpu, 0x8E7A, case["continues"] & 1)
    word(cpu, 0x8F5D, 1 << (8 * (case["continues"] & 1)))
    for offset in (0xD5F, 0x5863, 0x3CC2):
        cpu.hook_add(UC_HOOK_CODE, trace_game_over, begin=LOAD * 16 + offset, end=LOAD * 16 + offset)
    call(cpu, 0x3F7B, count=10000000)
    assert counts["gameover"] == 30 and counts["attract"] == 18 and palette_writes
print("PASS original continue, game over and attract return: 35 full VGA frames and shared RNG")


for case in native["readyScreens"]:
    player, frames, stage = case["player"], case["frames"], case["stage"]
    cpu, planes, palette_writes = frontend_machine()
    current = iter(enumerate([case["loading"], *frames] if stage else frames, 0 if stage else 1))

    def compare(page):
        index, expected = next(current)
        compare_run_frame(cpu, planes, page, expected, ("ready" if index else "loading", player, stage, index))
        if index == len(frames):
            cpu.mem_write(DS + 0x8F5B, b"\xff")

    hook_run_frames(cpu, compare)
    if stage:
        cpu.mem_write(DS + 0x3550, str(stage).encode("ascii"))
        call(cpu, 0x5B10)
    if case["checkpoint"]:
        word(cpu, 0x8E7A, 0)
        word(cpu, 0x9162, 0)
        cpu.mem_write(DS + 0x916A, bytes(28))

        def skip_display_restore(uc, _address, _size, _data):
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)

        cpu.hook_add(UC_HOOK_CODE, skip_display_restore, begin=LOAD * 16 + 0xD5F, end=LOAD * 16 + 0xD5F)
        call(cpu, 0x195B)
        assert word(cpu, 0x374E) & 255 == 0
    else:
        cpu.mem_write(DS + 0x374E, b"\xff")
        cpu.mem_write(DS + 0x3727, str(player).encode("ascii"))
        cpu.reg_write(UC_X86_REG_SI, 0x3715)
        call(cpu, 0x5926)
    assert word(cpu, 0x304A) == case["seed"]
    assert word(cpu, 0x8F5B) & 255 == 0
    assert next(current, None) is None and palette_writes
print("PASS original loading and get-ready scenes: 39 VGA frames, shared RNG and ready fire latch")


cpu, planes, palette_writes = frontend_machine()
frames = native["attractFrames"]
attract_count = 0
attract_end = max(map(int, frames)) + 1


def compare_attract(page):
    global attract_count
    compare_run_frame(cpu, planes, page, frames.get(str(attract_count)), ("attract", attract_count))
    attract_count += 1
    if attract_count == attract_end:
        cpu.mem_write(DS + 0x8F5B, b"\xff")


hook_run_frames(cpu, compare_attract)
call(cpu, 0x5863, count=24000000)
assert attract_count == attract_end and palette_writes
print("PASS original attract loop: 18 full VGA frames across the logo, credits, high scores and restart; DAC and RNG match")

for case in native["menuScreens"]:
    cpu, planes, palette_writes = frontend_machine()
    cpu.mem_write(DS + 0x8F54, b"\xff")
    current = iter(enumerate(case["frames"]))

    def compare_menu(page):
        index, expected = next(current)
        compare_run_frame(cpu, planes, page, expected, ("menu", case["mode"], index))
        if index:
            bits = case["inputs"][index - 1]
            cpu.mem_write(DS + 0x8F59, bytes([bits & 3]))
            cpu.mem_write(DS + 0x8F5B, bytes([int(bits == 16)]))

    hook_run_frames(cpu, compare_menu)
    call(cpu, 0x5B21)
    assert next(current, None) is None and palette_writes
    assert word(cpu, 0x8E70) == case["mode"]
    assert bool(cpu.mem_read(DS + 0x8F54, 1)[0]) == case["music"]
print("PASS original selection menu: 15 full VGA frames, both player choices, option wrap and music toggle")


for case in native["scoreScreens"]:
    cpu, planes, palette_writes = frontend_machine()
    for i, entry in enumerate(case["initial"]):
        cpu.mem_write(DS + 0x3567 + i * 4, struct.pack("<I", entry["score"]))
        cpu.mem_write(DS + 0x3593 + i * 15, f"{entry['score']:07d} {entry['initials']}".encode("ascii"))
    counts = {"frames": 0, "inputs": 0}

    def score_input(uc, _address, _size, _data):
        index = counts["inputs"]
        counts["inputs"] += 1
        assert index < len(case["inputs"]), ("unexpected score input", case["score"], index)
        bits = case["inputs"][index]
        uc.mem_write(DS + 0x8F59, bytes([bits & 12]))
        uc.mem_write(DS + 0x8F5B, bytes([int(bits == 16)]))

    def compare(page):
        index = counts["frames"]
        counts["frames"] += 1
        compare_run_frame(cpu, planes, page, case["frames"].get(str(index)), ("scores", case["score"], index))

    cpu.hook_add(UC_HOOK_CODE, score_input, begin=LOAD * 16 + 0xB3F, end=LOAD * 16 + 0xB3F)
    hook_run_frames(cpu, compare)
    if case["score"] is None:
        call(cpu, 0x5935)
        call(cpu, 0x59AA)
    else:
        cpu.mem_write(DS + 0x9152, struct.pack("<I", case["score"]))
        call(cpu, 0x59C8, count=10000000)
    assert counts["frames"] == case["count"] and bool(palette_writes) == bool(case["count"]), (
        case["score"], counts, case["count"])
    for i, entry in enumerate(case["scores"]):
        assert struct.unpack("<I", cpu.mem_read(DS + 0x3567 + i * 4, 4))[0] == entry["score"]
        assert cpu.mem_read(DS + 0x359B + i * 15, 3).decode("ascii") == entry["initials"]
print("PASS original scores: ranking, ties, qualification, initials repeat, timed hold and 31 full VGA frames")


def skip_faces(cpu, address, _size, _data):
    if address != LOAD * 16 + 0x561C:
        return
    sp = cpu.reg_read(UC_X86_REG_SP)
    ip = struct.unpack("<H", cpu.mem_read(0x90000 + sp, 2))[0]
    cpu.reg_write(UC_X86_REG_SP, sp + 2)
    cpu.reg_write(UC_X86_REG_IP, ip)


def intercept_damage(uc, address, _size, _data):
    if address == LOAD * 16 + 0xFE10:
        target = uc.reg_read(UC_X86_REG_DI)
        word(uc, target + 0x24, word(uc, target + 0x24) - uc.reg_read(UC_X86_REG_AX))
    elif address != LOAD * 16 + 0x0F96:
        return
    sp = uc.reg_read(UC_X86_REG_SP)
    uc.reg_write(UC_X86_REG_IP, struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0])
    uc.reg_write(UC_X86_REG_SP, sp + 2)


def shop_mount_cpu():
    cpu, _ = machine()
    for actor in range(0xA400, 0xF000, 0x4C):
        word(cpu, actor + 8, actor + 0x4C)
    word(cpu, 0x8E7C, 0xA400)
    for sentinel in (0x8FFE, 0x9096):
        word(cpu, sentinel, 0)
        word(cpu, sentinel + 8, sentinel)
        word(cpu, sentinel + 0xA, sentinel)
    for index in range(14):
        word(cpu, 0x9134 + index * 2, 0)
    call(cpu, 0x2BCC)
    return cpu


def installed(cpu):
    return [word(cpu, slot + 2) if word(cpu, slot) else 0 for slot in range(0x9134, 0x9150, 4)]


def equipment_state(cpu):
    return [[word(cpu, actor + 0x36), word(cpu, actor + 0x34)] if actor else None
            for actor in installed(cpu)]


for case in native["resale"]:
    cpu = shop_mount_cpu()
    word(cpu, 0x915A, 50000)
    starter = word(cpu, 0x9136)

    def buy_item(item):
        word(cpu, 0x915A, word(cpu, 0x915A) - word(cpu, 0x38CE + item * 2))
        call(cpu, word(cpu, 0x381A + item * 2))

    for item in case["orders"]:
        buy_item(item)
    # The starter was replaced in an earlier shop and retired on return to flight.
    assert word(cpu, starter) == 4
    cpu.reg_write(UC_X86_REG_SI, starter)
    call(cpu, 0x7A0)
    call(cpu, 0x5119)
    stock = [word(cpu, 0x3CBC + 12 * i) for i in range(20)]
    assert stock == case["stock"], (stock, case)

    def finish_sale(uc, address, _size, _data):
        if address == LOAD * 16 + 0x516F:
            uc.reg_write(UC_X86_REG_IP, 0xFF00)
        else:
            sp = uc.reg_read(UC_X86_REG_SP)
            uc.reg_write(UC_X86_REG_IP, struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0])
            uc.reg_write(UC_X86_REG_SP, sp + 2)

    for offset in (0x516F, 0x577D, 0x576D, 0x5787):
        cpu.hook_add(UC_HOOK_CODE, finish_sale, begin=LOAD * 16 + offset, end=LOAD * 16 + offset)
    item, actor = word(cpu, 0x3CBC), word(cpu, 0x3CC0)
    word(cpu, 0x39B2, (word(cpu, 0x38CE + 2 * item) + 2000 * word(cpu, actor + 0x34)) >> 1)
    word(cpu, 0x39B4, 0x3CB6)
    call(cpu, 0x51DC)
    assert word(cpu, actor) == 4 and word(cpu, 0x3CBC) == 0
    assert [equipment_state(cpu), word(cpu, 0x9130), word(cpu, 0x915A)] == case["sold"], case
    for item in case["extras"]:
        buy_item(item)
    assert [equipment_state(cpu), word(cpu, 0x9130), word(cpu, 0x915A)] == case["beforeExit"], case

    word(cpu, 0x9166, 123)
    word(cpu, 0x8F61, 1)
    call(cpu, 0x4B9B)
    assert equipment_state(cpu) == case["saved"] and word(cpu, 0x9166) == case["wallet"], case
    for slot, expected in enumerate(case["saved"]):
        tag = word(cpu, 0x9134 + slot * 4)
        assert word(cpu, 0x916A + slot * 4) == tag
        assert word(cpu, 0x916C + slot * 4) == (expected[1] if expected else 0)
print("PASS original resale order, front sale, Cannon/exit starter and saved loadout before Nashwan")


for case in native["powerups"]:
    cpu = shop_mount_cpu()
    word(cpu, word(cpu, 0x9136) + 0x34, case["starter"])
    for item in case["orders"]:
        call(cpu, word(cpu, 0x381A + item * 2))
    word(cpu, 0x39B4, 0xF000)
    word(cpu, 0xF006, 12)
    call(cpu, 0x4FE3)
    # CS:50d8 skips the rear-only upgrade; browsers use the actual recipient scan instead.
    assert (cpu.reg_read(UC_X86_REG_AX) != 0) == (case["starter"] == 0), case
    call(cpu, word(cpu, 0x31D8 + 6 * 2) & ~1)
    assert case["paid"] and equipment_state(cpu) == case["after"] == case["reward"], case
print("PASS original Powerup target selection and normalized shop eligibility for a rear-only upgrade")


for case in native["mounts"]:
    cpu = shop_mount_cpu()
    for item, (ok, expected) in zip(case["orders"], case["results"]):
        if item < 0:
            call(cpu, word(cpu, 0x31D8 + (-item - 1) * 2) & ~1)
        else:
            word(cpu, 0x39B4, 0xF000)
            word(cpu, 0xF006, item)
            call(cpu, 0x4FE3)
            allowed = cpu.reg_read(UC_X86_REG_AX) != 0
            assert allowed == ok, (case["orders"], item, allowed, ok)
            if allowed:
                call(cpu, word(cpu, 0x381A + item * 2))
        actual = equipment_state(cpu)
        assert actual == expected, (case["orders"], item, actual, expected)

    equipment = installed(cpu)
    for tick, state in enumerate(case["states"]):
        for offset, value in [(0x9F12, state["player"]["x"]), (0x9F16, state["player"]["y"]),
                              (0x8EBC, state["trail"]["x"]), (0x8EBE, state["trail"]["y"])]:
            word(cpu, offset, value)
        actual = []
        for actor in equipment:
            # Only the launcher consumes fire here; the cannon traces below check firing separately.
            fire = actor and word(cpu, actor + 0x36) == 17 and state["fire"]
            cpu.mem_write(DS + 0x8FAE, bytes([255 if fire else 0]))
            if actor:
                cpu.reg_write(UC_X86_REG_SI, actor)
                call(cpu, word(cpu, actor + 2))
            actual.append([word(cpu, actor + off) for off in (0xC, 0x12, 0x16)]
                          if actor and word(cpu, actor + 4) == 0x853 else None)
        assert actual == state["art"], (case["orders"], tick, actual, state["art"])
        shots, overlays = [], []
        actor = word(cpu, 0x90A0)
        while actor != 0x9096:
            next_actor = word(cpu, actor + 0xA)
            cpu.reg_write(UC_X86_REG_SI, actor)
            kind = word(cpu, actor)
            if kind == 0x40:
                call(cpu, word(cpu, actor + 2))
                if word(cpu, actor) == 0x40:
                    overlays.append([word(cpu, actor + off) for off in (0xC, 0x12, 0x16)])
            else:
                assert kind == 0x10
                shots.append([word(cpu, actor + 0x12), word(cpu, actor + 0x16),
                              word(cpu, actor + 0x20) - 65536, word(cpu, actor + 0xC)])
                call(cpu, 0x07A0)
            actor = next_actor
        assert sorted(shots) == sorted(state["shots"]), (case["orders"], tick, shots, state["shots"])
        assert sorted(overlays) == sorted(state["overlays"]), (case["orders"], tick, overlays, state["overlays"])
print(f"PASS {len(native['mounts'])} equipment loadouts: eligibility, slots, anchors, "
      "visible sprites and launch frames against original execution")

for case in native["postureMounts"]:
    cpu, _ = machine(True)
    for actor in range(0xA400, 0xF000, 0x4C):
        word(cpu, actor + 8, actor + 0x4C)
    word(cpu, 0x8E7C, 0xA400)
    for sentinel in (0x8FFE, 0x9096):
        cpu.reg_write(UC_X86_REG_SI, sentinel)
        call(cpu, 0x762)
    cpu.mem_write(DS + 0x9134, bytes(28))
    for offset, value in [(0x9F12, 160), (0x9F16, 96), (0x8EBC, 160), (0x8EBE, 96)]:
        word(cpu, offset, value)
    cpu.mem_write(DS + 0x8FAE, b"\x00")
    cpu.mem_write(DS + 0x8F59, b"\x00")
    for item in case["orders"]:
        call(cpu, word(cpu, 0x381A + item * 2))
    cpu.mem_write(DS + 0x9C80, b"\xff" * 640)
    equipment = [word(cpu, slot + 2) if word(cpu, slot) else 0
                 for slot in range(0x9134, 0x9150, 4)]
    if equipment[0] and word(cpu, equipment[0] + 0x36) == 1:
        equipment[0] = 0  # The basic gun uses dive phase, not mount posture.

    def mount_pose(actor):
        return [word(cpu, actor + 0xC),
                *[struct.unpack("<h", cpu.mem_read(DS + actor + offset, 2))[0] for offset in (0x12, 0x16)]]

    for tick, state in enumerate(case["states"]):
        for offset, value in [(0x9F12, state["player"][0]), (0x9F16, state["player"][1]),
                              (0x9F0C, state["ship"]), (0x991E, state["posture"]),
                              (0x8EBC, state["trail"]["x"]), (0x8EBE, state["trail"]["y"])]:
            word(cpu, offset, value)
        cpu.mem_write(DS + 0x8FAE, bytes([255 if state["fire"] else 0]))
        cpu.mem_write(DS + 0x8F59, bytes([128 if state["fire"] else 0]))
        poses = []
        for actor in equipment:
            if actor:
                cpu.reg_write(UC_X86_REG_SI, actor)
                call(cpu, word(cpu, actor + 2))
            poses.append(mount_pose(actor) if actor and word(cpu, actor + 4) == 0x853 else None)
        assert poses == state["mounts"], (case["orders"], tick, state["posture"], poses, state["mounts"])
        overlays = []
        actor = word(cpu, 0x90A0)
        while actor != 0x9096:
            assert word(cpu, actor) == 0x40, (case["orders"], tick, state["posture"], hex(word(cpu, actor)))
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
            if word(cpu, actor + 4) == 0x853:
                overlays.append(mount_pose(actor))
            actor = word(cpu, actor + 0xA)
        assert sorted(overlays) == sorted(state["overlays"]), (case["orders"], tick, overlays, state["overlays"])
        assert word(cpu, 0x9C80) == 65535 and state["shots"] == 0, (case["orders"], tick)
print("PASS weapon mount posture: 305 original pose, overlay and held-fire updates")


for case in native["electro"]:
    cpu, _ = machine(True)
    for actor in range(0xA400, 0xF000, 0x4C):
        word(cpu, actor + 8, actor + 0x4C)
    word(cpu, 0x8E7C, 0xA400)
    for sentinel in (0x8FFE, 0x9096, 0x904A):
        word(cpu, sentinel, 0)
        word(cpu, sentinel + 8, sentinel)
        word(cpu, sentinel + 0xA, sentinel)
    for index in range(14):
        word(cpu, 0x9134 + index * 2, 0)
    targets = [0xA000, 0xA04C]
    word(cpu, 0x9054, targets[0])
    for target, next_actor in zip(targets, (targets[1], 0x904A)):
        for offset, value in [(0, 0x140), (6, 0xFE10), (0xA, next_actor), (0x24, 10000),
                              (0x28, 112), (0x2A, 100), (0x2C, 211), (0x2E, 149)]:
            word(cpu, target + offset, value)

    word(cpu, 0x9F12, 160)
    word(cpu, 0x9F16, 90)
    call(cpu, 0x2F08)
    actor = word(cpu, 0x914A)
    cpu.hook_add(UC_HOOK_CODE, intercept_damage)
    for tick, state in enumerate(case["states"]):
        for offset, value in zip((0x8F34, 0x8F36), state["before"]):
            word(cpu, offset, value)
        for offset, value in zip((0x9F12, 0x9F16), state["player"]):
            word(cpu, offset, value)
        word(cpu, 0x8EBC, state["trail"]["x"])
        word(cpu, 0x8EBE, state["trail"]["y"])
        cpu.mem_write(DS + 0x8F59, bytes([128 if state["fire"] else 0]))
        cpu.reg_write(UC_X86_REG_SI, actor)
        call(cpu, word(cpu, actor + 2))
        pose = [word(cpu, actor + offset) for offset in (0x12, 0x16, 0xC, 0x1A)]
        assert pose == state["pose"], (case["profile"], tick, pose, state["pose"])
        if state["box"]:
            box = list(struct.unpack("<4h", cpu.mem_read(DS + actor + 0x28, 8)))
            assert box == state["box"], (case["profile"], tick, box, state["box"])
        health = [word(cpu, p + 0x24) for p in targets]
        assert health == state["health"], (case["profile"], tick, health, state["health"])
    print(f"PASS Electro Ball/{case['profile']}: 120 ticks of animation, steering, return and first-target damage")


for case in native["bombs"]:
    cpu, _ = machine(True)
    for actor in range(0xA400, 0xF000, 0x4C):
        word(cpu, actor + 8, actor + 0x4C)
    word(cpu, 0x8E7C, 0xA400)
    for sentinel in (0x8FFE, 0x9096, 0x904A):
        word(cpu, sentinel, 0)
        word(cpu, sentinel + 8, sentinel)
        word(cpu, sentinel + 0xA, sentinel)
    for index in range(14):
        word(cpu, 0x9134 + index * 2, 0)
    targets = [0xA000, 0xA04C]
    word(cpu, 0x9054, targets[0])
    for target, next_actor, bounds in zip(targets, (targets[1], 0x904A),
                                           ((112, 10, 199, 27), (130, 32, 184, 48))):
        for offset, value in [(0, 0x140), (6, 0xFE10), (0xA, next_actor), (0x24, 10000),
                              *zip((0x28, 0x2A, 0x2C, 0x2E), bounds)]:
            word(cpu, target + offset, value)
    word(cpu, 0x304A, 0x5845)
    call(cpu, 0x2D2A)
    mount = word(cpu, 0x914E)
    cpu.hook_add(UC_HOOK_CODE, intercept_damage)
    for tick, state in enumerate(case["states"]):
        word(cpu, 0x9F12, state["x"])
        word(cpu, 0x9F16, state["y"])
        cpu.mem_write(DS + 0x8FAE, bytes([255 if state["fire"] else 0]))
        cpu.reg_write(UC_X86_REG_SI, mount)
        call(cpu, word(cpu, mount + 2))
        actor = word(cpu, 0x90A0)
        while actor != 0x9096:
            next_actor = word(cpu, actor + 0xA)
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
            if word(cpu, actor) == 4:
                cpu.reg_write(UC_X86_REG_SI, actor)
                call(cpu, 0x07A0)
            actor = next_actor
        actual = {0x28: [], 0x0C: []}
        actor = word(cpu, 0x90A0)
        while actor != 0x9096:
            kind = word(cpu, actor)
            position = list(struct.unpack("<2h", cpu.mem_read(DS + actor + 0x12, 2)
                                          + cpu.mem_read(DS + actor + 0x16, 2)))
            if kind == 0x28:
                position.append(struct.unpack("<h", cpu.mem_read(DS + actor + 0x1A, 2))[0])
            actual[kind].append(position + [word(cpu, actor + 0xC)])
            actor = word(cpu, actor + 0xA)
        context = (case["profile"], tick)
        assert actual[0x28] == state["bombs"], (context, actual[0x28], state["bombs"])
        assert sorted(actual[0x0C]) == sorted(state["blasts"]), (context, actual[0x0C], state["blasts"])
        assert word(cpu, 0x304A) == state["seed"], context
        assert word(cpu, mount + 0x48) == state["reload"] & 65535, context
        assert [word(cpu, p + 0x24) for p in targets] == state["health"], context
    print(f"PASS Bomb/{case['profile']}: 120 ticks of ascent, fuse, reload, blast positions, animation and damage")

for case in native["mines"]:
    cpu, _ = machine(True)
    for actor in range(0xA400, 0xF000, 0x4C):
        word(cpu, actor + 8, actor + 0x4C)
    word(cpu, 0x8E7C, 0xA400)
    for sentinel in (0x8FFE, 0x9096, 0x904A):
        word(cpu, sentinel, 0)
        word(cpu, sentinel + 8, sentinel)
        word(cpu, sentinel + 0xA, sentinel)
    for index in range(14):
        word(cpu, 0x9134 + index * 2, 0)
    targets = [0xA000, 0xA04C]
    word(cpu, 0x9054, targets[0])
    for target, next_actor, bounds in zip(targets, (targets[1], 0x904A), ((0, 0, 319, 79), (0, 20, 319, 75))):
        for offset, value in [(0, 0x140), (6, 0xFE10), (0xA, next_actor), (0x24, 10000),
                              *zip((0x28, 0x2A, 0x2C, 0x2E), bounds)]:
            word(cpu, target + offset, value)
    for address, value in [(0x304A, 0x5845), (0x9F12, 160), (0x9F16, 96), (0x8E86, 0), (0x991E, 0)]:
        word(cpu, address, value)
    call(cpu, 0x3004 if case["power"] else 0x2F7C)
    mount = word(cpu, 0x914A)
    kind = word(cpu, mount)
    cpu.hook_add(UC_HOOK_CODE, intercept_damage)
    for tick, state in enumerate(case["states"]):
        word(cpu, 0x9F12, state["x"])
        word(cpu, 0x9F16, state["y"])
        cpu.mem_write(DS + 0x8F59, bytes([state["input"]]))
        cpu.reg_write(UC_X86_REG_SI, mount)
        call(cpu, 0x2697)
        pose = [word(cpu, mount + offset) for offset in (0x12, 0x16, 0x1A, 0xC)]
        actor = word(cpu, 0x90A0)
        while actor != 0x9096:
            next_actor = word(cpu, actor + 0xA)
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
            if word(cpu, actor) == 4:
                cpu.reg_write(UC_X86_REG_SI, actor)
                call(cpu, 0x07A0)
            actor = next_actor
        actual = {kind: [], 0x0C: []}
        actor = word(cpu, 0x90A0)
        while actor != 0x9096:
            actor_kind = word(cpu, actor)
            x, _, y = struct.unpack("<3h", cpu.mem_read(DS + actor + 0x12, 6))
            frame = word(cpu, actor + 0xC)
            entry = [x, y, frame]
            if actor_kind == kind:
                entry.insert(2, struct.unpack("<h", cpu.mem_read(DS + actor + 0x1A, 2))[0])
            actual[actor_kind].append(entry)
            actor = word(cpu, actor + 0xA)
        context = (case["power"], case["profile"], tick)
        assert pose == state["pose"], (context, pose, state["pose"])
        assert actual[kind] == state["charges"], (context, actual[kind], state["charges"])
        assert sorted(actual[0x0C]) == sorted(state["blasts"]), (context, actual[0x0C], state["blasts"])
        assert word(cpu, 0x304A) == state["seed"], context
        assert [word(cpu, p + 0x24) for p in targets] == state["health"], context
    print(f"PASS Mine/power {case['power']}/{case['profile']}: 160 ticks of flight, deployment, fuses and blasts")

for case in native["seekers"]:
    cpu, _ = machine(True)
    for actor in range(0xA400, 0xF000, 0x4C):
        word(cpu, actor + 8, actor + 0x4C)
    word(cpu, 0x8E7C, 0xA400)
    for sentinel in (0x8FFE, 0x9096, 0x904A):
        word(cpu, sentinel, 0)
        word(cpu, sentinel + 8, sentinel)
        word(cpu, sentinel + 0xA, sentinel)
    cpu.mem_write(DS + 0x9134, bytes(28))
    targets = [0xA000, 0xA04C] if case["profile"] != "none" else []
    word(cpu, 0x9054, targets[0] if targets else 0x904A)
    for target, next_actor in zip(targets, (0xA04C, 0x904A)):
        for offset, value in [(0, 0x140), (6, 0xFE10), (0xA, next_actor), (0x24, 10000), (0x26, 0)]:
            word(cpu, target + offset, value)
    for address, value in [(0x304A, 0x5845), (0x8F32, len(targets)), (0x8E80, 0)]:
        word(cpu, address, value)
    cpu.mem_write(DS + 0x9224, b"\0")
    call(cpu, 0x2D86)
    mount = word(cpu, 0x914A)
    cpu.hook_add(UC_HOOK_CODE, intercept_damage)
    for tick, state in enumerate(case["states"]):
        word(cpu, 0x9F12, state["x"])
        word(cpu, 0x9F16, state["y"])
        for target, bounds in zip(targets, state["bounds"]):
            cpu.mem_write(DS + target + 0x28, struct.pack("<4h", *bounds))
        cpu.mem_write(DS + 0x8FAE, bytes([255 if state["fire"] else 0]))
        cpu.reg_write(UC_X86_REG_SI, mount)
        call(cpu, 0x3900)
        actor = word(cpu, 0x90A0)
        while actor != 0x9096:
            next_actor = word(cpu, actor + 0xA)
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
            if word(cpu, actor) == 4:
                cpu.reg_write(UC_X86_REG_SI, actor)
                call(cpu, 0x07A0)
            actor = next_actor
        shots, blasts = [], []
        actor = word(cpu, 0x90A0)
        while actor != 0x9096:
            x, _, y = struct.unpack("<3h", cpu.mem_read(DS + actor + 0x12, 6))
            frame = word(cpu, actor + 0xC)
            if word(cpu, actor) == 0x48:
                phase, direction = struct.unpack("<2h", cpu.mem_read(DS + actor + 0x1A, 4))
                target = word(cpu, actor + 0x22)
                shots.append([x, y, phase, direction, frame, targets.index(target) if target else -1])
            else:
                blasts.append([x, y, frame])
            actor = word(cpu, actor + 0xA)
        context = (case["profile"], tick)
        assert shots == state["seekers"], (context, shots, state["seekers"])
        assert sorted(blasts) == sorted(state["blasts"]), (context, blasts, state["blasts"])
        assert word(cpu, mount + 0x48) == state["reload"] & 65535, context
        assert word(cpu, 0x304A) == state["seed"], context
        assert [word(cpu, p + 0x24) for p in targets] == state["health"], context
    print(f"PASS Homing Missile/{case['profile']}: 160 ticks of launch, pause, lock, steering and impact")

for case in native["flames"]:
    cpu, _ = machine(True)
    for actor in range(0xA400, 0xF000, 0x4C):
        word(cpu, actor + 8, actor + 0x4C)
    word(cpu, 0x8E7C, 0xA400)
    for sentinel in (0x8FFE, 0x9096, 0x904A):
        word(cpu, sentinel, 0)
        word(cpu, sentinel + 8, sentinel)
        word(cpu, sentinel + 0xA, sentinel)
    for index in range(14):
        word(cpu, 0x9134 + index * 2, 0)
    targets = [0xA000, 0xA04C]
    word(cpu, 0x9054, targets[0])
    for target, next_actor, bounds in zip(targets, (targets[1], 0x904A),
                                           ((112, 10, 199, 27), (130, 32, 184, 48))):
        for offset, value in [(0, 0x140), (6, 0xFE10), (0xA, next_actor), (0x24, 10000),
                              *zip((0x28, 0x2A, 0x2C, 0x2E), bounds)]:
            word(cpu, target + offset, value)
    word(cpu, 0x304A, 0x5845)
    call(cpu, 0x2DF0)
    mount = word(cpu, 0x9136)
    word(cpu, mount + 0x34, case["power"])
    cpu.hook_add(UC_HOOK_CODE, intercept_damage)

    def flamer_sound(uc, interrupt, _data):
        assert interrupt == 0x80 and uc.reg_read(UC_X86_REG_AX) >> 8 == 0x11
        uc.reg_write(UC_X86_REG_AX, 0x1101)

    cpu.hook_add(UC_HOOK_INTR, flamer_sound)
    for tick, state in enumerate(case["states"]):
        word(cpu, 0x9F12, state["x"])
        word(cpu, 0x9F16, state["y"])
        cpu.mem_write(DS + 0x8F59, bytes([128 if state["fire"] else 0]))
        cpu.reg_write(UC_X86_REG_SI, mount)
        call(cpu, word(cpu, mount + 2))
        actual = []
        actor = word(cpu, 0x90A0)
        while actor != 0x9096:
            next_actor = word(cpu, actor + 0xA)
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
            if word(cpu, actor) == 4:
                cpu.reg_write(UC_X86_REG_SI, actor)
                call(cpu, 0x07A0)
            else:
                assert word(cpu, actor) == 0xB4
                pose = [word(cpu, actor + off) for off in (0x12, 0x14, 0x16, 0xC, 0x1C, 0x22)]
                if pose[4] >= 32768:
                    pose[4] -= 65536
                box = list(struct.unpack("<4h", cpu.mem_read(DS + actor + 0x28, 8))) if pose[-1] else None
                actual.append({"pose": pose, "box": box})
            actor = next_actor
        context = (case["power"], case["profile"], tick)
        assert actual == state["flames"], (context, actual, state["flames"])
        assert word(cpu, 0x304A) == state["seed"], context
        assert [word(cpu, p + 0x24) for p in targets] == state["health"], context
    print(f"PASS Flamer/{case['power'] + 1}/{case['profile']}: 120 ticks of poses, lifetime, RNG and damage")


for case in native["cannons"]:
    cpu, _ = machine(True)
    for actor in range(0xA400, 0xF000, 0x4C):
        word(cpu, actor + 8, actor + 0x4C)
    word(cpu, 0x8E7C, 0xA400)
    for sentinel in (0x8FFE, 0x9096, 0x904A):
        word(cpu, sentinel, 0)
        word(cpu, sentinel + 8, sentinel)
        word(cpu, sentinel + 0xA, sentinel)
    for index in range(8):
        word(cpu, 0x9138 + index * 2, 0)
    for _ in range(4):
        call(cpu, 0x3246)
    equipment = [word(cpu, 0x913A + i * 4) for i in range(4)]
    while word(cpu, 0x90A0) != 0x9096:
        cpu.reg_write(UC_X86_REG_SI, word(cpu, 0x90A0))
        call(cpu, 0x07A0)
    targets = [0xA000, 0xA04C]
    word(cpu, 0x9054, targets[0])
    for target, next_actor in zip(targets, (targets[1], 0x904A)):
        for offset, value in [(0, 0x140), (6, 0xFE10), (0xA, next_actor), (0x24, 10000),
                              (0x28, 90), (0x2A, 12), (0x2C, 209), (0x2E, 37)]:
            word(cpu, target + offset, value)

    cpu.hook_add(UC_HOOK_CODE, intercept_damage)
    for index, state in enumerate(case["states"]):
        word(cpu, 0x9F12, state["x"])
        word(cpu, 0x9F16, state["y"])
        cpu.mem_write(DS + 0x8FAE, bytes([255 if state["fire"] else 0]))
        for actor in equipment:
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
        mounts = [[word(cpu, actor + off) for off in (0x12, 0x16, 0xC)] for actor in equipment]
        assert mounts == state["mounts"], (case["profile"], index, mounts, state["mounts"])
        actor = word(cpu, 0x90A0)
        shots = []
        while actor != 0x9096:
            next_actor = word(cpu, actor + 0xA)
            assert word(cpu, actor) == 0x30, (case["profile"], index, hex(actor), word(cpu, actor))
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
            if word(cpu, actor) == 4:
                cpu.reg_write(UC_X86_REG_SI, actor)
                call(cpu, 0x07A0)
            else:
                shots.append([word(cpu, actor + off) for off in (0x12, 0x16, 0xC)]
                             + list(struct.unpack("<4h", cpu.mem_read(DS + actor + 0x28, 8))))
            actor = next_actor
        assert sorted(shots) == sorted(state["shots"]), (case["profile"], index, shots, state["shots"])
        health = [word(cpu, target + 0x24) for target in targets]
        assert health == state["health"], (case["profile"], index, health, state["health"])
    print(f"PASS Cannon/{case['profile']}: four paid mounts, 100 firing ticks, animated rounds, bounds and damage")


for case in native["nashwan"]:
    power = case["power"]
    cpu, _ = machine(True)
    for actor in range(0xA400, 0xF000, 0x4C):
        word(cpu, actor + 8, actor + 0x4C)
    word(cpu, 0x8E7C, 0xA400)
    for sentinel in (0x8FFE, 0x9096):
        word(cpu, sentinel, 0)
        word(cpu, sentinel + 8, sentinel)
        word(cpu, sentinel + 0xA, sentinel)
    for index in range(14):
        word(cpu, 0x9134 + index * 2, 0)
    original = 0xA000
    for offset, value in [(0, 0xC0), (2, 0x761), (4, 0x853), (6, 0x9134),
                           (8, 0x8FFE), (0xA, 0x8FFE), (0x24, 2), (0x34, 1), (0x36, 14)]:
        word(cpu, original + offset, value)
    word(cpu, 0x9006, original)
    word(cpu, 0x9008, original)
    word(cpu, 0x9134, 0xC0)
    word(cpu, 0x9136, original)
    if power is None:
        call(cpu, 0x2B22)
    else:
        for item in (18, 18, 19):
            call(cpu, word(cpu, 0x381A + item * 2))
        for offset in range(0x913A, 0x914E, 4):
            actor = word(cpu, offset)
            if actor:
                word(cpu, actor + 0x34, power)
    equipment = [word(cpu, 0x9136 + i * 4) if word(cpu, 0x9134 + i * 4) else 0
                 for i in range(7)]
    assert [{"id": word(cpu, p + 0x36), "power": word(cpu, p + 0x34)} if p else None
            for p in equipment] == case["inventory"]
    cannons = [p for p in equipment if p and word(cpu, p + 0x36) == 15]
    lasers = [p for p in equipment if p and word(cpu, p + 0x36) == 18]
    spawned = []

    def nashwan_hook(uc, address, _size, _data):
        if address == LOAD * 16 + 0x077C and uc.reg_read(UC_X86_REG_DI) == 0x9096:
            spawned.append(uc.reg_read(UC_X86_REG_SI))
        if address in (LOAD * 16 + 0x465C, LOAD * 16 + 0x1C4F):
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)

    cpu.hook_add(UC_HOOK_CODE, nashwan_hook)
    cpu.ctl_remove_cache(0, 0xFFFFF)
    for tick, state in enumerate(case["states"]):
        spawned.clear()
        for i in range(80):
            word(cpu, 0x9C80 + i * 8, 0xFFFF)
        for offset, value in [(0x9F12, state["x"]), (0x9F16, state["y"]),
                              (0x8EBC, state["anchor"]["x"]), (0x8EBE, state["anchor"]["y"])]:
            word(cpu, offset, value)
        cpu.mem_write(DS + 0x8FAE, bytes([255 if state["fire"] else 0]))
        cpu.mem_write(DS + 0x8F59, bytes([128 if state["held"] else 0]))
        for actor in filter(None, equipment[1:6]):
            cpu.reg_write(UC_X86_REG_SI, actor)
            call(cpu, word(cpu, actor + 2))
        assert [word(cpu, p + 0xC) for p in cannons] == state["cannons"], (case["profile"], tick)
        assert [word(cpu, p + 0x48) for p in lasers] == [x & 65535 for x in state["lasers"]]
        assert word(cpu, equipment[5] + 0x1A) == state["drone"]
        for actor in spawned:
            if word(cpu, actor) == 0x24:
                cpu.reg_write(UC_X86_REG_SI, actor)
                call(cpu, 0x23ED)
        actual = [[word(cpu, p), word(cpu, p + 0x12), word(cpu, p + 0x16),
                   word(cpu, p + 0x1A) if word(cpu, p) == 0x24 else word(cpu, p + 0xC)] for p in spawned]
        assert actual == state["shots"], (case["profile"], tick, actual, state["shots"])
        actual_drone = [list(struct.unpack("<4h", cpu.mem_read(DS + 0x9C80 + i * 8, 8)))
                        for i in range(80) if word(cpu, 0x9C80 + i * 8) != 65535]
        assert actual_drone == state["droneShots"], (case["profile"], tick, actual_drone, state["droneShots"])
    if power is not None:
        print(f"PASS paid Laser/Drone power {power + 1}/{case['profile']}: 100 ticks of pulses, holds and launch geometry")
        continue
    word(cpu, 0x9162, 170)
    for tick in range(170):
        call(cpu, 0x46E4)
        assert word(cpu, 0x9162) == 169 - tick
        if tick < 169:
            assert word(cpu, 0x9136) != original
    assert word(cpu, 0x9136) == original and word(cpu, original + 0x34) == 1
    print(f"PASS Nashwan/{case['profile']}: seven mounts, 100 firing ticks, 170-tick expiry and saved loadout")


for case in native["stock"]:
    cpu, _ = machine()
    word(cpu, 0x991C, case["stage"])
    word(cpu, 0x8F4A, case["cap"])
    word(cpu, 0x915A, case["credits"])
    word(cpu, 0x915C, case["credits"] >> 16)
    word(cpu, 0x3816, case["page"])
    call(cpu, 0x4D38)
    actual = [word(cpu, 0x3CBC + i * 12) for i in range(20)]
    assert actual == case["slots"], (case, actual)
    assert word(cpu, 0x3816) == case["actualPage"]
print(f"PASS {len(native['stock'])} original shop stock/page states across three stages and four caps")


for case in native["advice"]:
    cpu, _ = machine()
    word(cpu, 0x991C, case["stage"])
    word(cpu, 0x915A, 10000)
    word(cpu, 0x915C, 0)
    word(cpu, 0x39B4, 0x3CB6)
    word(cpu, 0x3CBC, 2)
    call(cpu, 0x4BC0 if case["returning"] else 0x1B3C)
    dialogue, eyes = [], []

    def trace_advice(uc, address, _size, _data):
        offset = address - LOAD * 16
        if offset == 0x4E93:
            uc.reg_write(UC_X86_REG_IP, 0xFF00)
            return
        if offset == 0x5787:
            text = bytes(uc.mem_read(DS + uc.reg_read(UC_X86_REG_SI), 100)).split(b"\0", 1)[0].decode("ascii")
            dialogue.append((text, word(uc, 0x3AE0) & 255))
        elif offset == 0x875:
            eyes.append(uc.reg_read(UC_X86_REG_SI))
        elif offset == 0x4191:
            uc.reg_write(UC_X86_REG_AX, 4)
        sp = uc.reg_read(UC_X86_REG_SP)
        ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
        uc.reg_write(UC_X86_REG_SP, sp + 2)
        uc.reg_write(UC_X86_REG_IP, ip)

    for offset in (0x4E93, 0x576D, 0x5787, 0x577D, 0x4E29, 0x875, 0x4191):
        cpu.hook_add(UC_HOOK_CODE, trace_advice, begin=LOAD * 16 + offset, end=LOAD * 16 + offset)
    cost = word(cpu, 0x38CE + 2 * 2) >> (case["stage"] == 5)
    for purchase, state in enumerate(case["states"]):
        dialogue.clear()
        assert cost == state["cost"]
        word(cpu, 0x39B2, cost)
        call(cpu, 0x4F2D)
        assert dialogue == [(state["cash"], 0), (state["reply"], 12)], (case["stage"], case["returning"], purchase)
        assert word(cpu, 0x915A) == state["credits"]
        assert word(cpu, 0x3AE0) & 255 == 0
    word(cpu, 0x3ADf, 0)
    word(cpu, 0x3AE1, 0)
    word(cpu, 0x3AE0, dialogue[-1][1])
    for _ in range(13):
        call(cpu, 0x561C)
    assert eyes == [0xE9F8] * case["states"][-1]["winks"], (case["stage"], case["returning"], eyes)
print("PASS original shop advice: 40 purchases across both visits in all five stages, cash, charges and one-eye wink")


for selling in (False, True):
    cpu, _ = machine()
    empty, repeat, action = (0x5177, 0x516F, 0x51DC) if selling else (0x4E9B, 0x4E93, 0x4F27)
    for selected, expected in ((1, repeat), (0, action), (21, action)):
        word(cpu, 0x8F42, selected % 5)
        word(cpu, 0x8F44, selected // 5)
        word(cpu, 0x3818, 0)
        word(cpu, 0x381A, 0)
        word(cpu, 0x39B2, 500)
        word(cpu, 0x3CC8, 0)
        result = []

        def finish_selection(uc, address, _size, _data):
            result.append(address - LOAD * 16)
            uc.reg_write(UC_X86_REG_IP, 0xFF00)

        hooks = [cpu.hook_add(UC_HOOK_CODE, finish_selection, begin=LOAD * 16 + offset, end=LOAD * 16 + offset)
                 for offset in (repeat, action)]
        call(cpu, empty)
        assert result == [expected] and word(cpu, 0x39B2) == 500
        for hook in hooks:
            cpu.hook_del(hook)
print("PASS original shop confirmation branches: quoted slot, action button and preserved quote on an empty slot")


def trace_shop_face(cpu, forced=False, left_brow=False):
    cpu.mem_write(DS + 0x3ADF, bytes([255 if forced else 0, 0, 0]))
    word(cpu, 0x8F3C, 0)
    word(cpu, 0x8F3E, 0)
    word(cpu, 0x8F40, 0)
    word(cpu, 0x304A, 0x5845)
    face = {}
    sprites = {0x563B: "right_eye", 0x5647: "left_eye", 0x5681: "right_brow", 0x568D: "left_brow"}
    mouth_draw = 0xF290 + 0x1B3A

    def trace(uc, address, _size, _data):
        offset = address - LOAD * 16
        if offset == 0xC93:
            face.clear()
        elif offset == mouth_draw:
            face["mouth"] = (uc.reg_read(UC_X86_REG_SI) - 0x91C0) // 0x770
        else:
            face[sprites[offset]] = True

    for offset in (0xC93, mouth_draw, *sprites):
        cpu.hook_add(UC_HOOK_CODE, trace, begin=LOAD * 16 + offset, end=LOAD * 16 + offset)

    def snapshot():
        blink = face.get("right_eye", False)
        brow = face.get("right_brow", False)
        assert blink == face.get("left_eye", False)
        if left_brow:
            assert not brow and face.get("left_brow", False)
        else:
            assert brow == face.get("left_brow", False)
        return [word(cpu, 0x304A), face["mouth"], blink, brow]

    return snapshot


for case in native["payments"]:
    for phase in ("quote", "payment", "denied"):
        expected = case[phase]
        cpu, planes = machine(True)
        purchase_face = trace_shop_face(cpu)
        entry = 0x3CC2
        credits = expected.get("credits", 10000)
        cost = word(cpu, 0x38CE + 3 * 2) >> (case["stage"] == 5)
        word(cpu, 0x991C, case["stage"])
        word(cpu, 0x915A, credits)
        word(cpu, 0x915C, 0)
        word(cpu, 0x915E, 2 if phase == "denied" else 0)
        word(cpu, entry, 8)
        word(cpu, entry + 6, 3)
        word(cpu, entry + 8, word(cpu, 0x3898 + 3 * 2))
        word(cpu, 0x39B2, cost)
        word(cpu, 0x39B4, entry)
        cpu.reg_write(UC_X86_REG_AX, 3)
        cpu.reg_write(UC_X86_REG_SI, entry)
        frames = []

        def purchase_trace(uc, address, _size, _data):
            offset = address - LOAD * 16
            if offset == 0x4E93:
                uc.reg_write(UC_X86_REG_IP, 0xFF00)
            elif offset in (0x57A6, 0x580C):
                frames.append(purchase_face() + [word(uc, 0x915A), word(uc, 0x915E)])
            else:
                sp = uc.reg_read(UC_X86_REG_SP)
                ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
                uc.reg_write(UC_X86_REG_SP, sp + 2)
                uc.reg_write(UC_X86_REG_IP, ip)

        for offset in (0x4E93, 0x57A6, 0x580C, 0xA51):
            cpu.hook_add(UC_HOOK_CODE, purchase_trace, begin=LOAD * 16 + offset, end=LOAD * 16 + offset)
        if phase == "quote":
            call(cpu, 0x5319)
            cpu.reg_write(UC_X86_REG_SI, entry)
            call(cpu, 0x521A)
        else:
            call(cpu, 0x4F2D, count=5000000)
        assert len(frames) == len(expected["frames"]), (case["stage"], phase, len(frames), len(expected["frames"]))
        for tick, (actual, native_face) in enumerate(zip(frames, expected["frames"])):
            assert actual == native_face, (case["stage"], phase, tick, actual, native_face)
        pixels = bytes(sum((1 << p) for p in range(4)
                           if planes[p][y * 40 + x // 8] & (0x80 >> (x & 7)))
                       for y in range(118, 160) for x in range(220, 300))
        assert pixels == base64.b64decode(expected["pixels"]), ("purchase pixels", case["stage"], phase)
print("PASS original purchase dialogue: quotes, payment debit/upgrade frame, receipt and refusal for stages one and five")


for case in native["shutters"]:
    cpu, planes = machine(True)
    shutter_face = trace_shop_face(cpu)
    word(cpu, 0x991C, 1)
    word(cpu, 0x8F4A, case["budget"])
    word(cpu, 0x915A, case["credits"])
    word(cpu, 0x915C, 0)
    word(cpu, 0x3ADE, 1)
    call(cpu, 0x0C0B)
    word(cpu, 0x8F44, 4)
    for column in (0, 1):
        word(cpu, 0x8F42, column)
        call(cpu, 0x5488)
    frames, intro = [], []

    def shutter_crop(x, y, width, height):
        return bytes(sum((1 << p) for p in range(4)
                         if planes[p][row * 40 + col // 8] & (0x80 >> (col & 7)))
                     for row in range(y, y + height) for col in range(x, x + width))

    def shutter_trace(uc, address, _size, _data):
        offset = address - LOAD * 16
        if offset == 0x4E78:
            uc.reg_write(UC_X86_REG_IP, 0xFF00)
        elif offset == 0x57A6:
            intro.append(shutter_face())
        elif offset == 0xA51:
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)
        else:
            timer = word(uc, 0x3CB6)
            assert all(word(uc, 0x3CB6 + i * 12) == timer for i in range(20))
            frames.append({
                "face": shutter_face(), "timer": timer if timer < 32768 else timer - 65536,
                "ids": [word(uc, 0x3CBC + i * 12) for i in range(20)],
                "phase": "sell" if word(uc, 0x3ADE) & 255 else "buy",
                "pixels": shutter_crop(4, 4, 32, 28), "actions": shutter_crop(4, 168, 73, 23),
            })

    for offset in (0x4E78, 0x57A6, 0xA51, 0x55AB, 0x55CC, 0x55FC, 0x560E):
        cpu.hook_add(UC_HOOK_CODE, shutter_trace, begin=LOAD * 16 + offset, end=LOAD * 16 + offset)
    call(cpu, 0x4B44, count=12000000)
    assert len(frames) == len(case["frames"]) == 32
    for tick, (actual, expected) in enumerate(zip(frames, case["frames"])):
        for field in ("face", "timer", "ids", "phase"):
            assert actual[field] == expected[field], (tick, field, actual[field], expected[field])
        for field in ("pixels", "actions"):
            target = base64.b64decode(expected[field])
            assert actual[field] == target, (tick, field, sum(a != b for a, b in zip(actual[field], target)))
    assert intro == case["intro"]
    assert shutter_crop(220, 118, 80, 42) == base64.b64decode(case["pixels"])
print("PASS original sell-to-buy shutters: 32 draws, stock swap, slot/action pixels, portrait/RNG and buy prompt")


for case in native["shopEntry"]:
    cpu, planes = machine(True)
    entry_face = trace_shop_face(cpu, forced=True)
    word(cpu, 0x915A, 10000)
    word(cpu, 0x9008, 0xA000)
    word(cpu, 0xA000, 0)
    cpu.mem_write(DS + 0x8FB1, bytes([int(case["victory"])]))
    entry_frames = iter(case["frames"])
    entry_draws, entry_hold = [], []

    def trace_entry(uc, address, _size, _data):
        offset = address - LOAD * 16
        if offset == 0x4B03:
            uc.reg_write(UC_X86_REG_IP, 0xFF00)
            return
        if offset in (0xA51, 0xD5F, 0xD81, 0xE09):
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)
            return
        if offset == 0x4BCD:
            target = uc.reg_read(UC_X86_REG_AX)
            wait = (target - word(uc, 0x3046)) & 65535
            entry_hold.append(wait)
            for _ in range(wait):
                assert next(entry_frames) == entry_draws[-1]
            word(uc, 0x3046, target)
            return
        expected = next(entry_frames)
        frame = len(entry_draws)
        timer = word(uc, 0x3CB6)
        assert timer == expected["timer"] & 65535
        assert entry_face() == expected["face"], (case["victory"], frame, entry_face(), expected["face"])
        compare_run_frame(uc, planes, 0, [expected["face"][0], expected["pixels"]], ("shop entry", case["victory"], frame))
        entry_draws.append(expected)

    def entry_interrupt(uc, number, _data):
        assert number == 0x80 and uc.reg_read(UC_X86_REG_AX) >> 8 in (1, 2)

    for offset in (0xA51, 0xD5F, 0xD81, 0xE09, 0x4AD3, 0x4AD9, 0x4B03, 0x4BCD, 0x4C9B, 0x55AB, 0x55CC):
        cpu.hook_add(UC_HOOK_CODE, trace_entry, begin=LOAD * 16 + offset, end=LOAD * 16 + offset)
    cpu.hook_add(UC_HOOK_INTR, entry_interrupt)
    call(cpu, 0x4A69, count=12000000)
    assert len(entry_draws) == 32 and entry_hold == [9] and next(entry_frames, None) is None
print("PASS original shop entry: 64 full cabinet frames across both visit types, nine-tick hold and portrait/RNG")


cpu, planes = machine(True)
victory_face = trace_shop_face(cpu)
call(cpu, 0x0C0B)
call(cpu, 0x4E12)
call(cpu, 0x576D)
for i in range(20):
    word(cpu, 0x3CB6 + i * 12, 1)
victory_frames, victory_holds = [], []


def victory_text():
    return bytes(sum((1 << p) for p in range(4)
                     if planes[p][y * 40 + x // 8] & (0x80 >> (x & 7)))
                 for y in range(118, 181) for x in range(220, 300))


def trace_victory_dialogue(uc, address, _size, _data):
    offset = address - LOAD * 16
    if offset == 0x4BFB:
        uc.reg_write(UC_X86_REG_IP, 0xFF00)
    elif offset == 0xA51:
        sp = uc.reg_read(UC_X86_REG_SP)
        ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
        uc.reg_write(UC_X86_REG_SP, sp + 2)
        uc.reg_write(UC_X86_REG_IP, ip)
    elif offset in (0x4BDD, 0x4BE9, 0x4BF8):
        victory_holds.append(uc.reg_read(UC_X86_REG_CX))
    elif offset == 0x4C52:
        victory_frames.append([victory_face(), victory_text()])
    elif offset == 0x57A6:
        victory_frames.append([victory_face(), None])
    elif victory_frames and victory_frames[-1][1] is None:
        victory_frames[-1][1] = victory_text()


for offset in (0xA51, 0x4BDD, 0x4BE9, 0x4BF8, 0x4BFB, 0x4C52, 0x5787, 0x57A6, 0x57F4):
    cpu.hook_add(UC_HOOK_CODE, trace_victory_dialogue, begin=LOAD * 16 + offset, end=LOAD * 16 + offset)
call(cpu, 0x4BD4, count=12000000)
assert victory_holds == [30, 30, 17] and len(victory_frames) == len(native["victoryDialogue"])
for frame, ((face, pixels), expected) in enumerate(zip(victory_frames, native["victoryDialogue"])):
    assert face == expected["face"], (frame, face, expected["face"])
    assert pixels == base64.b64decode(expected["text"]), ("victory dialogue pixels", frame)
print("PASS original victory dialogue: 99 frames across three panels, including held text pixels and portrait/RNG")


for case in native["shopExit"]:
    victory = case["victory"]
    cpu, planes = machine(True)
    exit_face = trace_shop_face(cpu)
    word(cpu, 0x991C, 5 if victory else 1)
    word(cpu, 0x8F4A, 600)
    word(cpu, 0x915A, 10000)
    exit_decorations = [word(cpu, 0x3DE8 + i * 6) for i in range(7)]
    call(cpu, 0x0C0B)
    call(cpu, 0x4E12 if victory else 0x4D38)
    exit_frames, exit_hold, exit_ending = {}, [], {}
    plane_enable = 15
    redraws = (0x4C16, 0x4C1C) if victory else (0x4B88, 0x4B8E)

    def exit_crop(x, y, width, height):
        return bytes(sum((1 << p) for p in range(4)
                         if planes[p][row * 40 + col // 8] & (0x80 >> (col & 7)))
                     for row in range(y, y + height) for col in range(x, x + width))

    def exit_trace(uc, address, _size, _data):
        offset = address - LOAD * 16
        if offset == 0x4B8E:
            uc.reg_write(UC_X86_REG_IP, 0xFF00)
            if victory:
                return
        if offset == 0x4BCD:
            target = uc.reg_read(UC_X86_REG_AX)
            exit_hold.append((target - word(uc, 0x3046)) & 65535)
            word(uc, 0x3046, target)
            return
        if offset in (0xA51, 0xE2B):
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)
            return
        if offset in (0x4C35, 0x4C3F):
            if offset not in exit_ending:
                assert plane_enable == (15 if offset == 0x4C35 else 0)
                exit_ending[offset] = [0, bytes(pixel & plane_enable for pixel in exit_crop(0, 0, 320, 200))]
            exit_ending[offset][0] += 1
            return
        frame = 46 + redraws.index(offset) if offset in redraws else len(exit_frames) + 1
        timer = word(uc, 0x3CB6)
        exit_frames[frame] = {
            "face": exit_face(), "timer": timer if timer < 32768 else timer - 65536,
            "hatch": exit_crop(4, 4, 32, 28), "shutters": exit_crop(208, 0, 112, 182),
        }

    def exit_interrupt(_cpu, number, _data):
        global plane_enable
        if number == 0x80:
            return
        bx = _cpu.reg_read(UC_X86_REG_BX)
        assert number == 0x10 and _cpu.reg_read(UC_X86_REG_AX) == 0x1000 and bx & 255 == 0x12
        plane_enable = bx >> 8

    for offset in {0xA51, 0xE2B, 0x4BCD, 0x4B8E, 0x4CEE, 0x55FC, 0x560E,
                   *redraws, 0x4C35, 0x4C3F}:
        cpu.hook_add(UC_HOOK_CODE, exit_trace, begin=LOAD * 16 + offset, end=LOAD * 16 + offset)
    cpu.hook_add(UC_HOOK_INTR, exit_interrupt)
    call(cpu, 0x576D)
    cpu.reg_write(UC_X86_REG_SI, 0x37D8 if victory else 0x3DC4)
    call(cpu, 0x5787)
    word(cpu, 0x304A, 0x5845)
    for i, start in enumerate(exit_decorations):
        end = start
        while word(cpu, end):
            end += 2
        word(cpu, 0x3DE8 + i * 6, start + 81 % ((end - start) // 2) * 2)
    call(cpu, 0x4BFB if victory else 0x4B6D, count=12000000)
    assert exit_hold == [9] and list(exit_frames) == list(range(1, 37)) + [46, 47]
    assert len(case["frames"]) == 47
    for frame, expected in enumerate(case["frames"], 1):
        actual = exit_frames.get(frame, exit_frames[36])
        assert expected["status"] == ("ending" if victory else "playing" if frame == 47 else "shop")
        for field in ("face", "timer"):
            assert actual[field] == expected[field], (victory, frame, field, actual[field], expected[field])
        if not (victory and frame == 47):
            for field in ("hatch", "shutters"):
                target = base64.b64decode(expected[field])
                assert actual[field] == target, (victory, frame, field, sum(a != b for a, b in zip(actual[field], target)))
    assert len(exit_ending) == len(case["ending"])
    for (ticks, pixels), expected in zip(exit_ending.values(), case["ending"]):
        assert ticks == expected["ticks"] and pixels == base64.b64decode(expected["pixels"])
    assert case["status"] == ("stage-loading" if victory else "playing")
print("PASS original ordinary and victory shop exits: 19 hatch and 17 shutter draws, nine-tick hold, portrait/RNG and ending screens")


cpu, planes = machine(True)
hand_face = trace_shop_face(cpu, forced=True)
hand = []
hand_faces = []
hand_sound = []
hand_interrupts = []
hand_presents = []


def trace_hand(uc, address, _size, _data):
    offset = address - LOAD * 16
    if offset == 0x54DB:
        for plane, pixels in enumerate(planes):
            fill = bytes([255 if 9 & (1 << plane) else 0])
            pixels[80 * 40:140 * 40] = fill * (60 * 40)
        return
    if offset == 0x54F6:
        hand_faces.append(hand_face())
        hand.append(bytes(sum((1 << p) for p in range(4)
                              if planes[p][y * 40 + x // 8] & (0x80 >> (x & 7)))
                          for y in range(80, 140) for x in range(256, 320)))
        return
    if offset == 0x555B:
        hand_sound.append((len(hand), word(uc, 0x8E88)))
        return
    if offset == 0xA51:
        hand_presents.append(len(hand))
    sp = uc.reg_read(UC_X86_REG_SP)
    ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
    uc.reg_write(UC_X86_REG_SP, sp + 2)
    uc.reg_write(UC_X86_REG_IP, ip)


def hand_interrupt(uc, number, _data):
    hand_interrupts.append((len(hand), number, uc.reg_read(UC_X86_REG_AX) >> 8))


for offset in (0x54DB, 0x54F6, 0x555B, 0xA51):
    cpu.hook_add(UC_HOOK_CODE, trace_hand, begin=LOAD * 16 + offset, end=LOAD * 16 + offset)
cpu.hook_add(UC_HOOK_INTR, hand_interrupt)
call(cpu, 0x5510, count=9000000)
assert hand_interrupts == [(18, 0x80, 1)] and hand_sound == [(18, 8)]
assert hand_presents == list(range(35)) and len(hand) == len(native["hand"]) == 35
for index, (actual, expected, face) in enumerate(zip(hand, native["hand"], hand_faces)):
    assert face == [expected["seed"], 0, expected["blink"], expected["brow"]], ("hand face", index, face)
    expected = base64.b64decode(expected["pixels"])
    differences = [(256 + i % 64, 80 + i // 64, a, b)
                   for i, (a, b) in enumerate(zip(actual, expected)) if a != b]
    assert not differences, ("hand frame", index, len(differences), differences[:10])
print("PASS original shop hand: 35 clipped sprite frames, eyelids/brows, shared RNG and DOS sound request")


for case in native["saleQuotes"]:
    cpu, planes = machine(True)
    quote_face = trace_shop_face(cpu, left_brow=True)
    actor, entry = 0xA000, 0x3CB6
    word(cpu, 0x3ADE, 1)
    word(cpu, actor + 0x34, case["power"])
    word(cpu, entry, 8)
    word(cpu, entry + 6, case["id"])
    word(cpu, entry + 8, word(cpu, 0x3898 + case["id"] * 2))
    word(cpu, entry + 10, actor)
    cpu.reg_write(UC_X86_REG_SI, entry)
    frames, hand, presents = [], [], []

    def sale_crop(left, top, width, height):
        return bytes(sum((1 << p) for p in range(4)
                         if planes[p][y * 40 + x // 8] & (0x80 >> (x & 7)))
                     for y in range(top, top + height) for x in range(left, left + width))

    def trace_sale(uc, address, _size, _data):
        offset = address - LOAD * 16
        if offset == 0x516F:
            uc.reg_write(UC_X86_REG_IP, 0xFF00)
        elif offset == 0x54DB:
            for plane, pixels in enumerate(planes):
                fill = bytes([255 if 9 & (1 << plane) else 0]) * 8
                for y in range(64, 116):
                    start = y * 40 + 28
                    pixels[start:start + 8] = fill
        elif offset in (0x57A6, 0x580C, 0x54F6):
            frames.append(quote_face())
            if offset == 0x54F6:
                hand.append(sale_crop(224, 64, 64, 52))
        else:
            presents.append(len(frames))
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)

    for offset in (0x516F, 0x57A6, 0x580C, 0x54DB, 0x54F6, 0xA51):
        cpu.hook_add(UC_HOOK_CODE, trace_sale, begin=LOAD * 16 + offset, end=LOAD * 16 + offset)
    call(cpu, 0x51B8, count=12000000)
    assert word(cpu, 0x39B2) == case["amount"] and cpu.mem_read(DS + 0x3AE1, 1) == b"\0"
    assert presents == list(range(len(frames))) and len(frames) == len(case["frames"])
    for i, (actual, expected) in enumerate(zip(frames, case["frames"])):
        assert actual == expected, ("sale face", case["id"], i, actual, expected)
    assert len(hand) == len(case["hand"]) == 47
    for i, (actual, expected) in enumerate(zip(hand, case["hand"])):
        assert actual == base64.b64decode(expected), ("sale hand", case["id"], i)
    assert sale_crop(220, 118, 80, 42) == base64.b64decode(case["pixels"]), ("sale quote pixels", case["id"])
print("PASS original sale quotes: powered Laser and Cannon, 47 clipped hand frames each, left brow, dialogue, price and RNG")


cpu, planes = machine(True)
word(cpu, 0x991C, 5)
word(cpu, 0x8FB1, 0)
word(cpu, 0x3C9A, 262)
word(cpu, 0x3C9C, 136)
word(cpu, 0x3C9E, 0xF700)
greeting_face = trace_shop_face(cpu)
greeting = []


def trace_greeting(uc, address, _size, _data):
    offset = address - LOAD * 16
    if offset in (0x576D, 0x5154):
        if greeting:
            row = greeting[-1]
            row["pixels"] = bytes(sum((1 << p) for p in range(4)
                                      if planes[p][y * 40 + x // 8] & (0x80 >> (x & 7)))
                                  for y in range(118, 160) for x in range(220, 300))
        if offset == 0x5154:
            uc.reg_write(UC_X86_REG_IP, 0xFF00)
        return
    if offset == 0x5787:
        if not greeting or "pixels" in greeting[-1]:
            pointer = uc.reg_read(UC_X86_REG_SI)
            text = bytes(uc.mem_read(DS + pointer, 100)).split(b"\0", 1)[0].decode("ascii")
            greeting.append({"message": text, "ticks": 0, "holds": 0, "frames": []})
        return
    if offset in (0x57A6, 0x5509):
        greeting[-1]["frames"].append(greeting_face())
        if offset == 0x5509:
            greeting[-1]["holds"] += 1
        return
    greeting[-1]["ticks"] += 1
    sp = uc.reg_read(UC_X86_REG_SP)
    ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
    uc.reg_write(UC_X86_REG_SP, sp + 2)
    uc.reg_write(UC_X86_REG_IP, ip)


for offset in (0x576D, 0x5787, 0x5154, 0xA51, 0x57A6, 0x5509):
    cpu.hook_add(UC_HOOK_CODE, trace_greeting, begin=LOAD * 16 + offset, end=LOAD * 16 + offset)
call(cpu, 0x4B06, count=12000000)
assert [entry["holds"] for entry in greeting] == [17, 17, 0]
assert len(greeting) == len(native["greeting"])
for index, (entry, expected) in enumerate(zip(greeting, native["greeting"])):
    assert entry["message"] == expected["message"] and entry["ticks"] == len(expected["frames"]), index
    assert len(entry["frames"]) == len(expected["frames"]), index
    for frame, (actual, native_face) in enumerate(zip(entry["frames"], expected["frames"])):
        assert actual == native_face, ("greeting face", index, frame, actual, native_face)
    assert entry["pixels"] == base64.b64decode(expected["pixels"]), ("stage-five dialogue pixels", index)
print("PASS original stage-five shop greeting: dialogue images, two 17-frame holds, portrait/RNG and sell-menu entry")


cpu, planes = machine(True)
word(cpu, 0x991C, 5)
word(cpu, 0x8F4A, 6000)
cpu.mem_write(DS + 0x915A, struct.pack("<I", 1234567))
cpu.mem_write(DS + 0x3ADF, b"\0\0\0")
word(cpu, 0x8F3C, 0)
word(cpu, 0x8F3E, 0)
word(cpu, 0x8F40, 0)
word(cpu, 0x304A, 0x5845)
word(cpu, 0x3816, 0)
call(cpu, 0x4D38)
for i in range(20):
    word(cpu, 0x3CB6 + i * 12, 4 + i % 11)
for tick, state in enumerate(native["flicker"]):
    if "repage" in state:
        word(cpu, 0x3816, state["repage"])
        call(cpu, 0x4D38)
    if "pixels" in state:
        for plane in planes:
            plane[:164 * 40] = bytes(164 * 40)
    call(cpu, 0x0C93)
    call(cpu, 0x5691)
    call(cpu, 0x56B8)
    assert word(cpu, 0x304A) == state["seed"], ("flicker RNG", tick, word(cpu, 0x304A), state["seed"])
    for i, (item, timer, icon) in enumerate(state["slots"]):
        entry = 0x3CB6 + i * 12
        assert word(cpu, entry + 6) == item and word(cpu, entry) == timer, ("flicker timer", tick, i)
        if item:
            start = word(cpu, 0x3898 + item * 2)
            assert word(cpu, entry + 8) == start + 2 * (icon + 1), ("flicker icon", tick, i)
    if "pixels" in state:
        coords = [(x, y) for i in (0, 1, 6, 19)
                  for y in range(4 + i // 5 * 41, 32 + i // 5 * 41)
                  for x in range(4 + i % 5 * 41, 36 + i % 5 * 41)]
        actual = bytes(sum((1 << p) for p in range(4)
                           if planes[p][y * 40 + x // 8] & (0x80 >> (x & 7)))
                       for x, y in coords)
        expected = base64.b64decode(state["pixels"])
        mismatch = [(xy, a, b) for xy, a, b in zip(coords, actual, expected) if a != b]
        assert not mismatch, ("flicker pixels", tick, len(mismatch), mismatch[:10])
print("PASS original shop stock flicker: 48 idle ticks across both pages, shared RNG, icon cursors and sampled VGA")


for case in native["beams"]:
    cpu, _ = machine()
    actor, parent = 0xA000, 0xA04C
    for offset, value in [(0, 0x24), (0x1A, -32), (0x34, case["power"]), (0x44, parent)]:
        word(cpu, actor + offset, value)
    boxes = []

    def beam_hook(uc, address, _size, _data):
        if address != LOAD * 16 + 0x1C4F:
            return
        boxes.append([uc.reg_read(r) for r in (UC_X86_REG_AX, UC_X86_REG_BX,
                      UC_X86_REG_CX, UC_X86_REG_DX, UC_X86_REG_BP)])
        sp = uc.reg_read(UC_X86_REG_SP)
        ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
        uc.reg_write(UC_X86_REG_SP, sp + 2)
        uc.reg_write(UC_X86_REG_IP, ip)

    cpu.hook_add(UC_HOOK_CODE, beam_hook)
    for state in case["states"]:
        boxes.clear()
        word(cpu, parent + 0x12, state["parent"][0])
        word(cpu, parent + 0x16, state["parent"][1])
        cpu.reg_write(UC_X86_REG_SI, actor)
        call(cpu, 0x23ED)
        assert word(cpu, actor) == (4 if state["dead"] else 0x24)
        assert word(cpu, actor + 0x12) == state["x"] & 65535
        assert word(cpu, actor + 0x16) == state["y"] & 65535
        assert word(cpu, actor + 0x1A) == state["length"] & 65535
        assert boxes == ([state["box"]] if state["box"] else []), (case, state, boxes)
print(f"PASS {len(native['beams'])} Laser lifetimes across all powers: growth, detached travel, clipping, bounds and damage")

for case in native["scenes"]:
    cpu, planes = machine(True)
    cpu.hook_add(UC_HOOK_CODE, skip_faces)
    call(cpu, 0x0C0B)
    word(cpu, 0x3ADE, 1 if case["phase"] == "sell" else 0)
    word(cpu, 0x8F44, 4)
    for column in (0, 1):
        word(cpu, 0x8F42, column)
        call(cpu, 0x5488)
    age = case["age"]
    opening = max(0, age - 1) * 4
    word(cpu, 0x8F3C, max(0, 48 - opening))
    word(cpu, 0x8F3E, max(0, 68 - opening))
    word(cpu, 0x8F40, 0)
    if "mouth" in case:
        word(cpu, 0x8F40, 255)
        desired = 1 << case["mouth"]
        word(cpu, 0x304A, (desired - 0x3619) * pow(0x6255, -1, 65536))
    for i in range(7):
        entry = 0x3DE4 + i * 6 + 4
        start = word(cpu, entry)
        end = start
        while word(cpu, end):
            end += 2
        word(cpu, entry, start + age % ((end - start) // 2) * 2)
    call(cpu, 0x0C93)
    call(cpu, 0x0CB5)
    word(cpu, 0x304A, 0x5845 + age)
    for i, item in enumerate(case["slots"]):
        entry = 0x3CB6 + i * 12
        timer = -9 if age <= 18 else age - 27 if age < 27 else 1 if age < 32 else 3 if item else 0
        word(cpu, entry, timer)
        word(cpu, entry + 6, item)
        if item:
            pointer = word(cpu, 0x3898 + item * 2)
            end = pointer
            while word(cpu, end):
                end += 2
            word(cpu, entry + 8, pointer + age % ((end - pointer) // 2) * 2)
    call(cpu, 0x56B8)
    selection = case.get("selection", 0)
    word(cpu, 0x8F42, selection % 5)
    word(cpu, 0x8F44, selection // 5)
    if age >= 32:
        call(cpu, 0x5435)
    if case.get("message"):
        def skip_typing_updates(uc, address, _size, _data):
            if address not in [LOAD * 16 + p for p in (0x5691, 0x56B8, 0xC93, 0xA51)]:
                return
            sp = uc.reg_read(UC_X86_REG_SP)
            ip = struct.unpack("<H", uc.mem_read(0x90000 + sp, 2))[0]
            uc.reg_write(UC_X86_REG_SP, sp + 2)
            uc.reg_write(UC_X86_REG_IP, ip)
        cpu.hook_add(UC_HOOK_CODE, skip_typing_updates)
        word(cpu, 0x8F46, 55)
        word(cpu, 0x8F48, 118)
        cpu.mem_write(DS + 0xF000, case["message"].encode("ascii") + b"\x00")
        cpu.reg_write(UC_X86_REG_SI, 0xF000)
        call(cpu, 0x5787)
    cpu.reg_write(UC_X86_REG_AX, case["credits"] & 65535)
    cpu.reg_write(UC_X86_REG_DX, case["credits"] >> 16)
    call(cpu, 0x0B1D)
    actual = bytes(sum((1 << p) for p in range(4)
                       if planes[p][y * 40 + x // 8] & (0x80 >> (x & 7)))
                   for y in range(200) for x in range(320))
    expected = base64.b64decode(case["pixels"])
    differences = [(i % 320, i // 320, a, b) for i, (a, b) in enumerate(zip(actual, expected)) if a != b]
    assert not differences, (case["phase"], age, case.get("mouth"), len(differences), differences[:20])
    print(f"PASS {case['phase']}/{age}: all 64,000 graphical-shop pixels match original VGA")

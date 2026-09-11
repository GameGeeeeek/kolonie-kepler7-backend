const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createOperationalHealth}=require('../operations-health');
test('health observes real writes, parse errors, failed and stale ticks, expiring players',async()=>{
 let now=100000000,raw='{"users":{},"private":{},"shared":{}}';
 const h=createOperationalHealth({dbFile:'fixture',clock:()=>now,readFile:async()=>raw});
 assert.deepEqual(h.snapshot().checks,{database:null,simulation:null,persistence:null});
 h.load(true);await h.probe();h.write(null);h.tickDone('galaxyTick',h.tickStart());h.touch('a');h.touch('a');
 assert.deepEqual(h.snapshot().checks,{database:true,simulation:true,persistence:true});assert.equal(h.snapshot().players,1);
 const before=h.tickStart();h.tickError('galaxyTick');h.tickDone('galaxyTick',before);assert.equal(h.snapshot().checks.simulation,false);
 h.tickDone('galaxyTick',h.tickStart());h.write(Error('disk'));raw='broken';await h.probe();
 assert.deepEqual(h.snapshot().checks,{database:false,simulation:true,persistence:false});
 now+=19*60000;assert.equal(h.snapshot().players,0);assert.equal(h.snapshot().checks.simulation,false);
 raw='{"users":{},"private":{},"shared":{}}';await h.probe();h.write(null);assert.equal(h.snapshot().checks.persistence,true);
 h.load(false);assert.equal(h.snapshot().checks.database,false);
});
test('maintenance distinguishes future, current and elapsed window and attack pause',()=>{
 const h=createOperationalHealth({clock:()=>100000000});
 assert.equal(h.snapshot({announcement:{ab:100000001,dauerMinuten:30}}).maintenance.active,false);
 assert.equal(h.snapshot({announcement:{ab:99999999,dauerMinuten:30}}).maintenance.active,true);
 assert.equal(h.snapshot({announcement:{ab:1,dauerMinuten:30}}).maintenance.active,false);
 assert.equal(h.snapshot({attacksPaused:true}).maintenance.mode,'attacks-paused');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import guardModule from '../operations-release-guard.js';
const { createGuard } = guardModule;
const invoke = execute => new Promise(resolve => execute('kolonie-kepler7-backend', 'fixed fixture deploy', {}, (error, stdout, stderr) => resolve({error, stdout, stderr})));

test('Kepler guard requires persisted backup and archive before any source command', async () => {
  const order = [];
  const guarded = createGuard({ prepareBackup: async () => order.push('backup'),
    getEngine: () => ({ beforeExternal: name => {order.push(name); return {requestId:'fixture'};}, afterExternal: value => {assert.equal(value.success,true);order.push('after');return {archived:true};}}),
    execute: (command, options, callback) => {order.push('command');callback(null,'result','');}});
  const value = await invoke(guarded);
  assert.equal(value.error,null); assert.deepEqual(order,['backup','kolonie-kepler7-backend','command','after']);
});

test('Kepler missing backup or archive rejects before source execution', async () => {
  for (const failAt of ['backup','archive']) {
    let executed=0;
    const guarded=createGuard({prepareBackup:async()=>{if(failAt==='backup')throw Error('private detail');},getEngine:()=>({beforeExternal:()=>{throw Error('private detail');}}),execute:()=>executed++});
    const value=await invoke(guarded); assert.equal(executed,0);assert.equal(value.error.code,'predeploy_archive_unconfirmed');assert.equal(value.stderr,'');
  }
});

test('Kepler archive failure after command cannot report a completed deploy', async () => {
  const guarded=createGuard({prepareBackup:async()=>{},getEngine:()=>({beforeExternal:()=>({requestId:'fixture'}),afterExternal:()=>{throw Error('private detail');}}),execute:(command,options,callback)=>callback(null,'ok','')});
  assert.equal((await invoke(guarded)).error.code,'postdeploy_archive_unconfirmed');
});

test('Kepler command failure records uncertainty and preserves original result', async () => {
  let outcome;const failure=Error('source command failed');
  const guarded=createGuard({prepareBackup:async()=>{},getEngine:()=>({beforeExternal:()=>({requestId:'fixture'}),afterExternal:value=>{outcome=value;return {archived:false};}}),execute:(command,options,callback)=>callback(failure,'','bounded stderr')});
  const result=await invoke(guarded);assert.equal(result.error,failure);assert.deepEqual(outcome,{requestId:'fixture',success:false});
});

test('Kepler guard cannot select another deployment target', () => {
  let called=false;const guarded=createGuard({prepareBackup:async()=>{called=true;}});
  assert.throws(()=>guarded('other','anything',{},()=>{}),/invalid_deploy_target/);assert.equal(called,false);
});

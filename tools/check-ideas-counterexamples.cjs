'use strict';
const assert=require('node:assert/strict'),{spawnSync}=require('child_process'),path=require('path'),fs=require('fs');
const test=path.resolve(__dirname,'../tests/test_k7_ideas_http.js');
for(const [mutation,mustFail]of Object.entries({gate:'old clients retain new rewards',pity:'pity grants targeted part once',phase:'actual shield damage includes existing weakness',encounter:'inherited encounter key __proto__ rejected'})){
  const result=spawnSync(process.execPath,[test],{encoding:'utf8',env:{...process.env,KEPLER_K7_SABOTAGE:mutation},timeout:60000});
  const output=result.stdout+result.stderr;assert.equal(result.status,1,mutation+' must fail');assert.ok(output.includes('AssertionError')&&output.includes(mustFail),output);console.log('RED CONFIRMED - '+mutation+' → '+mustFail);
}
const root=path.resolve(__dirname,'..'),moduleFile=path.join(root,'balance-mutation-'+process.pid+'.js'),testFile=path.join(root,'tests/balance-mutation-'+process.pid+'.js');
try{
  const moduleSource=fs.readFileSync(path.join(root,'k7-ideas.js'),'utf8');assert.equal(moduleSource.split('PITY_REQUIRED=12').length,2);fs.writeFileSync(moduleFile,moduleSource.replace('PITY_REQUIRED=12','PITY_REQUIRED=6'));
  const original=fs.readFileSync(path.join(root,'tests/test_k7_balance.js'),'utf8');fs.writeFileSync(testFile,original.replace("require('../k7-ideas')",'require('+JSON.stringify(moduleFile)+')'));
  const result=spawnSync(process.execPath,[testFile],{encoding:'utf8',timeout:60000});assert.equal(result.status,1);assert.ok((result.stdout+result.stderr).includes('only the twelfth genuine victory unlocks a claim'));console.log('RED CONFIRMED - balance → only the twelfth genuine victory unlocks a claim');
}finally{for(const file of [moduleFile,testFile])if(fs.existsSync(file))fs.unlinkSync(file);}

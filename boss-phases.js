'use strict';
// Same pure function is embedded in the frontend for previews and checked for parity.
function k7BossPhase(doc,composition){
  if(!doc||doc.variant!=='shield-cycle'||doc.bossKey!=='panzerhuelle')return null;
  const shield=(doc.hp||0)>=(doc.maxHp||1)*0.5;
  const pierces=(composition&&composition.bomber||0)>0;
  return {key:shield?'shield':'vulnerable',damage:shield?(pierces?0.9:0.65):1.2,counter:shield?1:0.8,pierces:shield&&pierces};
}
module.exports={k7BossPhase};

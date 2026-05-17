import fs from 'fs';
const buf = fs.readFileSync('D:/AI/OpenCode/cli/opencode.exe');
const s = buf.toString('latin1');
function findAll(needle, ctxBefore=200, ctxAfter=500, max=4) {
  let i=0, n=0, hits=[];
  while ((i = s.indexOf(needle, i+1)) >= 0 && n < max) {
    hits.push({offset:i, ctx:s.slice(Math.max(0,i-ctxBefore), i+ctxAfter).replace(/[\x00-\x08\x0b-\x1f]/g,'.')});
    n++;
  }
  return hits;
}
function show(title, hits) {
  console.log(`\n### ${title} (${hits.length}) ###`);
  for (const [i,h] of hits.entries()) console.log(`--- ${i+1} @${h.offset} ---\n${h.ctx}\n`);
}
// Find the model-extras mapping for openai
show('case @ai-sdk/openai:{', findAll('case"@ai-sdk/openai":{', 50, 1200, 2));
// Find what qM does
show('qM(', findAll('function qM(', 50, 800, 3));
show('qM=function', findAll('qM=function', 50, 800, 3));
// store=!1 context (Responses-API parameter)
show('store=!1', findAll('store=!1', 200, 500, 3));
// gpt-5 related responses choices
show('release_date', findAll('release_date', 200, 200, 5));
// store_response or whether to use responses
show('useResponses providerID', findAll('providerID==="openai"', 200, 500, 4));

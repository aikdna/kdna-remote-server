import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { admitNode } from '@aikdna/kdna-core/node';
import { inspectSnapshot } from '@aikdna/kdna-core/read-boundary';
const items=[];
for(const name of readdirSync(new URL('./fixtures/',import.meta.url)).filter(x=>x.endsWith('.kdna'))){
 const bytes=readFileSync(new URL('./fixtures/'+name,import.meta.url)),admission=await admitNode(bytes);const view=admission.status==='accepted'?inspectSnapshot(admission.snapshot):null;
 items.push({name,admission:view?{status:admission.status}:admission,view});
}
writeFileSync(process.argv[2],JSON.stringify(items,null,2)+'\n');console.log(JSON.stringify(items.map(x=>({name:x.name,status:x.admission.status,reason:x.admission.reason,asset:x.view?.asset,catalog:x.view?.ir.catalog.map(j=>j.judgment_id),methodNodes:x.view?.ir.nodes.filter(n=>n.role==='method').map(n=>({id:n.id,keys:Object.keys(n.value)}))}))));

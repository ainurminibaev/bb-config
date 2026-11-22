// Restore visible conversation and registered project attachments in the isolated test thread.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function cli(args) {
  return JSON.parse(execFileSync('bb',args.concat('--json'),{maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']}));
}
function* threadEvents(thread) {
  let after=0;
  for (;;) {
    const page=cli(['thread','log',thread,'--after-seq',String(after),'--limit','200']);
    if (!page.length) return;
    yield* page;
    const last=page.at(-1).seq;
    if (!(last>after)) throw Error('BB history cursor did not advance');
    after=last;
  }
}
export function probeHistory(thread) {
  if (!/^thr_[a-z0-9]+$/.test(thread)) throw Error('Invalid probe thread');
  const rows=[], media=[], files=new Set();
  const events=threadEvents(thread);
  let project;
  for (const {type,data} of events) {
    if (type==='client/turn/requested') {
      for(const p of data.input??[]) {
        if(p.visibility==='agent-only') continue;
        if(p.type==='text') { rows.push({role:'user',text:p.text}); continue; }
        if(!['localFile','localImage'].includes(p.type) || !p.path || files.has(p.path)) continue;
        files.add(p.path);
        project ??= cli(['thread','show',thread]).thread.projectId;
        const dir=mkdtempSync(join(tmpdir(),'bb-probe-attachment-'));
        try {
          const file=join(dir,'content');
          const meta=cli(['project','attachment','download',project,p.path,'--client-file',file]);
          if(meta.sizeBytes>1024*1024) throw Error('Test attachment exceeds 1 MiB');
          const bytes=readFileSync(file);
          rows.push({role:'user',attachment:p.path});
          if(meta.mimeType.startsWith('text/')) rows.push({role:'attachment',text:bytes.toString('utf8')});
          else if(['image/png','image/jpeg','image/webp','image/gif','application/pdf'].includes(meta.mimeType))
            media.push({type:meta.mimeType==='application/pdf'?'document':'image',source:{type:'base64',media_type:meta.mimeType,data:bytes.toString('base64')}});
          else throw Error('Unsupported probe attachment type: '+meta.mimeType);
        } finally { rmSync(dir,{recursive:true,force:true}); }
      }
    } else if(type==='item/completed') {
      const item=data.item;
      if(item?.type==='agentMessage' && item.text && !item.text.startsWith('API Error:')) rows.push({role:'assistant',text:item.text});
      if(['toolCall','mcpToolCall'].includes(item?.type) && ['origin','workspace'].includes(item.server)) rows.push({role:'tool',tool:item.tool,status:item.status,result:item.result});
    }
  }
  const text=JSON.stringify(rows);
  return [{type:'text',text:'История треда BB:\n'+text},...media];
}

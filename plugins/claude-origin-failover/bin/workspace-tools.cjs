// The BB client runs on the account machine. File operations stay inside the
// original BB workspace. Writes require a matching revision from a prior read.
const {execFileSync}=require('node:child_process');
const readline=require('node:readline');
const path=require('node:path');
const [host,root,threadId]=process.argv.slice(2);
if(!/^host_[a-z0-9]+$/.test(host) || !path.isAbsolute(root) || root==='/' || root==='/root')process.exit(64);
const string={type:'string'};
function tool(name,description,properties){
  return {name,description,inputSchema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}};
}
const tools=[
  tool('git_status','Show Git status on the original BB machine',{}),
  tool('read_file','Read a UTF-8 project file on the original machine. Returns text and SHA-256.',{path:string}),
  tool('edit_file','Replace existing UTF-8 project file content on the original machine if its SHA-256 still matches.',{path:string,sha256:string,content:string})
];
if(threadId && /^thr_[a-z0-9]+$/.test(threadId)){
  tools.push(tool('bb_cli','Run the BB CLI in the original thread on its machine. Supply argv without the initial bb, e.g. ["guide"], ["thread","spawn",...], or a plugin command. For a running terminal use its returned ID to inspect progress.',{argv:{type:'array',items:string}}));
}
function cli(args,input){
  try {
    const output=execFileSync(process.env.BB_CLI||'bb',args,{input,encoding:'utf8',timeout:25000,maxBuffer:2*1024*1024,stdio:['pipe','pipe','pipe']});
    return JSON.parse(output);
  } catch(error) {
    // terminal run returns the child exit code even when its JSON result is valid.
    if(args[0]==='terminal' && args[1]==='run' && error.status>0 && error.stdout){
      let result;
      try { result=JSON.parse(error.stdout); } catch {}
      if(Number.isInteger(result?.exitCode) && typeof result.output==='string') return result;
    }
    throw error;
  }
}
function request(method,params){
  if(method==='initialize')return {protocolVersion:params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'workspace',version:'1'}};
  if(method==='ping')return {};
  if(method==='tools/list')return {tools};
  if(method!=='tools/call')throw Error('Unknown method');
  const args=params.arguments??{};
  if(params.name==='bb_cli' && tools.some(t=>t.name==='bb_cli')){
    if(!Array.isArray(args.argv) || !args.argv.every(value=>typeof value==='string' && !value.includes('\0')))
      throw Error('Expected BB command arguments as an array of strings');
    const {thread}=cli(['thread','show',threadId,'--json']);
    const run=cli(['terminal','run','--thread',threadId,'--title','BB CLI','--timeout','10s','--json','--',
      'env','BB_THREAD_ID='+thread.id,'BB_PROJECT_ID='+thread.projectId,'BB_ENVIRONMENT_ID='+thread.environmentId,
      'bb',...args.argv]);
    return {isError:run.exitCode!=null && run.exitCode!==0,content:[{type:'text',text:JSON.stringify({
      output:run.output,exitCode:run.exitCode,terminalId:run.terminalId,observation:run.observation,truncated:run.truncated})}]};
  }
  if(params.name==='git_status'){
    const run=cli(['terminal','run','--machine',host,'--cwd',root,'--json','--','git','--no-optional-locks','-c','core.fsmonitor=false','status','--short','--branch']);
    if(run.exitCode!==0)throw Error('The original directory is not a Git worktree or Git status is unavailable');
    return {content:[{type:'text',text:run.output||'Clean'}]};
  }
  if(!['read_file','edit_file'].includes(params.name))throw Error('Unknown tool');
  if(typeof args.path!=='string'||path.isAbsolute(args.path)||args.path.split('/').some(p=>!p||p==='.'||p==='..'||/^\.(git|ssh|aws|claude|codex|bb|env)(\.|$)/i.test(p)) || /\.(pem|key|p12)$/i.test(args.path))throw Error('Expected a project-relative file path');
  const file=path.join(root,args.path);
  const flags=['--host',host,'--root',root,'--json'];
  if(params.name==='read_file'){
    const result=cli(['file','read',file,...flags]);
    if(result.contentEncoding!=='utf8'||result.sizeBytes>128*1024)throw Error('Expected UTF-8 file up to 128 KiB');
    return {content:[{type:'text',text:JSON.stringify({sha256:result.sha256,content:result.content})}]};
  }
  if(!/^[a-f0-9]{64}$/.test(args.sha256)||typeof args.content!=='string'||Buffer.byteLength(args.content)>128*1024)throw Error('Invalid revision or file size');
  const result=cli(['file','write',file,...flags,'--stdin','--expected-sha256',args.sha256],args.content);
  if(result.outcome!=='written') throw Error('File changed on origin. Read it again before editing.');
  return {content:[{type:'text',text:JSON.stringify(result)}]};
}
readline.createInterface({input:process.stdin}).on('line',line=>{
  const msg=JSON.parse(line);
  if(msg.id==null)return;
  try{console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:request(msg.method,msg.params??{})}));}
  catch(e){console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32603,message:e.status?'Original machine rejected this operation':e.message}}));}
});

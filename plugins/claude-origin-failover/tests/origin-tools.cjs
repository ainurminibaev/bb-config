// Stdio MCP fixture. The remote Claude can use three fixed operations in one test directory.
const {execFileSync} = require('node:child_process');
const readline = require('node:readline');
const [host, dir] = process.argv.slice(1);
if (!/^host_[a-z0-9]+$/.test(host) || !/^\/tmp\/origin-tools-[a-zA-Z0-9]+$/.test(dir)) process.exit(64);
const tools = ['read_marker','record_marker','inspect_services'].map(name=>({
  name, description:name.replaceAll('_',' ')+' on the origin machine',
  inputSchema:{type:'object',properties:{},additionalProperties:false}
}));
function execute(method, params) {
  if (method==='initialize') return {protocolVersion:params.protocolVersion, capabilities:{tools:{}},serverInfo:{name:'origin-test',version:'1'}};
  if (method==='tools/list') return {tools};
  if (method==='ping') return {};
  if (method!=='tools/call' || !tools.some(tool=>tool.name===params.name)) throw Error('Unknown operation');
  const result=JSON.parse(execFileSync(process.env.BB_CLI || 'bb',['terminal','run','--machine',host,'--cwd',dir,'--timeout','20s','--json','--','python3',dir+'/fixture.py',params.name],{timeout:26000,encoding:'utf8'}));
  if (result.exitCode!==0) throw Error('Origin operation failed');
  return {content:[{type:'text',text:result.output.trim()}]};
}
readline.createInterface({input:process.stdin}).on('line',line=>{
  const msg=JSON.parse(line);
  if (msg.id==null) return;
  try { console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:execute(msg.method,msg.params??{})})); }
  catch(e) { console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32603,message:e.message.split('\n')[0]}})); }
});

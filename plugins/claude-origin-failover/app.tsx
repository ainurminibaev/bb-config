import {useId,useRef,useState,useEffect} from 'react';
import {definePluginApp,experimental_Icon as Icon,experimental_useRpcQuery,useRpc} from '@get-bb/plugin-sdk/app';
import {retryUi} from './ui-contract';
import './route.css';

function RouteControl({threadId,turnId,headless,openSignal}:{threadId:string;turnId?:string;headless?:boolean;openSignal?:number}) {
  const q=experimental_useRpcQuery({contract:retryUi,method:'retryPreference',input:{threadId}});
  const rpc=useRpc<typeof retryUi>();
  const [busy,setBusy]=useState(false);
  const [expanded,setExpanded]=useState(false);
  const [error,setError]=useState('');
  const panel=useRef<HTMLDivElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  const title=useId(), id=useId();
  const data=q.data;
  // Opened from the "+" menu: place the panel above the composer, centred on the thread pane.
  useEffect(()=>{
    if(!headless||!openSignal) return;
    const box=panel.current; if(!box) return;
    if(!box.matches(':popover-open')) box.showPopover();
    const composer=document.querySelector('[data-app-composer-role="primary"]')?.getBoundingClientRect();
    const width=box.offsetWidth,height=box.offsetHeight;
    const centre=composer?composer.left+composer.width/2:innerWidth/2;
    box.style.left=Math.max(8,Math.min(centre-width/2,innerWidth-width-8))+'px';
    box.style.top=Math.max(8,(composer?composer.top:innerHeight)-height-8)+'px';
    box.querySelector<HTMLButtonElement>('[role=switch]')?.focus();
    void q.refetch();
  },[headless,openSignal]);
  if(headless && data && !data.eligible) return <div ref={panel} popover="auto" role="dialog" className="bb-cr-panel"><p style={{margin:0}}>Автопереход для этого треда недоступен: он нужен только тредам Claude с резервной машиной.</p></div>;
  if(!data?.eligible || (turnId && turnId!==data.turnId)) return null;
  const {enabled,origin,backup,stage,resetAt}=data;
  async function toggle(){
    setBusy(true); setError('');
    try {
      await rpc.call('setRetryPreference',{threadId,...(turnId?{turnId}:{}),enabled:!enabled});
      await q.refetch();
    } catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  }
  function open(){
    const box=panel.current, button=trigger.current;
    if(!box||!button)return;
    if(box.matches(':popover-open')){box.hidePopover();return;}
    box.showPopover();
    const r=button.getBoundingClientRect();
    const width=box.offsetWidth,height=box.offsetHeight;
    box.style.left=Math.max(8,Math.min(r.left,innerWidth-width-8))+'px';
    box.style.top=Math.max(8,r.top>=height+10?r.top-height-6:Math.min(r.bottom+6,innerHeight-height-8))+'px';
    box.querySelector<HTMLButtonElement>('[role=switch]')?.focus();
    void q.refetch();
  }
  return <>
    {!headless && <button type="button" ref={trigger} onClick={open} aria-haspopup="dialog" aria-expanded={expanded} aria-controls={id}
      className="bb-cr-trigger" title="Настроить автопереход Claude">
      <Icon name="Network" className="size-3.5"/><span>{turnId?'Настроить автопереход':'Автопереход'}</span>
      {enabled && <span className="bb-cr-dot" aria-label="Включён"/>}
    </button>}
    <div ref={panel} popover="auto" onToggle={event=>setExpanded(event.currentTarget.matches(':popover-open'))} id={id} role="dialog" aria-labelledby={title} className="bb-cr-panel">
      <div className="bb-cr-heading"><strong id={title}>Автопереход Claude</strong>
        <button role="switch" aria-checked={enabled} aria-label="Автопереход в этом чате"
          className="bb-cr-switch" disabled={busy} onClick={toggle}><span/></button></div>
      <div className="bb-cr-route">
        <div><small>Основная</small><b>{origin}</b></div><Icon name="ChevronRight" className="size-4"/>
        <div><small>Резервная</small><b>{backup}</b></div>
      </div>
      <p>Когда у {origin} закончится квота, следующий ход примет {backup}. После сброса чат вернётся на {origin}.</p>
      <p>Резерв получит историю и вложения. Файлы и Git останутся на {origin}.</p>
      {enabled && <div className="bb-cr-status">{stage==='waiting'?'Ожидание квоты':'Текущая машина · '+(stage==='backup'?backup:origin)}
        {resetAt>0 && ' · до '+new Date(resetAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>}
      {error && <div role="alert" className="bb-cr-error">{error}</div>}
    </div>
  </>;
}
/** Mounted once: opens the route panel for the thread whose "+" menu was used. */
const OPEN='claude-origin-failover:open';
function MenuHost(){
  const [req,setReq]=useState<{threadId:string;n:number}|null>(null);
  useEffect(()=>{
    const on=(e:Event)=>setReq(r=>({threadId:(e as CustomEvent<string>).detail,n:(r?.n??0)+1}));
    addEventListener(OPEN,on);
    return ()=>removeEventListener(OPEN,on);
  },[]);
  return req?<RouteControl key={req.threadId} threadId={req.threadId} headless openSignal={req.n}/>:null;
}
export default definePluginApp(app=>{
  // The composer row stays bb's own: the control lives in the "+" menu (it used to overlap the text).
  app.slots.experimental_appOverlay({id:'claude-route-host',component:MenuHost});
  app.composer.customize({id:'claude-route',scopes:['thread'],plusMenu:[{
    id:'route',label:'Автопереход Claude…',icon:'Network',
    description:'Когда у основной машины кончится квота, следующий ход примет резервная',
    run({composer}){ if(composer.scope.kind==='thread') dispatchEvent(new CustomEvent(OPEN,{detail:composer.scope.threadId})); },
  }]});
  app.slots.experimental_messageMetadata({id:'quota-action',placement:'above',
    component:({message})=>message.role==='assistant' && message.turnId
      ?<RouteControl threadId={message.threadId} turnId={message.turnId}/>:null});
});

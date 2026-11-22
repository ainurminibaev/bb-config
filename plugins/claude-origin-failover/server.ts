import { join } from "node:path";
import {routeState, heldUntil} from "./bin/route-state.mjs";
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { retryUi } from "./ui-contract";

const binDir = "/srv/projects/bb-config/plugins/claude-origin-failover/bin";

const availabilityMethod = "provider-retry.v1.availability";
const availability = defineRpcContract({
  [availabilityMethod]: {
    input: z.object({ threadId: z.string(), requestId: z.string() }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("ready") }),
      z.object({ kind: z.literal("blocked"), retryAt:z.number().int().nonnegative() }),
      z.object({ kind: z.literal("not-routed") }),
    ]),
  },
});

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    pilotOrigin: {type:"string",label:"Основная машина Claude",default:""},
    pilotBackup: {type:"string",label:"Резервная машина Claude",default:""},
    testThread: { type: "string", label: "Isolated test thread", default: "" },
    quotaProbe: { type: "string", label: "One-shot synthetic quota experiment ID", default: "" },
    testRemoteHost: { type: "string", label: "Test account machine ID", default: "" },
  });
  const turnKey = (id: string) => "limit-turn:" + id;
  const restoreKey = (id:string) => "restore-origin:"+id;
  const optKey = (id: string) => "pilot-run:" + id;
  async function routeFor(threadId: string | null) {
    const config = await settings.get();
    if (!threadId || config.testThread === threadId) return config;
    const run = await bb.storage.kv.get<string>(optKey(threadId));
    if (!run?.startsWith("auto-") || !config.pilotBackup || !config.pilotOrigin) return config;
    return {...config, testThread:threadId, testRemoteHost:config.pilotBackup,quotaProbe:run};
  }
  async function activeRoute(threadId:string, run:string, origin:string) {
    const host=await bb.sdk.hosts.get({hostId:origin});
    if (!host.threadStorageRootPath) return routeState("", "");
    const root=join(host.threadStorageRootPath,threadId);
    const path=join(root,"quota-probe-"+run);
    const read=async (file:string) => {
      try { return (await bb.sdk.files.read({hostId:origin,path:file,rootPath:root})).content; }
      catch { return ""; }
    };
    const [originWindow,backupWindow]=await Promise.all([read(path),read(path+".backup")]);
    return routeState(originWindow,backupWindow);
  }
  // Отметка «машина в лимите до …» пишется по отказу CLI и потом не
  // перепроверяется. Если лимит сняли досрочно (сброс, смена тарифа), тред
  // ждал бы до записанного времени. Сверяем с фактическим остатком машины.
  const liveChecked = new Map<string, number>();
  async function liveFree(hostId: string) {
    try {
      const raw = await bb.sdk.system.usageLimits({hostId, refresh: true, signal: AbortSignal.timeout(20_000)}) as
        unknown as Record<string, {status?: string; windows?: {usedPercent?: number}[]}>;
      const entry = raw["claude-code"];
      if (entry?.status !== "ok" || !entry.windows?.length) return false;
      return entry.windows.every(w => typeof w.usedPercent === "number" && w.usedPercent < 100);
    } catch { return false; }
  }
  async function reconcile(threadId: string, run: string) {
    const key = threadId + ":" + run;
    if (Date.now() - (liveChecked.get(key) ?? 0) < 5 * 60_000) return;
    liveChecked.set(key, Date.now());
    const {pilotOrigin, pilotBackup} = await settings.get();
    const host = await bb.sdk.hosts.get({hostId: pilotOrigin});
    if (!host.threadStorageRootPath) return;
    const root = join(host.threadStorageRootPath, threadId);
    const base = join(root, "quota-probe-" + run);
    for (const [file, machine] of [[base, pilotOrigin], [base + ".backup", pilotBackup]] as const) {
      let content = "";
      try { content = (await bb.sdk.files.read({hostId: pilotOrigin, path: file, rootPath: root})).content; } catch { continue; }
      if (!heldUntil(content, Date.now()) || !machine || !await liveFree(machine)) continue;
      await bb.sdk.files.write({hostId: pilotOrigin, rootPath: root, path: file, content: "", mode: 0o600});
    }
  }
  async function eligible(threadId: string) {
    const config = await settings.get();
    if (!config.pilotOrigin || !config.pilotBackup || config.pilotOrigin===config.pilotBackup) return false;
    const result = await bb.sdk.threads.get({threadId});
    const thread = "thread" in result ? result.thread : result;
    if(thread.providerId !== "claude-code" || !thread.environmentId) return false;
    const env = await bb.sdk.environments.get({environmentId:thread.environmentId});
    return env.hostId === config.pilotOrigin;
  }
  const refresh = (id: string) => bb.rpc.experimental_invalidate(["preference:" + id]);
  bb.events.on("turn.failed", async event => {
    if (event.errorInfo?.category !== "rate-limit" || !event.turnId) {
      if(await bb.storage.kv.get("failed-window:"+event.threadId))
        await bb.storage.kv.set("failed-window:"+event.threadId,null);
      return;
    }
    const result = await bb.sdk.threads.get({threadId:event.threadId});
    const thread = "thread" in result ? result.thread : result;
    if (thread.providerId !== "claude-code") return;
    const limits=event.rateLimits;
    const resets=limits?.kind==="subscription-window" && limits.status==="blocked"
      ? limits.windows.filter(w=>w.status==="blocked" && w.resetsAtMs && w.resetsAtMs>Date.now()).map(w=>w.resetsAtMs as number) : [];
    await bb.storage.kv.set("failed-window:"+thread.id,{requestId:event.requestId,turnId:event.turnId,resetAt:resets.length?Math.max(...resets):0});
    await bb.storage.kv.set(turnKey(thread.id), event.turnId);
    refresh(thread.id);
  });
  bb.rpc.register(retryUi, {
    retryPreference: async ({threadId}) => {
      const enabled=await bb.storage.kv.get<string>(optKey(threadId)) ?? "";
      const {pilotOrigin,pilotBackup}=await settings.get();
      const allowed=await eligible(threadId);
      const route=enabled.startsWith("auto-") && allowed ? await activeRoute(threadId,enabled,pilotOrigin) : routeState("","");
      const name=async (id:string)=> (await bb.sdk.hosts.get({hostId:id}).catch(()=>null))?.name ?? id;
      const [origin,backup]=allowed?await Promise.all([name(pilotOrigin),name(pilotBackup)]):["",""];
      return {turnId:await bb.storage.kv.get<string>(turnKey(threadId)) ?? null,enabled:enabled.startsWith("auto-"),
        eligible:allowed,origin,backup,stage:route.stage,resetAt:route.resetAt};
    },
    setRetryPreference: async ({threadId, turnId, enabled}) => {
      if (!await eligible(threadId)) throw new Error("Автопереход доступен в чате Claude на исходной машине.");
      if (turnId && await bb.storage.kv.get(turnKey(threadId)) !== turnId)
        throw new Error("Выбранное сообщение больше не относится к последнему лимиту треда.");
      const previous = await bb.storage.kv.get<string>(optKey(threadId)) ?? "";
      if (previous.startsWith("auto-") === enabled) return enabled;
      const result = await bb.sdk.threads.get({threadId});
      const thread = "thread" in result ? result.thread : result;
      if (!["idle","error","stopped"].includes(thread.status))
        throw new Error("Дождитесь окончания текущего хода перед изменением режима.");
      const run=enabled?"auto-"+randomUUID():"";
      const failure=enabled && thread.status==="error"?await bb.storage.kv.get<{turnId:string,requestId:string,resetAt:number}>("failed-window:"+threadId):null;
      const resume=failure && failure.resetAt>Date.now() && (!turnId || turnId===failure.turnId) ? failure:null;
      if(resume) {
        const {pilotOrigin,pilotBackup}=await settings.get();
        const [host,backup]=await Promise.all([bb.sdk.hosts.get({hostId:pilotOrigin}),bb.sdk.hosts.get({hostId:pilotBackup})]);
        if(!host.threadStorageRootPath || backup.status!=="connected") throw new Error("Резервная машина недоступна.");
        const root=join(host.threadStorageRootPath,threadId);
        await bb.sdk.files.write({hostId:pilotOrigin,rootPath:root,path:join(root,"quota-probe-"+run),
          content:JSON.stringify({resetAt:resume.resetAt}),mode:0o600});
      }
      await bb.storage.kv.set(optKey(threadId),run);
      try {
        // The native bridge can retain its previous executable in an idle runtime.
        await bb.sdk.threads.stop({threadId});
      } catch (error) {
        await bb.storage.kv.set(optKey(threadId), previous);
        throw error;
      }
      if (!enabled && previous.startsWith("auto-")) await bb.storage.kv.set(restoreKey(threadId),"pending");
      if (enabled) await bb.storage.kv.set(restoreKey(threadId),"");
      refresh(threadId);
      if(resume) {
        const queuedRetry = async (requestId:string) =>
          (await bb.sdk.threads.queuedMessages.list({threadId})).find(row =>
            row.payload.kind==="retry" && row.payload.retryOfTurnRequestId===requestId);
        let pending=await queuedRetry(resume.requestId);
        if (!pending) {
          try {
            await bb.sdk.threads.retry({threadId,turnRequestId:resume.requestId});
          } catch (error) {
            // BB keys queued retries by the first request in the chain.
            const conflict=/Turn (\S+) already has a retry waiting on thread (\S+)\./.exec(String(error));
            if (!conflict || conflict[2]!==threadId) throw error;
            pending=await queuedRetry(conflict[1]);
            if (!pending) {
              const current=await bb.sdk.threads.get({threadId});
              if (("thread" in current?current.thread:current).status!=="active") throw error;
            }
          }
        }
        if (pending) await bb.sdk.threads.queuedMessages.send({threadId,queuedMessageId:pending.id,mode:"auto"});
      }
      return enabled;
    },
  }, { experimental_discoverable:true });
  // The built-in retry plugin is the only component that queues a turn.
  // Scope the probe by both thread and experiment, so stale runs cannot claim a new failure.
  const probeKey = (thread: string, probe: string) => "probe:" + thread + ":" + probe;
  bb.rpc.register(availability, {
    [availabilityMethod]: async ({ threadId, requestId }) => {
      const { testThread, testRemoteHost, quotaProbe } = await routeFor(threadId);
      if (threadId !== testThread || !quotaProbe) return { kind: "not-routed" as const };
      const key = probeKey(threadId, quotaProbe);
      if (quotaProbe.startsWith("auto-")) {
        await reconcile(threadId, quotaProbe).catch(() => undefined);
        const {pilotOrigin}=await settings.get();
        const route=await activeRoute(threadId,quotaProbe,pilotOrigin);
        if(route.stage==="waiting") return {kind:"blocked" as const,retryAt:route.resetAt};
        if(route.stage!=="backup") return {kind:"not-routed" as const};
        const backup=await bb.sdk.hosts.get({hostId:testRemoteHost}).catch(()=>null);
        if(backup?.status!=="connected") return {kind:"not-routed" as const};
        const assigned=await bb.storage.kv.get<string>(key);
        if(assigned && assigned!==requestId) return {kind:"not-routed" as const};
        await bb.storage.kv.set(key,requestId);
        return {kind:"ready" as const};
      }
      const state = await bb.storage.kv.get<string>(key);
      if (state !== "armed" && state !== requestId) return { kind: "not-routed" as const };
      const host = await bb.sdk.hosts.get({hostId:testRemoteHost}).catch(()=>null);
      if (host?.status !== "connected") return { kind: "not-routed" as const };
      await bb.storage.kv.set(key, requestId);
      return { kind: "ready" as const };
    },
  }, { experimental_discoverable: true });
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const { testThread, testRemoteHost, quotaProbe } = await routeFor(thread.id);
    if (await bb.storage.kv.get(restoreKey(thread.id))==="launched" && lastAssistantText)
      await bb.storage.kv.set(restoreKey(thread.id),"");
    if (!quotaProbe || !testRemoteHost || thread.id !== testThread || !lastAssistantText) return;
    const key = probeKey(testThread, quotaProbe);
    if (quotaProbe.startsWith("auto-")) { refresh(thread.id); return; }
    const state = await bb.storage.kv.get<string>(key);
    if (state?.startsWith("creq_")) await bb.storage.kv.set(key, "returned");
  });
  bb.providers.experimental_contributeEnv("claude-code", async context => {
    const { testThread, testRemoteHost, quotaProbe, pilotOrigin } = await routeFor(context.threadId);
    if ((quotaProbe?.startsWith("ui-") || quotaProbe?.startsWith("auto-")) && context.hostId !== pilotOrigin) return [];
    if (!testThread || context.threadId !== testThread) {
      if (!context.threadId || context.hostId!==pilotOrigin || !await bb.storage.kv.get(restoreKey(context.threadId))) return [];
      await bb.storage.kv.set(restoreKey(context.threadId),"launched");
      return [{name:"BB_CLAUDE_CODE_EXECUTABLE",value:binDir+"/probe-return.mjs",reason:"Restore this conversation on the original machine"},
        {name:"BB_ORIGIN_PROBE_THREAD",value:context.threadId,reason:"Restore the current thread"}];
    }
    if (quotaProbe) {
      const key = probeKey(testThread, quotaProbe);
      const state = await bb.storage.kv.get<string>(key);
      const permanent=quotaProbe.startsWith("auto-");
      if (permanent) await reconcile(testThread, quotaProbe).catch(() => undefined);
      const route=permanent?await activeRoute(testThread,quotaProbe,context.hostId):null;
      if(permanent && route.stage==="origin" && state) await bb.storage.kv.set(key,"");
      if (!permanent && !state) await bb.storage.kv.set(key, "armed");
      if (!/^[a-zA-Z0-9_-]+$/.test(quotaProbe) || !/^host_[a-z0-9]+$/.test(testRemoteHost))
        throw new Error("The isolated quota probe requires a run ID and a BB host");
      let workspace="";
      if(permanent) {
        const result=await bb.sdk.threads.get({threadId:testThread});
        const thread="thread" in result?result.thread:result;
        if(thread.environmentId) workspace=(await bb.sdk.environments.get({environmentId:thread.environmentId})).path ?? "";
      }
      return Object.entries({
        BB_CLAUDE_CODE_EXECUTABLE:binDir + (permanent?"/persistent-launch.mjs":"/probe-launch"),
        BB_ORIGIN_PROBE_STAGE:route?.stage ?? (state === "returned" ? "origin" : "experiment"),
        ...(workspace ? {BB_ORIGIN_WORKSPACE:workspace} : {}),
        BB_ORIGIN_SOURCE_HOST:context.hostId, BB_ORIGIN_PROBE_ID:quotaProbe, BB_ORIGIN_PROBE_THREAD:testThread,
        BB_ORIGIN_REMOTE_HOST:testRemoteHost, BB_ORIGIN_RELAY_MCP:"0",
        BB_ORIGIN_REMOTE_CWD:"/tmp/bb-origin-relay/" + testThread + "/" + quotaProbe,
      }).map(([name,value])=>({name,value,reason:"Isolated native retry experiment"}));
    }
    if (!testRemoteHost || context.hostId === testRemoteHost) {
      return [{
        name: "BB_CLAUDE_CODE_EXECUTABLE",
        value: binDir + "/claude-origin",
        reason: "Verify native Claude startup in the isolated thread",
      }];
    }
    if (!/^host_[a-z0-9]+$/.test(testRemoteHost))
      throw new Error("Expected a BB machine ID");
    return Object.entries({
      BB_CLAUDE_CODE_EXECUTABLE: binDir + "/claude-origin-relay.mjs",
      BB_ORIGIN_REMOTE_HOST: testRemoteHost,
      BB_ORIGIN_REMOTE_CWD: "/tmp/bb-origin-relay/" + context.threadId,
      ...(quotaProbe ? {BB_ORIGIN_PROBE_THREAD:testThread} : {}),
      BB_ORIGIN_RELAY_MCP: "0",
    }).map(([name, value]) => ({name, value, reason: "Isolated cross-machine conversation test"}));
  });
}

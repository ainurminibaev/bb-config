import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const proxyInput = z.object({
  name: z.string().trim().min(1).max(80),
  protocol: z.enum(['http', 'https']),
  host: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.-]+$/, 'Укажите IP или имя хоста без протокола'),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(512).default(''),
  password: z.string().max(512).default(''),
}).strict();
export const storedProxy = proxyInput.extend({ id: z.string() });
export type StoredProxy = z.infer<typeof storedProxy>;
export const publicProxy = storedProxy.omit({ username: true, password: true }).extend({ authenticated: z.boolean() });
export const checkSchema = z.object({
  ok: z.boolean(), ip: z.string().nullable(), country: z.string().nullable(), city: z.string().nullable(),
  openaiStatus: z.number().nullable(), message: z.string(), checkedAt: z.string(), latencyMs: z.number(),
});
export type Check = z.infer<typeof checkSchema>;
export const claudeRouteSchema = z.object({
  state: z.enum(['direct', 'proxy', 'unknown', 'inactive', 'unsupported']),
  message: z.string(), checkedAt: z.string(),
});
export type ClaudeRoute = z.infer<typeof claudeRouteSchema>;
export const modelRouteInput = z.object({ hostId: z.string().min(1), providerId: z.enum(['codex', 'claude-code']), mode: z.enum(['direct', 'opencodex']) });
export const modelRouteState = modelRouteInput.extend({ message: z.string(), updatedAt: z.string() });
/** What a user may pick: a route, or `inherit` to stop overriding the CLI's own configuration. */
export const modelRouteChoice = modelRouteInput.extend({ mode: z.enum(['direct', 'opencodex', 'inherit']) });
export type ModelRouteState = z.infer<typeof modelRouteState>;
const modelRoutePrepared = z.object({ env: z.array(z.object({ name: z.string(), value: z.string(), reason: z.string() })), message: z.string() });
export const gatewayStatus = z.object({ state: z.enum(['unconfigured', 'unavailable', 'available', 'offline', 'unknown']), message: z.string() });
export type GatewayStatus = z.infer<typeof gatewayStatus>;
export const hostContract = defineRpcContract({
  inspect_gateway: { input: z.object({ providerId: z.enum(['codex', 'claude-code']), force: z.boolean().optional() }), output: gatewayStatus },
  prepare_model_route: { input: z.object({ providerId: z.enum(['codex', 'claude-code']), mode: z.enum(['direct', 'opencodex']) }), output: modelRoutePrepared },
  claude_route: { input: z.object({ path: z.string().nullable(), threadId: z.string().nullable() }), output: claudeRouteSchema },
  check: { input: z.object({ proxy: storedProxy.nullable(), previous: checkSchema.optional() }), output: checkSchema },
  prepare_native: { input: z.object({ proxy: storedProxy.nullable() }), output: z.object({ home: z.string(), fingerprint: z.string() }) },
  apply_native: { input: z.object({ proxy: storedProxy.nullable(), fingerprint: z.string() }), output: z.object({ home: z.string(), fingerprint: z.string() }) },
  verify_native: { input: z.object({ fingerprint: z.string() }), output: z.object({ matches: z.boolean() }) },
});
export const bindingSchema = z.object({ hostId: z.string(), providerId: z.string(), proxyId: z.string().nullable() });
export const routeStateSchema = z.object({ phase: z.enum(['switching', 'ready', 'error']), proxyId: z.string().nullable(), fingerprint: z.string().optional(), home: z.string().optional(), message: z.string(), updatedAt: z.string() });
export type RouteState = z.infer<typeof routeStateSchema>;
export const routeContextSchema = z.object({
  modelMode: z.enum(['direct', 'opencodex']).nullable().optional(),
  hostId: z.string(), hostName: z.string(), providerId: z.string(), proxyId: z.string().nullable(), proxyName: z.string().nullable(), connected: z.boolean(),
  claudeRoute: claudeRouteSchema.nullable().optional(), check: checkSchema.nullable(), applied: z.boolean(), warning: z.string().nullable(),
  /** A turn is running in the thread (only for a thread id). Older servers omit it. */
  busy: z.boolean().optional(),
});
export type RouteContext = z.infer<typeof routeContextSchema>;
export const rpcContract = defineRpcContract({
  gateway_status: { input: z.object({ hostId: z.string().min(1), providerId: z.enum(['codex', 'claude-code']), force: z.boolean().optional() }), output: gatewayStatus },
  model_routes: { input: z.null(), output: z.array(modelRouteState) },
  set_model_route: { input: modelRouteChoice, output: modelRouteState.nullable() },
  route_context: { input: z.object({ threadId: z.string().nullable(), hostId: z.string().nullable(), environmentId: z.string().nullable(), providerId: z.string().nullable() }), output: routeContextSchema.nullable() },
  list: { input: z.null(), output: z.object({ proxies: z.array(publicProxy), bindings: z.array(bindingSchema), checks: z.record(z.string(), checkSchema), routes: z.record(z.string(), routeStateSchema) }) },
  machines: { input: z.null(), output: z.array(z.object({ id: z.string(), name: z.string(), connected: z.boolean() })) },
  providers: { input: z.object({ hostId: z.string(), force: z.boolean().optional() }), output: z.array(z.object({ id: z.string(), name: z.string(), installed: z.boolean(), available: z.boolean(), message: z.string() })) },
  bind: { input: bindingSchema, output: bindingSchema },
  add: { input: proxyInput, output: publicProxy },
  remove: { input: z.object({ id: z.string() }), output: z.object({ removed: z.boolean() }) },
  check: { input: z.object({ hostId: z.string(), proxyId: z.string().nullable() }), output: checkSchema },
});
export function redact(p: StoredProxy) { const { username, password, ...rest } = p; return { ...rest, authenticated: !!(username || password) }; }
export function parseProxyFile(text: string, name: string): z.infer<typeof proxyInput> {
  const fields = Object.fromEntries([...text.matchAll(/^(Host|Port|Username|Password):[ \t]*(.*)$/gm)].map(m => [m[1]!.toLowerCase(), m[2]!.trim()]));
  return proxyInput.parse({ name, protocol: 'http', host: fields.host, port: Number(fields.port), username: fields.username ?? '', password: fields.password ?? '' });
}

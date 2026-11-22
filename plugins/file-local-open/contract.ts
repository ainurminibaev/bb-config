import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const sourceSchema = z.object({ kind: z.enum(['workspace', 'host', 'thread-storage']), threadId: z.string().nullable(), environmentId: z.string().nullable(), projectId: z.string().nullable(), experimental_hostId: z.string().optional() });
/** An application on the desktop computer, as listed by `apps`; null or absent — the system default. */
export const appSchema = z.string().min(1).max(1024).nullable().optional();
export const targetSchema = z.object({ path: z.string().min(1).max(8192), source: sourceSchema, action: z.enum(['open', 'save', 'clipboard']).default('open'), app: appSchema });
export const bundleSchema = z.object({ main: z.string(), entries: z.array(z.object({ path: z.string(), content: z.string(), sha256: z.string() })).max(300) });
export const desktopAppSchema = z.object({ id: z.string(), name: z.string(), path: z.string(), isDefault: z.boolean(), browser: z.boolean(), icon: z.string() });
const opened = z.object({ path: z.string(), application: z.string() });
export const hostContract = defineRpcContract({
  info: { input: z.null(), output: z.object({ platform: z.string() }) },
  read: { input: z.object({ path: z.string() }), output: bundleSchema },
  open: { input: z.object({ bundle: bundleSchema, action: z.enum(['open', 'save', 'clipboard']), app: appSchema }), output: opened },
  launch: { input: z.object({ path: z.string(), app: appSchema, action: z.enum(['open', 'clipboard']).default('open') }), output: opened },
  apps: { input: z.object({ extension: z.string().regex(/^[a-z0-9]{1,8}$/) }), output: z.object({ apps: z.array(desktopAppSchema) }) },
});
export const rpcContract = defineRpcContract({
  open: { input: targetSchema, output: opened },
  apps: { input: z.object({ extension: z.string().regex(/^[a-z0-9]{1,8}$/) }), output: z.object({ apps: z.array(desktopAppSchema), platform: z.string() }) },
});

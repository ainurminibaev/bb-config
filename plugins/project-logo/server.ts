import { posix } from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ICON_FILES, imageType, MAX_BYTES } from "./policy.ts";

export const instructions = `At the beginning of this thread, automatically call project_logo_status once. This is an authorized project setup task; do not ask for confirmation. If a project icon exists, continue the user's work. Otherwise use BOTH the project name returned by the tool and the FIRST user message in this thread to infer the project's purpose; briefly inspect README or project artwork when helpful. Select or CREATE a meaningful compact icon automatically. Prefer a project-owned mark, then an authentic official emblem when the project is clearly about that brand. Do not invent or approximate an existing brand logo. For an original project or when no suitable authentic asset is available, design an original simple SVG symbol based on the project's purpose and first-message context. Use bold shapes, no text, a transparent background and a monochrome design legible at 20px. You can author this vector directly; no image-generation service is required. Call project_logo_install with svg containing the complete passive self-contained SVG and sourceUrl='generated from project context'. For downloaded SVG/PNG use filePath relative to the source checkout and the source page URL; save the temporary download INSIDE the source root ON THE HOST returned by project_logo_status, then remove only your temporary file. Maximum 256 KiB. When context is sparse, use the best-supported project theme instead of asking the user to choose an icon. Respect explicit instructions to avoid changes. If tools or the source host are unavailable, report the limitation briefly and continue the main task; a missing icon remains eligible for retry. Never commit or push automatically. The icon is shared by the whole project and its threads; do not replace it for each new conversation. Installation refreshes Machine Tabs. A status check alone is not a completed installation.`;
export const CHECK_VERSION = 2;
export default function projectLogo(bb: BbPluginApi) {
  const locks = new Map<string, Promise<unknown>>();
  async function projectSource(projectId: string, threadId?: string) {
    const project = await bb.sdk.projects.get({ projectId });
    if (project.kind !== "standard") throw new Error("Personal projects have no automatic logo");
    const sources = [...project.sources].sort((a,b) => Number(b.isDefault) - Number(a.isDefault));
    let hostId: string | undefined;
    if (threadId) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.projectId === projectId) {
        if (!thread.environmentId) throw new Error("Current thread has no environment");
        hostId = (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
      }
    }
    const source = sources.find(s => s.type === "local_path" && s.hostId && s.path && (!hostId || s.hostId === hostId));
    if (!source && hostId) throw new Error(`No project source checkout on current thread host ${hostId}`);
    if (!source?.hostId || !source.path) throw new Error("No project source checkout available");
    return { projectId, projectName: project.name, hostId: source.hostId, rootPath: source.path.replace(/\/+$/, "") };
  }
  async function inspect(projectId: string, threadId?: string) {
    const source = await projectSource(projectId, threadId);
    // Listing succeeds even for an empty directory; offline/permission errors
    // must never be treated as 'no icon'.
    const root = await bb.sdk.files.list({ hostId: source.hostId, path: source.rootPath, includeHidden: true });
    void root;
    for (const name of ICON_FILES) {
      try {
        const file = await bb.sdk.files.read({ hostId: source.hostId, rootPath: source.rootPath, path: `${source.rootPath}/${name}` });
        if (file.sizeBytes > 0 && file.sizeBytes <= MAX_BYTES) return { ...source, icon: name };
      } catch (error) {
        // Only absence is safe. Do not overwrite an inaccessible existing asset.
        const code = String((error as { code?: unknown }).code ?? "");
        const message = String((error as Error).message);
        if (!/ENOENT|not_found|not found|does not exist/i.test(`${code} ${message}`)) throw error;
      }
    }
    return { ...source, icon: null };
  }
  async function install(projectId: string, filePath: string | undefined, sourceUrl: string, svg?: string, threadId?: string) {
    // Serialize two new threads choosing a logo for the same project.
    const previous = locks.get(projectId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const source = await inspect(projectId, threadId);
      if (source.icon) return { status: "existing", ...source };
      if (Boolean(filePath) === (svg !== undefined)) throw new Error("Provide exactly one of filePath or svg");
      let bytes: Buffer;
      if (svg !== undefined) {
        bytes = Buffer.from(svg, "utf8");
        if (imageType(bytes) !== "svg") throw new Error("Expected generated SVG");
      } else {
        const relative = posix.normalize(filePath!);
        if (posix.isAbsolute(relative) || relative === ".." || relative.startsWith("../") || relative.includes("\\")) {
          throw new Error("Image path must be relative to the project source root");
        }
        const file = await bb.sdk.files.read({ hostId: source.hostId, rootPath: source.rootPath, path: `${source.rootPath}/${relative}` });
        if (!("content" in file) || typeof file.content !== "string") throw new Error("Image content unavailable");
        if (file.sizeBytes > MAX_BYTES) throw new Error("Image exceeds 256 KiB");
        bytes = Buffer.from(file.content, file.contentEncoding === "base64" ? "base64" : "utf8");
      }
      const type = imageType(bytes);
      const icon = `.bb/icon.${type}`;
      await bb.sdk.files.write({ hostId: source.hostId, rootPath: source.rootPath,
        path: `${source.rootPath}/${icon}`, content: bytes.toString("base64"),
        contentEncoding: "base64", createParents: true, expectedSha256: null });
      await bb.storage.kv.set(`source:${projectId}`, { sourceUrl, icon, installedAt: Date.now() });
      try {
        await bb.sdk.plugins.callRpc({ pluginId: "machine-tabs", method: "project_icons", input: { refresh: true },
          outputSchema: z.object({ icons: z.record(z.string(), z.string()) }) });
      } catch (error) { bb.log.warn(`Logo saved; Machine Tabs refresh deferred: ${String(error)}`); }
      return { status: "installed", ...source, icon };
    });
    locks.set(projectId, work);
    try { return await work; } finally { if (locks.get(projectId) === work) locks.delete(projectId); }
  }
  bb.agents.registerTool({
    name: "project_logo_status", description: "Check the current project's shared icon and resolve its actual source host/root before automatic context-based logo selection.",
    parameters: z.object({}),
    async execute(_, ctx) {
      if (!ctx.projectId) return JSON.stringify({ status: "unavailable" });
      const result = await inspect(ctx.projectId, ctx.threadId);
      if (result.icon) await bb.sdk.threads.updatePluginMetadata({ threadId: ctx.threadId, set: { checked: true, checkVersion: CHECK_VERSION } });
      return JSON.stringify({ status: result.icon ? "existing" : "missing", ...result });
    },
  });
  bb.agents.registerTool({
    name: "project_logo_install", description: "Install a project icon from a source file or an original contextual SVG, preserving existing icons. PNG or passive SVG, max 256 KiB. Refreshes the project badge.",
    parameters: z.object({ filePath: z.string().min(1).max(1024).optional(), svg: z.string().min(1).max(MAX_BYTES).optional(), sourceUrl: z.string().min(1).max(2048) }),
    async execute(input, ctx) {
      if (!ctx.projectId) throw new Error("No project");
      const result = await install(ctx.projectId, input.filePath, input.sourceUrl, input.svg, ctx.threadId);
      await bb.sdk.threads.updatePluginMetadata({ threadId: ctx.threadId, set: { checked: true, checkVersion: CHECK_VERSION } });
      return JSON.stringify(result);
    },
  });
  // The skill stays available after the automatic check: explicit "add/replace
  // the project logo" requests use it with the bb project-logo CLI.
  bb.agents.configure(ctx => ctx.project.kind !== "standard" ? { tools: [], skills: [] }
    : ctx.pluginMetadata.checked === true && ctx.pluginMetadata.checkVersion === CHECK_VERSION
      ? { tools: [], skills: ["project-logo"] }
      : { tools: ["project_logo_status", "project_logo_install"], skills: ["project-logo"], instructions });
  bb.cli.register({ name: "project-logo", summary: "Inspect or install a project's shared logo",
    commands: [
      { name: "status", summary: "Check icon and source", usage: "status <project-id>" },
      { name: "install", summary: "Install without replacing an existing icon", usage: "install <project-id> <relative-image-path> <source-url>" },
      { name: "create", summary: "Install an original contextual SVG", usage: "create <project-id> <svg>" },
    ],
    async run(argv, ctx) {
      const [command, projectId, filePath, sourceUrl] = argv;
      if (!projectId || (command !== "status" && command !== "install" && command !== "create") ||
          (command === "install" && (!filePath || !sourceUrl)) || (command === "create" && !filePath)) {
        return { exitCode: 2, stderr: "Usage: bb project-logo status <project-id> | install <project-id> <relative-image-path> <source-url> | create <project-id> <svg>\n" };
      }
      const result = command === "status" ? await inspect(projectId, ctx.threadId) : command === "create" ? await install(projectId, undefined, "generated from project context", filePath, ctx.threadId) : await install(projectId, filePath!, sourceUrl!, undefined, ctx.threadId);
      return { exitCode: 0, stdout: JSON.stringify(result, null, 2) + "\n" };
    },
  });
}

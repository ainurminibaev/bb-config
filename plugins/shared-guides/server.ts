import type { BbPluginApi } from "@get-bb/plugin-sdk";

// Skills-only plugin: BB loads skills/ from the manifest; nothing runs here.
export default async function sharedGuides(_bb: BbPluginApi) {}

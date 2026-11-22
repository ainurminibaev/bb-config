import type { BbPluginApi } from '@get-bb/plugin-sdk';

/** bb requires a server entry; all of this plugin's work happens in app.tsx. */
export default function subthreadErrorMark(_bb: BbPluginApi): void {}

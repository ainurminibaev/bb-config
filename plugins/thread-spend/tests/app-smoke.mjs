import assert from "node:assert/strict";
import { collectPluginAppRegistrations } from "@get-bb/plugin-sdk/internal/plugin-app-collector";

const summary = {
  row: { tokens: { total: 1250 }, turns: 1, turnsWithTokens: 1, lowerBoundTurns: 0, readLimited: false },
  buckets: [...Array(11).fill(null), 1250],
};
const queries = {
  summary: { data: summary, error: null, isLoading: false },
  threads: { data: { rows: [], providers: [], failed: 0 }, error: null, isLoading: false },
};
const jsx = (type, props) => ({ type, props });
const noop = () => {};
globalThis.__bbPluginRuntime = {
  pluginSdkApp: {
    definePluginApp: setup => ({ __bbPluginApp: true, setup }),
    experimental_Icon: noop,
    experimental_useRpcQuery: ({ method, input }) => {
      if (method === "summary") assert.equal(input.threadId, "thr_synthetic");
      return { ...queries[method], refetch: noop };
    },
    useBbNavigate: () => ({ toThread: noop, toPluginPanel: noop }),
  },
  react: { useEffect: noop, useRef: () => ({ current: null }), useState: initial => [initial, noop] },
  jsxRuntime: { jsx, jsxs: jsx, Fragment: Symbol("fragment") },
};

const { default: app } = await import("../dist/app.js");
const slots = collectPluginAppRegistrations(app);
assert.equal(slots.threadHeaderActions.length, 1);
assert.equal(slots.navPanels.length, 1);
const header = slots.threadHeaderActions[0].component({ threadId: "thr_synthetic", projectId: "proj_synthetic" });
const [indicator, dialog] = header.props.children;
assert.equal(indicator.props["data-thread-spend-indicator"], "");
assert.match(indicator.props["aria-label"], /250.*токенов/);
assert.equal(dialog.type, "dialog");

const overview = slots.navPanels[0].component({ subPath: "" });
assert.match(JSON.stringify(overview.type(overview.props)), /подходящих тредов не найдено/);
let fallback;
app.setup({ slots: { navPanel: noop, experimental_threadAction: item => { fallback = item; } } });
assert.equal(fallback.placement, "header");
let destination;
const action = fallback.item({ thread: { id: "thr_synthetic" }, navigate: { toPluginPanel: (...args) => { destination = args; } } });
action.run();
assert.deepEqual(destination, ["overview", { subPath: "thread/thr_synthetic" }]);
console.log("BB 0.49 frontend artifact: header slot, indicator, overview empty state, header-action fallback");

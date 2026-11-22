import { createElement, useId, useState } from "react";
import type { ComponentType } from "react";

const PAGE_SIZE = 5;
type Props = Record<string, any>;
type JsxFactory = (type: any, props: any, key?: any) => any;

/** Page the native render input, before its windowing/navigation is calculated.
 * Never hide mounted rows: that leaves invisible keyboard and drag targets.
 */
function PagedList({ Component, nativeProps, pinned }: {
  Component: ComponentType<any>;
  nativeProps: Props;
  pinned: boolean;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const id = useId();
  const items = pinned ? nativeProps.rootItems : nativeProps.itemKeys;
  const count = items.length;
  const visible = Math.min(limit, count);
  const pagedProps = pinned
    ? {
        ...nativeProps,
        rootItems: items.slice(0, visible),
        // Pinned's ungrouped renderer uses rootNodes rather than rootItems.
        rootNodes: nativeProps.rootNodes?.slice(0, visible),
      }
    : { ...nativeProps, itemKeys: items.slice(0, visible),
        alwaysMountedKeys: nativeProps.alwaysMountedKeys
          ? new Set([...nativeProps.alwaysMountedKeys].filter((key) => items.slice(0, visible).includes(key)))
          : undefined };
  return (
    <div data-machine-tabs-page="">
      <div id={id}>{createElement(Component, pagedProps)}</div>
      {count > PAGE_SIZE ? (
        <div className="machine-tabs-pager">
          {visible < count ? (
            <button type="button" aria-controls={id}
              onClick={() => setLimit(visible + PAGE_SIZE)}>
              <span aria-hidden="true">↓</span> Показать ещё
            </button>
          ) : null}
          {visible > PAGE_SIZE ? (
            <button type="button" aria-controls={id}
              onClick={() => setLimit(PAGE_SIZE)}>
              <span aria-hidden="true">↑</span> Свернуть
            </button>
          ) : null}
          <span className="machine-tabs-page-count" aria-live="polite">
            {visible} / {count}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** The native bundle captures this runtime only during its queued import.
 * Match semantic props, never minified function names. All other JSX is intact.
 */
export function withGroupPaging(runtime: Record<string, any>) {
  const base = "default" in runtime ? runtime.default : runtime;
  const wrap = (factory: JsxFactory): JsxFactory => (type, props, key) => {
    const list = props && typeof type !== "string" &&
      typeof props.onToggleThreadCollapsed === "function" &&
      props.collapsedThreadIds instanceof Set;
    const pinned = list && Array.isArray(props.rootItems) &&
      Array.isArray(props.rootNodes) && "onReorderPinnedRoot" in props;
    const normal = props && typeof type !== "string" &&
      Array.isArray(props.itemKeys) && typeof props.renderItem === "function" &&
      typeof props.getNavigationEntries === "function" &&
      typeof props.estimateRows === "function";
    return pinned || normal
      ? factory(PagedList, { Component: type, nativeProps: props, pinned }, key)
      : factory(type, props, key);
  };
  const wrapped = { ...base, jsx: wrap(base.jsx), jsxs: wrap(base.jsxs) };
  return "default" in runtime ? { ...runtime, ...wrapped, default: wrapped } : wrapped;
}

export const GROUP_PAGING_CSS = `
.machine-tabs-pager {
  display: flex; align-items: center; gap: 12px;
  height: 14px; padding: 0 12px 0 20px;
  font-size: 9.5px; line-height: 14px; color: var(--muted-foreground);
  opacity: 0; transition: opacity 120ms ease;
}
[data-machine-tabs-page]:hover > .machine-tabs-pager,
[data-machine-tabs-page]:focus-within > .machine-tabs-pager,
[data-sidebar-sticky-group]:hover > div > [data-machine-tabs-page] > .machine-tabs-pager {
  opacity: .65;
}
.machine-tabs-pager button {
  display: inline-flex; align-items: center; gap: 3px;
  border: 0; background: transparent; padding: 0 2px;
  cursor: pointer; white-space: nowrap; border-radius: 3px; color: inherit;
}
.machine-tabs-pager button:hover { text-decoration: underline; text-underline-offset: 3px; }
.machine-tabs-pager:focus-within, .machine-tabs-pager:hover { opacity: 1; }
.machine-tabs-pager button:focus-visible { outline: 2px solid var(--sidebar-ring); outline-offset: 2px; }
.machine-tabs-page-count { margin-left: auto; flex-shrink:0; white-space:nowrap; font-size: 9px; font-variant-numeric: tabular-nums; opacity: .7; }
@media (hover: none) { .machine-tabs-pager { opacity: .7; min-height: 32px; gap:6px; padding-inline:8px; } }
@media (prefers-reduced-motion: reduce) { .machine-tabs-pager { transition: none; } }
`;

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
              <span aria-hidden="true">↓</span> ещё {Math.min(PAGE_SIZE, count - visible)}
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
/* The pager takes no room: it floats over the bottom-right corner of the
   list and shows only while the list is hovered or focused. */
[data-machine-tabs-page] { position: relative; }
.machine-tabs-pager {
  position: absolute; right: 6px; bottom: 2px; z-index: 2;
  display: flex; align-items: center; gap: 8px;
  height: 20px; padding: 0 6px;
  font-size: 11px; line-height: 20px; color: var(--muted-foreground);
  background: var(--sidebar, var(--background)); border-radius: 6px;
  box-shadow: 0 0 0 1px var(--border), 0 1px 3px rgb(0 0 0 / .08);
  opacity: 0; pointer-events: none; transition: opacity 120ms ease;
}
/* Only the innermost hovered list shows its pager. */
[data-machine-tabs-page]:hover:not(:has([data-machine-tabs-page]:hover)) > .machine-tabs-pager,
[data-machine-tabs-page]:focus-within:not(:has([data-machine-tabs-page]:focus-within)) > .machine-tabs-pager,
[data-sidebar-sticky-group]:hover > div > [data-machine-tabs-page]:not(:has([data-machine-tabs-page]:hover)) > .machine-tabs-pager {
  opacity: 1; pointer-events: auto;
}
.machine-tabs-pager button {
  display: inline-flex; align-items: center; gap: 4px;
  border: 0; background: transparent; padding: 0 2px;
  cursor: pointer; white-space: nowrap; border-radius: 3px; color: inherit;
}
.machine-tabs-pager button:hover { text-decoration: underline; text-underline-offset: 3px; }
.machine-tabs-pager button:focus-visible { outline: 2px solid var(--sidebar-ring); outline-offset: 2px; }
.machine-tabs-page-count { flex-shrink:0; white-space:nowrap; font-size: 10px; font-variant-numeric: tabular-nums; opacity: .7; }
@media (hover: none) { .machine-tabs-pager { position: static; height: auto; min-height: 32px; box-shadow: none; background: none; opacity: .7; pointer-events: auto; } }
@media (prefers-reduced-motion: reduce) { .machine-tabs-pager { transition: none; } }
`;

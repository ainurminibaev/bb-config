import { createContext, createElement, useContext, useMemo } from "react";
import { mergeProjectRoots, projectAliases, type LinkedThread, type ProjectRoot } from "./project-aliases";

type Props = Record<string, any>;

const projectRoots = createContext<{
  projectId: string;
  items: readonly ProjectRoot[];
  compareThreads: Parameters<typeof mergeProjectRoots>[2];
} | null>(null);
const aliasRoots = createContext<ReadonlySet<object> | null>(null);

export function withProjectAliases(runtime: Props, useVisibleThreads: () => readonly LinkedThread[]) {
  const base = "default" in runtime ? runtime.default : runtime;
  function ProjectContents({ Component, nativeProps }: Props) {
    const threads = useVisibleThreads();
    const existing = nativeProps.threadListState.threads ?? [];
    const aliases = useMemo(() => projectAliases(threads, nativeProps.projectId, existing),
      [threads, nativeProps.projectId, existing]);
    const items = nativeProps.rootItems;
    if (aliases.length === 0 || nativeProps.threadListState.status !== "ready" ||
        typeof nativeProps.compareThreads !== "function" ||
        (!Array.isArray(items) && existing.length > 0)) {
      return createElement(Component, nativeProps);
    }
    // Have the native project renderer build the alias subtrees, then add them
    // to the original roots before the list calculates paging and navigation.
    return createElement(projectRoots.Provider, {
      value: {
        projectId: nativeProps.projectId, items: items ?? [], compareThreads: nativeProps.compareThreads,
      },
    }, createElement(Component, {
      ...nativeProps, rootItems: undefined,
      threadListState: { status: "ready", threads: aliases },
    }));
  }
  function ProjectRows({ Component, nativeProps }: Props) {
    const roots = useContext(projectRoots);
    const items = nativeProps.items as readonly ProjectRoot[];
    const supplemental = useMemo(() => new Set(items), [items]);
    if (!roots || roots.projectId !== nativeProps.projectId) {
      return createElement(Component, nativeProps);
    }
    return createElement(aliasRoots.Provider, { value: supplemental },
      createElement(Component, { ...nativeProps, items: mergeProjectRoots(roots.items, items, roots.compareThreads) }));
  }
  function ProjectRow({ Component, nativeProps }: Props) {
    const aliases = useContext(aliasRoots);
    // The canonical row owns the drag target. The alias still uses BB's row
    // renderer and its ordinary actions for the same thread ID.
    return createElement(Component, aliases?.has(nativeProps.item)
      ? { ...nativeProps, sectionDnd: undefined }
      : nativeProps);
  }
  const wrap = (factory: any) => (type: any, props: Props, key: any) => {
    const projectContents = typeof type !== "string" && props &&
      typeof props.projectId === "string" &&
      props.dndParentKey === `project:${props.projectId}` &&
      props.threadListState && typeof props.onToggleThreadCollapsed === "function" &&
      "rootItems" in props && !props.project;
    if (projectContents) return factory(ProjectContents, { Component: type, nativeProps: props }, key);
    if (typeof type !== "string" && typeof props?.projectId === "string" &&
        typeof props.onToggleThreadCollapsed === "function") {
      if (Array.isArray(props.items) && props.sortableParentKey === props.projectId && "sectionDnd" in props) {
        return factory(ProjectRows, { Component: type, nativeProps: props }, key);
      }
      if (props.item && props.sectionDnd && "depthOffset" in props) {
        return factory(ProjectRow, { Component: type, nativeProps: props }, key);
      }
    }
    return factory(type, props, key);
  };
  const wrapped = { ...base, jsx: wrap(base.jsx), jsxs: wrap(base.jsxs) };
  return "default" in runtime ? { ...runtime, ...wrapped, default: wrapped } : wrapped;
}

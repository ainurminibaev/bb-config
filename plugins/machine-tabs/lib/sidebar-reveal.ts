/**
 * Scroll the sidebar to a project group or a thread row and flash it, the way
 * Project Catalog's "Показать в боковой панели" does. Works with bb's list,
 * which marks project groups with `data-sidebar-project-id` and thread links
 * with `data-sidebar-thread-id`.
 */

export const REVEAL_CSS = `
@keyframes mt-reveal-flash {
  0%, 100% { box-shadow: inset 0 0 0 0 transparent; background-color: transparent; }
  15%, 60% { box-shadow: inset 0 0 0 1.5px var(--sidebar-ring, #3b82f6); background-color: color-mix(in oklab, var(--sidebar-ring, #3b82f6) 14%, transparent); }
}
.mt-reveal-flash { animation: mt-reveal-flash 2.2s ease-out 1; border-radius: 6px; }
@media (prefers-reduced-motion: reduce) { .mt-reveal-flash { animation-duration: 3s; } }
`;

/** The main list, not the "Last 5" block above it. */
const MAIN_LIST = "[data-machine-tabs-list]:not([data-machine-tabs-recent])";

function scrollBox(element: HTMLElement): HTMLElement | null {
  let box: HTMLElement | null = element.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) {
    box = box.parentElement;
  }
  return box;
}

/** Bring an element just below whatever sticks to the top of its scroll box. */
function scrollIntoSidebar(target: HTMLElement, block: "start" | "center") {
  const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  const box = scrollBox(target);
  if (!box) {
    target.scrollIntoView({ block, behavior });
    return;
  }
  const top = box.getBoundingClientRect().top;
  let covered = 0;
  for (const el of Array.from(box.querySelectorAll<HTMLElement>("*"))) {
    if (el.contains(target) || target.contains(el)) continue;
    const style = getComputedStyle(el);
    if (style.position !== "sticky" && style.position !== "fixed") continue;
    const rect = el.getBoundingClientRect();
    if (rect.height && rect.top - top < 80) covered = Math.max(covered, rect.bottom - top);
  }
  const rect = target.getBoundingClientRect();
  const offset = block === "center"
    ? rect.top - top - covered - Math.max(0, (box.clientHeight - covered - rect.height) / 2)
    : rect.top - top - covered - 8;
  box.scrollTo({ top: box.scrollTop + offset, behavior });
}

function flash(element: HTMLElement) {
  element.classList.remove("mt-reveal-flash");
  void element.offsetWidth;
  element.classList.add("mt-reveal-flash");
  window.setTimeout(() => element.classList.remove("mt-reveal-flash"), 2300);
}

function projectGroup(projectId: string): HTMLElement | null {
  const selector = `[data-sidebar-project-id="${CSS.escape(projectId)}"]`;
  return document.querySelector<HTMLElement>(`${MAIN_LIST} ${selector}`) ?? document.querySelector<HTMLElement>(selector);
}

function expand(group: HTMLElement) {
  const label = group.querySelector<HTMLElement>(
    '[data-sidebar="group-label"] [aria-expanded="false"], [data-sidebar="group-label"][aria-expanded="false"]',
  );
  label?.click();
}

/** Scroll to the project's group and flash it. False when the list shows no such group. */
export function revealProject(projectId: string): boolean {
  const group = projectGroup(projectId);
  if (!group) return false;
  expand(group);
  scrollIntoSidebar(group, "start");
  flash(group.querySelector<HTMLElement>('[data-sidebar="group-label"]') ?? group);
  return true;
}

function threadRow(threadId: string): HTMLElement | null {
  const selector = `a[data-sidebar-thread-id="${CSS.escape(threadId)}"]`;
  return document.querySelector<HTMLElement>(`${MAIN_LIST} ${selector}`) ?? document.querySelector<HTMLElement>(selector);
}

/**
 * Scroll to the thread's row and flash it; opens its project group first when
 * that is collapsed. Retries while bb draws the list after navigation, and
 * falls back to the project group when the row stays hidden (paged out).
 */
export function revealThread(threadId: string, projectId: string, attempts = 8): void {
  const row = threadRow(threadId);
  if (row) {
    const line = row.closest<HTMLElement>("[data-sidebar-rename-row]") ?? row;
    scrollIntoSidebar(line, "center");
    flash(line);
    return;
  }
  const group = projectGroup(projectId);
  if (group) expand(group);
  if (attempts > 0) {
    window.setTimeout(() => revealThread(threadId, projectId, attempts - 1), 150);
  } else {
    revealProject(projectId);
  }
}

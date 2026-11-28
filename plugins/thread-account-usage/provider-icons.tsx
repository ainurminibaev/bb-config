// Both Antigravity CLI providers get the Antigravity arc with a small corner
// badge: «EN» — the CLI straight to Google (acp-antigravity-acp, «Прямой
// Gemini»), «RU» — through the antig.ru gateway (acp-gemini-antig, «Русский
// Gemini»). BB lets any plugin draw a provider's mark
// (app.slots.experimental_providerIcon), so provider-acp stays untouched.
// Monochrome: currentColor only; the letters are cut out of a solid badge.
import { useId, type ComponentType } from 'react';

const ARC = 'M14.1452 14.6818C14.9937 15.3182 16.2664 14.894 15.0997 13.7273C11.5998 10.3333 12.3421 1 7.99366 1C3.64518 1 4.3876 10.3333 0.887603 13.7273C-0.385123 15 0.993664 15.3182 1.84215 14.6818C5.13002 12.4545 4.9179 8.5303 7.99366 8.5303C11.0694 8.5303 10.8573 12.4545 14.1452 14.6818Z';

function BadgedArc({ label, className }: { label: string; className?: string }) {
  const id = useId().replace(/:/g, '');
  return <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <mask id={`arc-${id}`} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
      <rect width="16" height="16" fill="white" />
      <rect x="6.2" y="8.4" width="10.8" height="8.6" rx="2.4" fill="black" />
    </mask>
    <mask id={`badge-${id}`} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
      <rect width="16" height="16" fill="white" />
      <text x="11.6" y="14.75" textAnchor="middle" fontFamily="system-ui,-apple-system,'Segoe UI',sans-serif" fontSize="5.4" fontWeight="800" letterSpacing="-0.2" fill="black">{label}</text>
    </mask>
    <path d={ARC} fill="currentColor" mask={`url(#arc-${id})`} />
    <rect x="7.2" y="9.4" width="8.8" height="6.6" rx="1.7" fill="currentColor" mask={`url(#badge-${id})`} />
  </svg>;
}

export const DirectGeminiIcon = ({ className }: { className?: string }) => <BadgedArc label="EN" className={className} />;
export const RussianGeminiIcon = ({ className }: { className?: string }) => <BadgedArc label="RU" className={className} />;

/** Provider ids drawn inline by this plugin, here and in BB's provider pickers. */
export const inlineMarks: Record<string, ComponentType<{ className?: string }>> = {
  'acp-antigravity-acp': DirectGeminiIcon,
  'acp-gemini-antig': RussianGeminiIcon,
};

/**
 * VClaude (0.3.2): своя простая отметка — «V» шлюза с точкой, не логотип сервиса
 * (официального SVG нет). Монохром, currentColor.
 */
export const VClaudeIcon = ({ className }: { className?: string }) =>
  <svg className={className} width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M1.2 2.6h3.4L8 11.1l3.4-8.5h3.4L9.7 14.4H6.3Z" fill="currentColor" />
    <circle cx="8" cy="3.6" r="1.6" fill="currentColor" />
  </svg>;

/** Marks of accounts that are not BB providers (VClaude rows); not registered as provider icons. */
export const accountMarks: Record<string, ComponentType<{ className?: string }>> = { vclaude: VClaudeIcon };
export const markOf = (id: string) => inlineMarks[id] ?? accountMarks[id];

/** A provider's mark: inline for the ids above, else BB's masked logo asset. */
export function ProviderMark({ providerId, src, className }: { providerId: string; src?: string | null; className?: string }) {
  const Mark = markOf(providerId);
  if (Mark) return <span className={`tau-agent-logo-inline ${className ?? ''}`} aria-hidden="true"><Mark /></span>;
  if (!src) return null;
  const url = `url("${src.replace(/"/g, '%22')}")`;
  return <span className={`tau-agent-logo ${className ?? ''}`} aria-hidden="true" style={{ WebkitMaskImage: url, maskImage: url }} />;
}

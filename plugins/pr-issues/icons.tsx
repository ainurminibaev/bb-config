// Own outline glyphs (24px grid): BB's shared icon set has no PR glyph.
import type { CSSProperties } from 'react';

const PATHS: Record<string, string> = {
  PullRequest: 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 9v12M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 15V8a2 2 0 0 0-2-2h-4M14 3l-3 3 3 3',
  Merged: 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 9v12M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 9a9 9 0 0 0 9 9',
  Issue: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  IssueDone: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 12.5l2.5 2.5 4.5-5',
  Closed: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6M15 9l-6 6',
  Inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  RefreshCw: 'M21 12a9 9 0 0 0-15-6.7L3 8M3 3v5h5M3 12a9 9 0 0 0 15 6.7L21 16M21 21v-5h-5',
  ExternalLink: 'M15 3h6v6M10 14L21 3M18 13v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h7',
  Search: 'M21 21l-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z',
  X: 'M18 6L6 18M6 6l12 12',
  ChevronDown: 'M6 9l6 6 6-6',
  Building: 'M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M3 21h18M10 7h1M13 7h1M10 11h1M13 11h1M10 15h1M13 15h1',
  ArrowLeft: 'M19 12H5M12 19l-7-7 7-7',
  Settings: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4',
  CheckAll: 'M2 12l5 5L18 6M12 17l1 1L22 9',
  CircleHelp: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.4 9a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.5-2.6 4M12 17.5h.01',
};

export function Icon({ name, className, style }: { name: string; className?: string; style?: CSSProperties }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden>
    <path d={PATHS[name] ?? PATHS.CircleHelp}/></svg>;
}
export const NavIcon = ({ className }: { className?: string }) => <Icon name="PullRequest" className={className}/>;

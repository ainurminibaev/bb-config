import { definePluginApp } from '@get-bb/plugin-sdk/app';
import type { ExperimentalThreadRowMetadataProps } from '@get-bb/plugin-sdk/app';
import { showsErrorMark } from './logic';
import './app.css';

const LABEL = 'Подтред завершился с ошибкой';

/** Same shape as bb's CircleX glyph, drawn locally so it needs no host icon API. */
function ErrorMark({ thread }: ExperimentalThreadRowMetadataProps) {
  if (!showsErrorMark(thread)) return null;
  return <span className="sem-mark" title={LABEL} aria-label={LABEL} role="img" data-subthread-error-mark="">
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>
    </svg>
  </span>;
}

export default definePluginApp((app) => {
  app.slots.experimental_threadRowMetadata({ id: 'subthread-error-mark', order: 10, component: ErrorMark });
});

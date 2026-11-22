# Subthread Error Mark

Shows a red ⊗ on BB sidebar rows of subthreads whose status is `error`, so a
parent's `↳ ⊗ N` count can be traced to specific rows. Frontend-only; uses the
`experimental_threadRowMetadata` slot of the built-in Thread list.

Install: `npm ci && npm test && npm run typecheck && bb plugin build . && bb plugin install . --yes`.
Remove: `bb plugin remove subthread-error-mark`.

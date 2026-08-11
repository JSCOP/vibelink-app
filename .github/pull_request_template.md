## What changed and why

<!-- Summarize the change and the problem it solves. -->

## Verification

<!-- List the exact commands you ran and any relevant manual checks. -->

- Commands run:
  - `...`

## Checklist

- [ ] I signed off my commits with the DCO (`git commit -s`).
- [ ] I ran `pnpm exec vitest run`.
- [ ] I ran `pnpm lint`.
- [ ] From `src-tauri`, I ran `cargo clippy --all-targets --all-features -- -D warnings` and `cargo test`.
- [ ] I kept this change within VibeLink's Windows-only scope; cross-platform changes are untested and out of scope.

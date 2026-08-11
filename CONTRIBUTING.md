# Contributing to VibeLink

VibeLink is Windows-only. Contributors need Windows 10 or Windows 11, and the project cannot be built on macOS or Linux.

Thank you for contributing. For a map of the frontend, Rust modules, daemon, and IPC boundaries, start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). All participation must follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

Install the following before working on VibeLink:

- Windows 10 or Windows 11
- Node.js 22
- pnpm 10.13.1
- Rust stable, with the package minimum `rust-version = 1.85`
- The MSVC toolchain and Windows SDK
- The Microsoft Edge WebView2 Runtime
- PowerShell

## Setup

Install dependencies from the repository root:

```powershell
pnpm install
```

Start the development app:

```powershell
pnpm tauri:dev
```

## Verification before a pull request

Run these frontend and release-contract checks from the repository root:

```powershell
pnpm test:release-contract
pnpm exec vitest run
pnpm lint
```

Run these Rust checks from `src-tauri`:

```powershell
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Include a verification note in the pull request that names the commands or manual scenarios you ran and their results. CI uses no secrets, so the full CI workflow runs on pull requests from forks.

## Developer Certificate of Origin

Every commit must carry a [Developer Certificate of Origin](https://developercertificate.org/) sign-off. Create signed-off commits with:

```powershell
git commit -s
```

The sign-off means: “I certify that I wrote this contribution, or otherwise have the right to submit it under the project's open-source license.”

VibeLink does not require a Contributor License Agreement (CLA). There is no CLA to sign.

## Pull request expectations

- Keep each diff focused on one issue or coherent change.
- Include a real verification note with the commands or scenarios run and the observed result.
- Do not include unrelated reformatting, cleanup, or generated changes.
- Explain user-visible behavior changes and any known limitations.

Maintainers will provide a first response to issues and pull requests within 48 hours.

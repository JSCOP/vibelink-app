# Security Policy

## Supported versions

Only the latest published VibeLink release receives security fixes. Older releases are not supported; when possible, confirm that the issue still affects the latest release before reporting it.

## Reporting a vulnerability

Report suspected vulnerabilities privately to [support@moobang.net](mailto:support@moobang.net). Never disclose a vulnerability through a public GitHub issue.

Please include:

- The affected VibeLink version
- Clear reproduction steps or a minimal proof of concept
- The security impact, including any required attacker access or user interaction

We will acknowledge receipt within 48 hours. We may ask for additional details while we investigate and coordinate a fix or disclosure.

VibeLink does not offer a bug bounty. Reports are still appreciated and will be handled in good faith.

## Security scope

VibeLink can store an optional Moobang account session token in Windows Credential Manager. It also runs a machine-local IPC daemon used by the desktop app, CLI, and related local integrations. Vulnerabilities affecting that credential storage, local IPC authentication or transport, daemon isolation, or the boundaries between local clients are in scope.

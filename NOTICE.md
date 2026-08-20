# Third-Party Notices

VibeLink's own code is licensed under GPL-3.0-only. The components and marks below retain their separate licenses and rights.

## Microsoft Windows Console ConPTY Runtime

- **Component:** `Microsoft.Windows.Console.ConPTY` (`conpty.dll` and `OpenConsole.exe`)
- **Copyright holder:** Microsoft Corporation
- **License:** MIT License
- **Bundled files:** `src-tauri/resources/conpty/x64/conpty.dll` and `src-tauri/resources/conpty/x64/OpenConsole.exe`
- **Existing notice and source record:** `src-tauri/resources/conpty/README.md`

## Geist Variable Font

- **Component:** Geist (`Geist-Variable.woff2`)
- **Copyright holder:** Copyright (c) 2023 Vercel, in collaboration with basement.studio
- **License:** SIL Open Font License, Version 1.1
- **Bundled file:** `src/assets/fonts/Geist-Variable.woff2`
- **Existing notice:** `src/assets/fonts/LICENSE.txt`

## Agent Brand Marks

- **Component:** Brand icons for interoperable agent tools
- **Copyright and trademark holders:** The respective owners identified in `public/agent-icons/SOURCES.txt`
- **License:** No single package license applies. Each mark remains subject to the rights of its respective owner and is not licensed under VibeLink's GPL-3.0 grant.
- **Bundled files:** `public/agent-icons/`
- **Existing source and attribution record:** `public/agent-icons/SOURCES.txt`

The agent brand marks shipped under `public/agent-icons/` are trademarks of their respective owners. They are used nominatively to identify tools with which VibeLink interoperates. They are not covered by the GPL-3.0 grant on VibeLink's own code. See `public/agent-icons/SOURCES.txt` for individual sources.

## Hermes Agent

- **Component:** Hermes Agent
- **Copyright holder:** Copyright (c) 2025 Nous Research
- **License:** MIT License
- **Bundled file:** None. Hermes Agent is an external program installed and managed by the user; VibeLink communicates with it using ACP over stdio.
- **Upstream project:** <https://github.com/NousResearch/hermes-agent>
- **Upstream license notice:** <https://github.com/NousResearch/hermes-agent/blob/main/LICENSE>

The Hermes brand icon used by VibeLink is listed separately in `public/agent-icons/SOURCES.txt`; the Hermes Agent program itself is not bundled with VibeLink.

## herdr agent-detection manifests

- **Component:** screen-content agent state detection rules and engine design, ported to TypeScript in `src/terminal/agentScreenDetect.ts`
- **Source:** https://github.com/herdrdev/herdr (`src/detect/`)
- **Copyright holder:** the herdr contributors
- **License:** Apache License 2.0 — full text in [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)

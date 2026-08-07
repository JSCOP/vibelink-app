import { readFileSync } from 'node:fs'

// Mirrors the stylesheet import order in App.tsx.
const appStylesheetPaths = [
  './styles/theme.css',
  './styles/kanban.css',
  './styles/memory.css',
  './App.css',
  './styles/workspaceShell.css',
  './styles/terminalShell.css',
  './styles/appChrome.css',
  './styles/gitWindow.css',
  './styles/workspaceRail.css',
  './styles/gitHistory.css',
]

export function readAppStylesheet(): string {
  return appStylesheetPaths
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n')
}

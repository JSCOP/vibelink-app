import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import 'monaco-editor/languages/definitions/register.all.js'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import { registerExtraMonacoLanguages } from './extraLanguages'

type MonacoWorkerEnvironment = {
  getWorker(moduleId: string, label: string): Worker
}

const workerEnvironment: MonacoWorkerEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker()
    return new EditorWorker()
  },
}

;(globalThis as typeof globalThis & { MonacoEnvironment: MonacoWorkerEnvironment }).MonacoEnvironment = workerEnvironment
// `register.all.js` above covers the 89 grammars Monaco ships. TOML and
// Makefile are not among them, so files we map to those ids would tokenize to
// nothing. Register them right after the built-ins and before any editor is
// created, so the first opened Cargo.toml is already colored.
registerExtraMonacoLanguages(monaco)
loader.config({ monaco })

export { monaco }

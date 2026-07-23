import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import 'monaco-editor/languages/definitions/register.all.js'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker'

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
loader.config({ monaco })

export { monaco }

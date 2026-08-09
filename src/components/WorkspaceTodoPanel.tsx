import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { CheckSquare, Plus, Send, Trash2, X } from 'lucide-react'
import { useWorkspaceStore } from '../state/store'
import type { WorkspaceTodoItem } from '../state/workspaceTodos'

const EMPTY_TODOS: WorkspaceTodoItem[] = []

export function WorkspaceTodoPanel() {
  const sessionId = useWorkspaceStore((state) => state.activeSessionId)
  const todos = useWorkspaceStore((state) => sessionId ? state.workspaceTodos?.[sessionId] ?? EMPTY_TODOS : EMPTY_TODOS)
  const note = useWorkspaceStore((state) => sessionId ? state.workspaceTodoNotes?.[sessionId] ?? '' : '')
  const addWorkspaceTodo = useWorkspaceStore((state) => state.addWorkspaceTodo)
  const deleteWorkspaceTodo = useWorkspaceStore((state) => state.deleteWorkspaceTodo)
  const deleteWorkspaceTodos = useWorkspaceStore((state) => state.deleteWorkspaceTodos)
  const updateWorkspaceTodoText = useWorkspaceStore((state) => state.updateWorkspaceTodoText)
  const setWorkspaceTodoNote = useWorkspaceStore((state) => state.setWorkspaceTodoNote)
  const injectWorkspaceTodosToKanban = useWorkspaceStore((state) => state.injectWorkspaceTodosToKanban)
  const [draft, setDraft] = useState('')
  const [noteDraft, setNoteDraft] = useState({ sessionId, value: note })
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const pendingNoteRef = useRef<{ sessionId: string; note: string } | null>(null)
  const noteTimerRef = useRef<number | null>(null)
  const todoIds = useMemo(() => todos.map((todo) => todo.id), [todos])
  const selectedInjectableIds = useMemo(
    () => selectedIds.filter((id) => todos.some((todo) => todo.id === id && !todo.kanbanTaskId)),
    [selectedIds, todos],
  )

  const flushPendingNote = useCallback(() => {
    if (noteTimerRef.current !== null) {
      window.clearTimeout(noteTimerRef.current)
      noteTimerRef.current = null
    }
    const pending = pendingNoteRef.current
    if (!pending) return
    pendingNoteRef.current = null
    setWorkspaceTodoNote(pending.sessionId, pending.note)
  }, [setWorkspaceTodoNote])

  useEffect(() => flushPendingNote, [flushPendingNote, sessionId])

  useEffect(() => {
    window.addEventListener('pagehide', flushPendingNote)
    return () => window.removeEventListener('pagehide', flushPendingNote)
  }, [flushPendingNote])

  if (!sessionId) return <div className="workspace-todo-empty">Open a workspace to keep a todo list.</div>

  const updateNoteDraft = (nextNote: string) => {
    setNoteDraft({ sessionId, value: nextNote })
    pendingNoteRef.current = { sessionId, note: nextNote }
    if (noteTimerRef.current !== null) window.clearTimeout(noteTimerRef.current)
    noteTimerRef.current = window.setTimeout(flushPendingNote, 300)
  }

  const addTodo = () => {
    const created = addWorkspaceTodo(sessionId, draft)
    if (created) {
      setDraft('')
      setSelectedIds((ids) => [...ids, created.id])
    }
  }

  const onDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    addTodo()
  }

  const selectTodo = (todoId: string, selected: boolean) => {
    setSelectedIds((ids) => selected ? [...ids.filter((id) => id !== todoId), todoId] : ids.filter((id) => id !== todoId))
  }

  const selectAll = () => setSelectedIds(todoIds)

  const deleteSelected = () => {
    deleteWorkspaceTodos(sessionId, selectedIds)
    setSelectedIds([])
  }

  const injectSelected = async () => {
    const created = await injectWorkspaceTodosToKanban(sessionId, selectedInjectableIds)
    if (created.length > 0) setSelectedIds((ids) => ids.filter((id) => !selectedInjectableIds.includes(id)))
  }

  const beginEdit = (todoId: string, text: string) => {
    setEditingId(todoId)
    setEditingText(text)
  }

  const commitEdit = () => {
    if (!editingId) return
    updateWorkspaceTodoText(sessionId, editingId, editingText)
    setEditingId(null)
    setEditingText('')
  }

  const onEditKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      commitEdit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setEditingId(null)
      setEditingText('')
    }
  }

  return (
    <div className="workspace-todo-panel">
      <header className="workspace-todo-header">
        <div>
          <h2>Todo List</h2>
          <p>Keep implementation notes here, then send selected todo items straight to Kanban.</p>
        </div>
        <button type="button" className="primary-action" disabled={selectedInjectableIds.length === 0} onClick={injectSelected}>
          <Send size={14} /> Kanban에 추가
        </button>
      </header>

      <section className="workspace-todo-note">
        <label>
          Memo
          <textarea value={noteDraft.sessionId === sessionId ? noteDraft.value : note} placeholder="구현 방향, 참고 사항, 완료 기준을 메모하세요." onBlur={flushPendingNote} onChange={(event) => updateNoteDraft(event.target.value)} />
        </label>
      </section>

      <section className="workspace-todo-compose">
        <input value={draft} placeholder="할 일을 입력하고 Enter" onChange={(event) => setDraft(event.target.value)} onKeyDown={onDraftKeyDown} />
        <button type="button" className="primary-action" disabled={!draft.trim()} onClick={addTodo}>
          <Plus size={14} /> 추가
        </button>
      </section>

      <div className="workspace-todo-toolbar">
        <button type="button" disabled={todos.length === 0} onClick={selectAll}><CheckSquare size={14} /> 전체 선택</button>
        <button type="button" disabled={selectedIds.length === 0} onClick={() => setSelectedIds([])}><X size={14} /> 선택 해제</button>
        <button type="button" className="danger" disabled={selectedIds.length === 0} onClick={deleteSelected}><Trash2 size={14} /> 선택 삭제</button>
      </div>

      <div className="workspace-todo-list" role="list">
        {todos.length === 0 ? <p className="workspace-todo-empty">아직 todo가 없습니다. 위 입력창에서 바로 추가하세요.</p> : null}
        {todos.map((todo) => {
          const isSelected = selectedIds.includes(todo.id)
          const isEditing = editingId === todo.id
          return (
            <article key={todo.id} className={`workspace-todo-item${isSelected ? ' selected' : ''}${todo.kanbanTaskId ? ' injected' : ''}`} role="listitem">
              <label className="workspace-todo-check">
                <input type="checkbox" checked={isSelected} onChange={(event) => selectTodo(todo.id, event.target.checked)} />
              </label>
              <div className="workspace-todo-item-main">
                {isEditing ? (
                  <input value={editingText} autoFocus onBlur={commitEdit} onChange={(event) => setEditingText(event.target.value)} onKeyDown={onEditKeyDown} />
                ) : (
                  <button type="button" className="workspace-todo-text" title="Click to edit" onClick={() => beginEdit(todo.id, todo.text)}>
                    {todo.text}
                  </button>
                )}
                {todo.kanbanTaskId ? <span className="workspace-todo-chip">Kanban</span> : null}
              </div>
              <button type="button" className="workspace-todo-delete" title="Delete todo" onClick={() => { deleteWorkspaceTodo(sessionId, todo.id); selectTodo(todo.id, false) }}>
                <Trash2 size={14} />
              </button>
            </article>
          )
        })}
      </div>
    </div>
  )
}

import type { DragEvent as ReactDragEvent } from 'react'
import type { TaskStatus } from '../ipc/types'

export const taskDragMime = 'application/x-vibelink-task'

export type TaskDragPayload = {
  taskId: string
  status: TaskStatus
}

export function hasTaskDragPayload(event: DragEvent | ReactDragEvent): boolean {
  return event.dataTransfer ? Array.from(event.dataTransfer.types).includes(taskDragMime) : false
}

export function readTaskDragPayload(event: DragEvent | ReactDragEvent): TaskDragPayload | null {
  try {
    const value = event.dataTransfer?.getData(taskDragMime)
    if (!value) return null
    const parsed = JSON.parse(value) as Partial<TaskDragPayload>
    if (typeof parsed.taskId !== 'string') return null
    if (parsed.status !== 'pending' && parsed.status !== 'assigned' && parsed.status !== 'in-progress' && parsed.status !== 'done') return null
    return { taskId: parsed.taskId, status: parsed.status }
  } catch {
    return null
  }
}

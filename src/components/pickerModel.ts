export type PickerEntry<Id extends string = string> =
  | { kind: 'header'; label: string }
  | { kind: 'item'; id: Id; name: string; description?: string }

export type PickerItem<Id extends string = string> = Extract<PickerEntry<Id>, { kind: 'item' }>

/** The pickable ids in display order for a set of picker entries. */
export function pickerItemIds<Id extends string>(entries: PickerEntry<Id>[]): Id[] {
  return entries.flatMap((entry) => entry.kind === 'item' ? [entry.id] : [])
}

/** Step from `current` by `delta` through the pickable items, clamping at the
 *  ends (VS Code quick-pick behavior). Falls back to the first item when the
 *  current one is filtered out. */
export function steppedPickerId<Id extends string>(entries: PickerEntry<Id>[], current: Id | null, delta: number): Id | null {
  const ids = pickerItemIds(entries)
  if (ids.length === 0) return null
  const currentIndex = current === null ? -1 : ids.indexOf(current)
  if (currentIndex < 0) return delta >= 0 ? ids[0] : ids[ids.length - 1]
  const nextIndex = Math.min(ids.length - 1, Math.max(0, currentIndex + delta))
  return ids[nextIndex]
}

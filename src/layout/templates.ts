export type GridTemplate = {
  id: string
  label: string
  cols: number
  rows: number
}

export const TEMPLATES: GridTemplate[] = [
  { id: '1x1', label: '1×1', cols: 1, rows: 1 },
  { id: '1x2', label: '1×2', cols: 1, rows: 2 },
  { id: '2x1', label: '2×1', cols: 2, rows: 1 },
  { id: '2x2', label: '2×2', cols: 2, rows: 2 },
  { id: '2x3', label: '2×3', cols: 2, rows: 3 },
  { id: '3x2', label: '3×2', cols: 3, rows: 2 },
  { id: '3x3', label: '3×3', cols: 3, rows: 3 },
  { id: '4x2', label: '4×2', cols: 4, rows: 2 },
  { id: '6x2', label: '6×2', cols: 6, rows: 2 },
]

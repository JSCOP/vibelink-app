import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

type AnchoredPopoverProps = {
  anchorRef: RefObject<HTMLElement | null>
  className: string
  role: 'listbox' | 'dialog'
  label: string
  onDismiss: () => void
  children: ReactNode
}

const VIEWPORT_MARGIN = 8

/** Popover rendered into `document.body` and pinned to its trigger.
 *
 *  The automation form is a scroll container, so an absolutely positioned menu
 *  inside it gets clipped at the form's edge. Portalling out and positioning
 *  with fixed coordinates keeps the whole menu visible, and flipping above the
 *  trigger handles the common case of a picker near the dialog's bottom. */
export function AnchoredPopover({ anchorRef, className, role, label, onDismiss, children }: AnchoredPopoverProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current
      const menu = menuRef.current
      if (!anchor || !menu) return
      const rect = anchor.getBoundingClientRect()
      const height = menu.offsetHeight
      const below = rect.bottom + 4
      const fitsBelow = below + height + VIEWPORT_MARGIN <= window.innerHeight
      setPosition({
        left: Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - rect.width - VIEWPORT_MARGIN)),
        top: fitsBelow ? below : Math.max(VIEWPORT_MARGIN, rect.top - height - 4),
        width: rect.width,
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchorRef, children])

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onDismiss()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onDismiss()
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [anchorRef, onDismiss])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={menuRef}
      className={className}
      role={role}
      aria-label={label}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        minWidth: position?.width ?? 0,
        // Keep the menu off-screen for the first paint so its measured height
        // resolves before it is placed, avoiding a visible jump.
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

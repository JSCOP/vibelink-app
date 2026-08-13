// DEC private mode 2026, synchronized output: a TUI wraps each frame in
// `CSI ? 2026 h` ... `CSI ? 2026 l`. xterm honours it by buffering row
// refreshes for the whole span — but only for 1000 ms, after which its
// `_syncOutputHandler` watchdog force-clears the mode and paints whatever
// arrived. A write that ENDS inside the span therefore shows a half-drawn
// frame the moment the rest of it is more than a second behind, which the
// 333 ms inactive / 1 s hidden output pacing makes routine (measured with
// opencode: one 100x48 truecolor repaint is ~168 KiB, eleven 16 KiB writes).
// So the output scheduler cuts on frame boundaries, not on the byte budget.

const MODE_PREFIX = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36] // ESC [ ? 2 0 2 6
const MODE_SET = 0x68 // 'h' — begin synchronized update
const MODE_RESET = 0x6c // 'l' — end synchronized update
// The support query `ESC [ ? 2026 $ p` ends in `$p`, so it matches neither.

/**
 * How many bytes of the queued `pieces` may be written without ending inside a
 * synchronized frame:
 *
 *  - `budget`, when the write already ends outside a frame (the common case,
 *    and the only path a plain shell ever takes);
 *  - past `budget` to the frame's end, when the rest of the frame is already
 *    queued — one frame, one write, which is the whole point;
 *  - the frame's start offset when its end has NOT arrived yet, so the caller
 *    holds the partial frame instead of tearing it (`0` = hold everything);
 *  - `budget` again once one frame exceeds `maxFrameBytes`, because an app that
 *    never closes its frame must not stall the pane.
 */
export function syncSafeWriteLength(
  pieces: readonly Uint8Array[],
  budget: number,
  maxFrameBytes: number,
): number {
  let offset = 0
  let matched = 0
  let candidateStart = 0
  let frameStart = -1
  for (const piece of pieces) {
    for (let index = 0; index < piece.length; index += 1) {
      const byte = piece[index]
      if (matched === MODE_PREFIX.length) {
        if (byte === MODE_SET) {
          if (frameStart < 0) frameStart = candidateStart
        } else if (byte === MODE_RESET) {
          frameStart = -1
        }
        matched = 0
      }
      if (byte === MODE_PREFIX[matched]) {
        if (matched === 0) candidateStart = offset
        matched += 1
      } else if (byte === MODE_PREFIX[0]) {
        candidateStart = offset
        matched = 1
      } else {
        matched = 0
      }
      offset += 1
      if (frameStart < 0) {
        if (offset >= budget) return offset
      } else if (offset - frameStart > maxFrameBytes) {
        return budget
      }
    }
  }
  return frameStart < 0 ? offset : frameStart
}

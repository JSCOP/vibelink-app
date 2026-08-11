use std::collections::VecDeque;

const CLEAR_SEQUENCES: [&[u8]; 9] = [
    b"\x1b[2J",
    b"\x1b[3J",
    b"\x1bc",
    b"\x1b[H\x1b[J",
    b"\x1b[H\x1b[0J",
    b"\x1b[1;1H\x1b[J",
    b"\x1b[1;1H\x1b[0J",
    b"\x1b[f\x1b[J",
    b"\x1b[f\x1b[0J",
];

#[derive(Debug, Clone)]
pub struct ScrollbackRing {
    buf: VecDeque<u8>,
    cap: usize,
    pending_clear_prefix: Vec<u8>,
    protected_prefix_len: usize,
    /// Set by `rebase`, consumed by `take_rebased`. Raw PTY output is appended to
    /// the on-disk history, so a rebase has to tell the reader thread that the
    /// file must be rewritten from the new base instead of grown from the old one.
    rebased: bool,
}

impl ScrollbackRing {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap.min(8192)),
            cap,
            pending_clear_prefix: Vec::new(),
            protected_prefix_len: 0,
            rebased: false,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> bool {
        let combined;
        let detection_bytes = if self.pending_clear_prefix.is_empty() {
            bytes
        } else {
            combined = [self.pending_clear_prefix.as_slice(), bytes].concat();
            combined.as_slice()
        };

        let mut reset = false;
        let mut preserved_state = Vec::new();
        let bytes_to_store = if let Some((start, end)) = find_last_clear_span(detection_bytes) {
            reset = true;
            let preserve_restored_prefix = self.protected_prefix_len > 0;
            let mut discarded = self
                .buf
                .iter()
                .skip(self.protected_prefix_len)
                .copied()
                .collect::<Vec<_>>();
            discarded.extend_from_slice(&detection_bytes[..start]);
            for sequence in terminal_state_sequences(&discarded) {
                preserved_state.extend_from_slice(sequence);
            }
            self.clear_live_output();
            if preserve_restored_prefix {
                &detection_bytes[end..]
            } else {
                &detection_bytes[include_adjacent_clear_prefix(detection_bytes, start)..]
            }
        } else {
            bytes
        };

        let next_pending_clear_prefix = trailing_clear_prefix(detection_bytes).to_vec();
        self.buf.extend(preserved_state);
        self.buf.extend(bytes_to_store.iter().copied());
        self.pending_clear_prefix = next_pending_clear_prefix;
        let overflow = self.buf.len().saturating_sub(self.cap);
        if overflow > 0 {
            self.buf.drain(..overflow);
            self.protected_prefix_len = self.protected_prefix_len.saturating_sub(overflow);
        }
        reset
    }

    pub fn seed_protected(&mut self, bytes: &[u8]) {
        self.clear();
        self.push(bytes);
        self.protected_prefix_len = self.buf.len();
    }

    /// Replace the whole ring with a snapshot of the pane's RENDERED screen,
    /// produced by the desktop GUI's terminal emulator.
    ///
    /// Raw PTY bytes carry no geometry, so replaying them into a terminal of a
    /// different width re-wraps every full-width rule and lands every absolute
    /// cursor move in the wrong cell — the stacked, half-overwritten agent frames
    /// users see after a restart. A rendered snapshot is plain text plus SGR, so
    /// it reflows gracefully at any width, and the bytes recorded after it were
    /// all produced at the geometry they will be replayed at.
    pub fn rebase(&mut self, snapshot: &[u8]) {
        self.clear();
        self.push(snapshot);
        self.rebased = true;
    }

    pub fn take_rebased(&mut self) -> bool {
        std::mem::take(&mut self.rebased)
    }

    pub fn snapshot(&self) -> Vec<u8> {
        let mut snapshot = Vec::with_capacity(self.buf.len());
        let (front, back) = self.buf.as_slices();
        snapshot.extend_from_slice(front);
        snapshot.extend_from_slice(back);
        snapshot
    }

    pub fn clear(&mut self) {
        self.buf.clear();
        self.pending_clear_prefix.clear();
        self.protected_prefix_len = 0;
    }

    fn clear_live_output(&mut self) {
        self.buf
            .truncate(self.protected_prefix_len.min(self.buf.len()));
        self.pending_clear_prefix.clear();
    }
}

fn find_last_clear_span(bytes: &[u8]) -> Option<(usize, usize)> {
    if !bytes.contains(&0x1b) {
        return None;
    }
    let mut clear_span = None;
    for sequence in CLEAR_SEQUENCES {
        if let Some(pos) = find_subslice(bytes, sequence) {
            let end = pos + sequence.len();
            if clear_span.is_none_or(|(_, prev_end)| end > prev_end) {
                clear_span = Some((pos, end));
            }
        }
    }
    clear_span
}

fn include_adjacent_clear_prefix(bytes: &[u8], mut start: usize) -> usize {
    loop {
        let Some(sequence) = CLEAR_SEQUENCES.iter().find(|sequence| {
            start >= sequence.len() && &bytes[start - sequence.len()..start] == **sequence
        }) else {
            return start;
        };
        start -= sequence.len();
    }
}

fn terminal_state_sequences(bytes: &[u8]) -> Vec<&[u8]> {
    let mut preserved = Vec::new();
    let mut last_title = None;
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] != 0x1b {
            index += 1;
            continue;
        }
        match bytes.get(index + 1).copied() {
            Some(b'[') => {
                let mut cursor = index + 2;
                let params_start = cursor;
                while cursor < bytes.len() && (0x30..=0x3f).contains(&bytes[cursor]) {
                    cursor += 1;
                }
                let params_end = cursor;
                while cursor < bytes.len() && (0x20..=0x2f).contains(&bytes[cursor]) {
                    cursor += 1;
                }
                let Some(final_byte) = bytes.get(cursor).copied() else {
                    break;
                };
                if !(0x40..=0x7e).contains(&final_byte) {
                    index += 2;
                    continue;
                }
                let intermediates = &bytes[params_end..cursor];
                let first_param = bytes.get(params_start).copied();
                let mode_toggle = matches!(final_byte, b'h' | b'l') && intermediates.is_empty();
                let kitty_state = final_byte == b'u'
                    && intermediates.is_empty()
                    && matches!(first_param, Some(b'>') | Some(b'<') | Some(b'='));
                let cursor_style = final_byte == b'q' && intermediates == b" ";
                if mode_toggle || kitty_state || cursor_style {
                    preserved.push(&bytes[index..=cursor]);
                }
                index = cursor + 1;
            }
            Some(b'=') | Some(b'>') => {
                preserved.push(&bytes[index..index + 2]);
                index += 2;
            }
            Some(b'(') | Some(b')') => {
                if index + 2 < bytes.len() {
                    preserved.push(&bytes[index..index + 3]);
                }
                index += 3;
            }
            Some(b']') => {
                let mut cursor = index + 2;
                while cursor < bytes.len()
                    && bytes[cursor] != 0x07
                    && !(bytes[cursor] == 0x1b && bytes.get(cursor + 1) == Some(&b'\\'))
                {
                    cursor += 1;
                }
                if cursor >= bytes.len() {
                    break;
                }
                let terminator_len = if bytes[cursor] == 0x07 { 1 } else { 2 };
                if matches!(bytes.get(index + 2), Some(b'0') | Some(b'2'))
                    && bytes.get(index + 3) == Some(&b';')
                {
                    last_title = Some(&bytes[index..cursor + terminator_len]);
                }
                index = cursor + terminator_len;
            }
            _ => index += 2,
        }
    }

    if let Some(title) = last_title {
        preserved.push(title);
    }
    preserved
}

fn trailing_clear_prefix(bytes: &[u8]) -> &[u8] {
    let max_len = CLEAR_SEQUENCES
        .iter()
        .map(|sequence| sequence.len().saturating_sub(1))
        .max()
        .unwrap_or(0)
        .min(bytes.len());
    for len in (1..=max_len).rev() {
        let suffix = &bytes[bytes.len() - len..];
        if CLEAR_SEQUENCES
            .iter()
            .any(|sequence| sequence.starts_with(suffix))
        {
            return suffix;
        }
    }
    &[]
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }

    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_ring_keeps_small_initial_reserve() {
        let ring = ScrollbackRing::new(usize::MAX);

        assert_eq!(ring.buf.capacity(), 8192);
    }

    #[test]
    fn ring_drops_oldest_bytes_on_overflow() {
        let mut ring = ScrollbackRing::new(5);

        ring.push(b"abc");
        ring.push(b"def");

        assert_eq!(ring.snapshot(), b"bcdef");
    }

    #[test]
    fn ring_bulk_trims_large_overflow() {
        let mut ring = ScrollbackRing::new(4);

        ring.push(b"0123456789");

        assert_eq!(ring.snapshot(), b"6789");
    }

    #[test]
    fn ring_clears_on_full_clear_escape() {
        let mut ring = ScrollbackRing::new(64);

        ring.push(b"before");
        ring.push(b"\x1b[2Jafter");

        assert_eq!(ring.snapshot(), b"\x1b[2Jafter");
    }

    #[test]
    fn rebase_replaces_raw_bytes_and_reports_the_rewrite_once() {
        let mut ring = ScrollbackRing::new(128);
        ring.push(b"raw frame drawn at the old width");

        ring.rebase(b"\x1b[3J\x1b[2J\x1b[Hrendered");

        let snapshot = ring.snapshot();
        assert!(
            !find_subslice(&snapshot, b"raw frame").is_some(),
            "bytes produced at a geometry that no longer exists must not survive a rebase"
        );
        assert!(snapshot.ends_with(b"rendered"));
        assert!(
            ring.take_rebased(),
            "the reader thread must rewrite the on-disk history from the new base"
        );
        assert!(
            !ring.take_rebased(),
            "and must not rewrite it again for every later chunk"
        );
    }

    #[test]
    fn output_recorded_after_a_rebase_is_appended_to_the_snapshot() {
        let mut ring = ScrollbackRing::new(128);
        ring.push(b"stale");

        ring.rebase(b"\x1b[2Jrendered");
        ring.push(b" live tail");

        assert_eq!(ring.snapshot(), b"\x1b[2Jrendered live tail");
    }

    #[test]
    fn ring_clears_on_home_and_erase_to_end_clear() {
        let mut ring = ScrollbackRing::new(64);

        ring.push(b"before");
        ring.push(b"\x1b[H\x1b[Jafter");

        assert_eq!(ring.snapshot(), b"\x1b[H\x1b[Jafter");
    }

    #[test]
    fn ring_clears_when_clear_escape_is_split_across_reads() {
        let mut ring = ScrollbackRing::new(64);

        ring.push(b"before");
        ring.push(b"\x1b[");
        ring.push(b"2Jafter");

        assert_eq!(ring.snapshot(), b"\x1b[2Jafter");
    }

    #[test]
    fn ring_preserves_alt_screen_enter_history() {
        let mut ring = ScrollbackRing::new(64);

        ring.push(b"before");
        ring.push(b"\x1b[?1049hafter");

        assert_eq!(ring.snapshot(), b"before\x1b[?1049hafter");
    }

    #[test]
    fn ring_preserves_alt_screen_leave_history() {
        let mut ring = ScrollbackRing::new(64);

        ring.push(b"\x1b[?1049hfull-screen");
        ring.push(b"\x1b[?1049lnormal");

        assert_eq!(ring.snapshot(), b"\x1b[?1049hfull-screen\x1b[?1049lnormal");
    }

    #[test]
    fn ring_preserves_adjacent_reset_cluster() {
        let mut ring = ScrollbackRing::new(64);

        ring.push(b"before");
        ring.push(b"\x1b[?1049l\x1b[2J\x1b[3J\x1b[Hafter");

        assert_eq!(ring.snapshot(), b"\x1b[?1049l\x1b[2J\x1b[3J\x1b[Hafter",);
    }

    #[test]
    fn ring_replays_alt_screen_state_before_a_later_clear() {
        let mut ring = ScrollbackRing::new(128);

        ring.push(b"\x1b[?1049hfull-screen");
        ring.push(b"\x1b[2Jredraw");

        assert_eq!(ring.snapshot(), b"\x1b[?1049h\x1b[2Jredraw");
    }

    #[test]
    fn protected_seed_survives_live_process_clear_and_ages_out() {
        let mut ring = ScrollbackRing::new(16);
        ring.seed_protected(b"old\r\n");

        assert!(ring.push(b"\x1b[2Jnew"));
        assert_eq!(ring.snapshot(), b"old\r\nnew");

        ring.push(b"-0123456789abcdef");
        assert_eq!(ring.snapshot(), b"0123456789abcdef");
        assert!(ring.push(b"\x1b[2Jfresh"));
        assert_eq!(ring.snapshot(), b"\x1b[2Jfresh");
    }

    #[test]
    fn clear_sequences_do_not_include_alt_screen_switches() {
        assert!(!CLEAR_SEQUENCES.contains(&b"\x1b[?1049h".as_slice()));
        assert!(!CLEAR_SEQUENCES.contains(&b"\x1b[?1049l".as_slice()));
    }
}

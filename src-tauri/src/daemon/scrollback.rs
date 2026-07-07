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
}

impl ScrollbackRing {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap.min(8192)),
            cap,
            pending_clear_prefix: Vec::new(),
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        let combined;
        let detection_bytes = if self.pending_clear_prefix.is_empty() {
            bytes
        } else {
            combined = [self.pending_clear_prefix.as_slice(), bytes].concat();
            combined.as_slice()
        };

        let bytes_to_store = if let Some(start) = start_after_last_clear(detection_bytes) {
            self.clear();
            &detection_bytes[start..]
        } else {
            bytes
        };

        let next_pending_clear_prefix = trailing_clear_prefix(detection_bytes).to_vec();
        self.buf.extend(bytes_to_store.iter().copied());
        self.pending_clear_prefix = next_pending_clear_prefix;
        let overflow = self.buf.len().saturating_sub(self.cap);
        if overflow > 0 {
            self.buf.drain(..overflow);
        }
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
    }
}

fn start_after_last_clear(bytes: &[u8]) -> Option<usize> {
    find_last_clear_span(bytes).map(|(start, _end)| include_adjacent_clear_prefix(bytes, start))
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

        assert_eq!(ring.snapshot(), b"\x1b[2J\x1b[3J\x1b[Hafter");
    }

    #[test]
    fn clear_sequences_do_not_include_alt_screen_switches() {
        assert!(!CLEAR_SEQUENCES.contains(&b"\x1b[?1049h".as_slice()));
        assert!(!CLEAR_SEQUENCES.contains(&b"\x1b[?1049l".as_slice()));
    }
}

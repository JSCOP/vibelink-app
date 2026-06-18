use std::collections::VecDeque;

const CLEAR_SEQUENCES: [&[u8]; 3] = [b"\x1b[2J", b"\x1b[3J", b"\x1b[?1049h"];

#[derive(Debug, Clone)]
pub struct ScrollbackRing {
    buf: VecDeque<u8>,
    cap: usize,
}

impl ScrollbackRing {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap.min(8192)),
            cap,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        let bytes = self.bytes_after_last_clear(bytes);
        self.buf.extend(bytes.iter().copied());
        while self.buf.len() > self.cap {
            self.buf.pop_front();
        }
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }

    pub fn clear(&mut self) {
        self.buf.clear();
    }

    fn bytes_after_last_clear<'a>(&mut self, bytes: &'a [u8]) -> &'a [u8] {
        let mut clear_end = None;
        for sequence in CLEAR_SEQUENCES {
            if let Some(pos) = find_subslice(bytes, sequence) {
                let end = pos + sequence.len();
                if clear_end.is_none_or(|prev| end > prev) {
                    clear_end = Some(end);
                }
            }
        }

        if let Some(end) = clear_end {
            self.clear();
            &bytes[end..]
        } else {
            bytes
        }
    }
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
    fn ring_clears_on_full_clear_escape() {
        let mut ring = ScrollbackRing::new(64);

        ring.push(b"before");
        ring.push(b"\x1b[2Jafter");

        assert_eq!(ring.snapshot(), b"after");
    }

    #[test]
    fn ring_clears_on_alt_screen_enter() {
        let mut ring = ScrollbackRing::new(64);

        ring.push(b"before");
        ring.push(b"\x1b[?1049hafter");

        assert_eq!(ring.snapshot(), b"after");
    }
}

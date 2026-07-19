//! Strips terminal-query sequences from scrollback snapshots before replay.
//!
//! A pane's scrollback is a raw byte log of everything the child process wrote.
//! TUIs probe the terminal at startup (DA1 `ESC[c`, DSR `ESC[6n`, DECRQM
//! `ESC[?2026$p`, OSC 10/11 color queries, XTGETTCAP, ...). Replaying those
//! probes into xterm.js on attach makes it *answer them again*; the TUI's
//! capability detection finished long ago, so the late replies land in its
//! input queue and can leak into the prompt as stray keystrokes (the classic
//! symptom is a lone `c` from a split DA1 reply). Queries are one-shot
//! request/response traffic, never part of the visible screen state, so
//! dropping them from the replay is always safe.

/// Remove query sequences (those that make a terminal emulator write a
/// response back to the pty) from a complete scrollback snapshot. All other
/// bytes pass through unchanged, including incomplete trailing sequences.
pub fn strip_terminal_queries(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        let byte = bytes[index];
        if byte != 0x1b {
            out.push(byte);
            index += 1;
            continue;
        }

        match bytes.get(index + 1) {
            Some(b'[') => match parse_csi(bytes, index) {
                Some((end, strip)) => {
                    if !strip {
                        out.extend_from_slice(&bytes[index..end]);
                    }
                    index = end;
                }
                // Incomplete CSI at snapshot end: keep verbatim.
                None => {
                    out.extend_from_slice(&bytes[index..]);
                    break;
                }
            },
            Some(b']') => match parse_string_sequence(bytes, index) {
                Some((end, payload_start)) => {
                    if !is_osc_query(&bytes[payload_start..end]) {
                        out.extend_from_slice(&bytes[index..end]);
                    }
                    index = end;
                }
                None => {
                    out.extend_from_slice(&bytes[index..]);
                    break;
                }
            },
            Some(b'P') => match parse_string_sequence(bytes, index) {
                Some((end, payload_start)) => {
                    if !is_dcs_query(&bytes[payload_start..end]) {
                        out.extend_from_slice(&bytes[index..end]);
                    }
                    index = end;
                }
                None => {
                    out.extend_from_slice(&bytes[index..]);
                    break;
                }
            },
            _ => {
                out.push(byte);
                index += 1;
            }
        }
    }

    out
}

/// Parse a CSI sequence starting at `start` (which points at ESC). Returns
/// `(end_exclusive, strip)` or `None` when the sequence is incomplete.
fn parse_csi(bytes: &[u8], start: usize) -> Option<(usize, bool)> {
    let mut index = start + 2;
    let params_start = index;
    while index < bytes.len() && (0x30..=0x3f).contains(&bytes[index]) {
        index += 1;
    }
    let params_end = index;
    while index < bytes.len() && (0x20..=0x2f).contains(&bytes[index]) {
        index += 1;
    }
    let intermediates = &bytes[params_end..index];
    let final_byte = *bytes.get(index)?;
    if !(0x40..=0x7e).contains(&final_byte) {
        // Malformed CSI: keep the ESC verbatim and resume after it so we never
        // mis-strip application bytes.
        return Some((start + 1, false));
    }
    let params = &bytes[params_start..params_end];
    Some((index + 1, csi_is_query(params, intermediates, final_byte)))
}

fn csi_is_query(params: &[u8], intermediates: &[u8], final_byte: u8) -> bool {
    match final_byte {
        // DA1/DA2/DA3 requests: `CSI c`, `CSI 0 c`, `CSI > c`, `CSI = c`.
        b'c' => intermediates.is_empty(),
        // DSR requests: `CSI 5 n`, `CSI 6 n`, `CSI ? 6 n`, ...
        b'n' => intermediates.is_empty(),
        // DECRQM: `CSI ? Pn $ p` / `CSI Pn $ p`. (`CSI ! p` DECSTR is kept.)
        b'p' => intermediates == b"$",
        // XTVERSION: `CSI > q` / `CSI > 0 q`. (`CSI Ps SP q` DECSCUSR is kept.)
        b'q' => intermediates.is_empty() && params.first() == Some(&b'>'),
        // kitty keyboard protocol query: exactly `CSI ? u`.
        b'u' => intermediates.is_empty() && params == b"?",
        // XTWINOPS reports: 14/16/18 ask for pixel/cell geometry reports.
        b't' => {
            intermediates.is_empty()
                && matches!(leading_number(params), Some(14) | Some(16) | Some(18))
        }
        _ => false,
    }
}

fn leading_number(params: &[u8]) -> Option<u32> {
    let digits: Vec<u8> = params
        .iter()
        .copied()
        .take_while(|byte| byte.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    // A leading number is only "the first parameter" when followed by a
    // separator or nothing.
    match params.get(digits.len()) {
        None | Some(b';') | Some(b':') => std::str::from_utf8(&digits).ok()?.parse().ok(),
        _ => None,
    }
}

/// Parse an OSC (`ESC ]`) or DCS (`ESC P`) string sequence starting at `start`.
/// Returns `(end_exclusive, payload_start)`; the payload excludes the
/// terminator. `None` when the terminator has not arrived yet.
fn parse_string_sequence(bytes: &[u8], start: usize) -> Option<(usize, usize)> {
    let payload_start = start + 2;
    let mut index = payload_start;
    while index < bytes.len() {
        match bytes[index] {
            0x07 => return Some((index + 1, payload_start)),
            0x1b if bytes.get(index + 1) == Some(&b'\\') => {
                return Some((index + 2, payload_start))
            }
            _ => index += 1,
        }
    }
    None
}

/// OSC queries carry `?` as their final argument: `10;?`, `11;?`, `4;5;?`,
/// `52;c;?`. Restricted to the color/clipboard codes that terminals answer.
fn is_osc_query(payload: &[u8]) -> bool {
    let payload = strip_string_terminator(payload);
    let Some(first_end) = payload.iter().position(|byte| *byte == b';') else {
        return false;
    };
    let code = &payload[..first_end];
    if !code.iter().all(u8::is_ascii_digit) {
        return false;
    }
    let is_answerable_code = matches!(
        std::str::from_utf8(code)
            .ok()
            .and_then(|s| s.parse::<u32>().ok()),
        Some(4) | Some(5) | Some(10..=19) | Some(52)
    );
    is_answerable_code && (payload.ends_with(b";?") || &payload[first_end + 1..] == b"?")
}

/// XTGETTCAP (`DCS + q ... ST`) and DECRQSS (`DCS $ q ... ST`).
fn is_dcs_query(payload: &[u8]) -> bool {
    let payload = strip_string_terminator(payload);
    payload.starts_with(b"+q") || payload.starts_with(b"$q")
}

fn strip_string_terminator(payload: &[u8]) -> &[u8] {
    if payload.ends_with(&[0x07]) {
        &payload[..payload.len() - 1]
    } else if payload.ends_with(&[0x1b, b'\\']) {
        &payload[..payload.len() - 2]
    } else {
        payload
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter(input: &[u8]) -> Vec<u8> {
        strip_terminal_queries(input)
    }

    #[test]
    fn passes_plain_text_and_sgr_through() {
        let input = b"hello \x1b[31mred\x1b[0m world\r\n";
        assert_eq!(filter(input), input.to_vec());
    }

    #[test]
    fn strips_da_and_dsr_queries() {
        assert_eq!(filter(b"a\x1b[cb"), b"ab".to_vec());
        assert_eq!(filter(b"a\x1b[0cb"), b"ab".to_vec());
        assert_eq!(filter(b"a\x1b[>cb"), b"ab".to_vec());
        assert_eq!(filter(b"a\x1b[6nb"), b"ab".to_vec());
        assert_eq!(filter(b"a\x1b[?6nb"), b"ab".to_vec());
    }

    #[test]
    fn strips_decrqm_and_kitty_and_xtversion_queries() {
        assert_eq!(filter(b"a\x1b[?2026$pb"), b"ab".to_vec());
        assert_eq!(filter(b"a\x1b[?ub"), b"ab".to_vec());
        assert_eq!(filter(b"a\x1b[>0qb"), b"ab".to_vec());
    }

    #[test]
    fn strips_geometry_report_requests_only() {
        assert_eq!(filter(b"a\x1b[14tb"), b"ab".to_vec());
        assert_eq!(filter(b"a\x1b[18tb"), b"ab".to_vec());
        // Title-stack push/pop and resize are not queries.
        assert_eq!(filter(b"a\x1b[22;0tb"), b"a\x1b[22;0tb".to_vec());
        assert_eq!(filter(b"a\x1b[8;24;80tb"), b"a\x1b[8;24;80tb".to_vec());
        // 140-something is not 14.
        assert_eq!(filter(b"a\x1b[140tb"), b"a\x1b[140tb".to_vec());
    }

    #[test]
    fn keeps_non_query_lookalikes() {
        // DECSTR (soft reset) has `!` intermediate.
        assert_eq!(filter(b"\x1b[!p"), b"\x1b[!p".to_vec());
        // DECSCUSR (cursor style) has a space intermediate before `q`.
        assert_eq!(filter(b"\x1b[5 q"), b"\x1b[5 q".to_vec());
        // Kitty keyboard push/pop are state changes, not queries.
        assert_eq!(filter(b"\x1b[>1u"), b"\x1b[>1u".to_vec());
        // SCORC restore cursor.
        assert_eq!(filter(b"\x1b[u"), b"\x1b[u".to_vec());
        // Alt-screen + mouse modes must replay so terminal state reconstructs.
        assert_eq!(
            filter(b"\x1b[?1049h\x1b[?1000h"),
            b"\x1b[?1049h\x1b[?1000h".to_vec()
        );
    }

    #[test]
    fn strips_osc_color_and_clipboard_queries_keeps_setters() {
        assert_eq!(filter(b"a\x1b]11;?\x07b"), b"ab".to_vec());
        assert_eq!(filter(b"a\x1b]10;?\x1b\\b"), b"ab".to_vec());
        assert_eq!(filter(b"a\x1b]4;5;?\x07b"), b"ab".to_vec());
        assert_eq!(filter(b"a\x1b]52;c;?\x07b"), b"ab".to_vec());
        // Setters keep flowing: window title and palette assignment.
        assert_eq!(filter(b"\x1b]0;title\x07"), b"\x1b]0;title\x07".to_vec());
        assert_eq!(
            filter(b"\x1b]4;5;rgb:aa/bb/cc\x07"),
            b"\x1b]4;5;rgb:aa/bb/cc\x07".to_vec()
        );
        // OSC 52 clipboard *write* is kept.
        assert_eq!(
            filter(b"\x1b]52;c;aGVsbG8=\x07"),
            b"\x1b]52;c;aGVsbG8=\x07".to_vec()
        );
    }

    #[test]
    fn strips_dcs_queries_keeps_other_dcs() {
        assert_eq!(filter(b"a\x1bP+q544e\x1b\\b"), b"ab".to_vec());
        assert_eq!(filter(b"a\x1bP$qm\x1b\\b"), b"ab".to_vec());
        // Sixel data (DCS q without intermediate prefix) passes through.
        assert_eq!(
            filter(b"\x1bPq#0;2;0;0;0\x1b\\"),
            b"\x1bPq#0;2;0;0;0\x1b\\".to_vec()
        );
    }

    #[test]
    fn keeps_incomplete_trailing_sequences() {
        assert_eq!(filter(b"abc\x1b[?20"), b"abc\x1b[?20".to_vec());
        assert_eq!(filter(b"abc\x1b]11;?"), b"abc\x1b]11;?".to_vec());
        assert_eq!(filter(b"abc\x1b"), b"abc\x1b".to_vec());
    }

    #[test]
    fn handles_query_split_boundaries_inside_snapshot() {
        // Query directly followed by another escape sequence.
        assert_eq!(filter(b"\x1b[c\x1b[31mred"), b"\x1b[31mred".to_vec());
        // Back-to-back queries.
        assert_eq!(filter(b"\x1b[c\x1b[6n\x1b[?u"), b"".to_vec());
    }
}

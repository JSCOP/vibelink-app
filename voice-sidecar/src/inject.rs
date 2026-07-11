use anyhow::Result;

pub struct TextInjector {
    add_trailing_space: bool,
    add_trailing_newline: bool,
}

impl TextInjector {
    pub fn new() -> Result<Self> {
        Ok(Self {
            add_trailing_space: true,
            add_trailing_newline: false,
        })
    }

    pub fn set_options(&mut self, add_trailing_space: bool, add_trailing_newline: bool) {
        self.add_trailing_space = add_trailing_space;
        self.add_trailing_newline = add_trailing_newline;
    }

    pub fn inject_text_fast(&self, text: &str) -> Result<()> {
        platform::inject_text_fast(text, self.add_trailing_space, self.add_trailing_newline)
    }
}

#[cfg(windows)]
mod platform {
    use anyhow::{anyhow, Result};
    use windows::Win32::Foundation::GetLastError;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        VIRTUAL_KEY,
    };

    pub(super) fn inject_text_fast(
        text: &str,
        add_trailing_space: bool,
        add_trailing_newline: bool,
    ) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }

        let append_space = add_trailing_space && !text.ends_with(' ');
        let append_newline = add_trailing_newline && !text.ends_with('\n');
        let mut events = Vec::with_capacity(
            (text.len() + usize::from(append_space) + usize::from(append_newline)) * 2,
        );

        for unit in text.encode_utf16() {
            push_unicode_unit(&mut events, unit);
        }
        if append_space {
            push_unicode_unit(&mut events, b' ' as u16);
        }
        if append_newline {
            push_unicode_unit(&mut events, b'\n' as u16);
        }

        if events.is_empty() {
            return Ok(());
        }

        let sent = unsafe { SendInput(&events, std::mem::size_of::<INPUT>() as i32) };
        if sent != events.len() as u32 {
            let error = unsafe { GetLastError() };
            return Err(anyhow!(
                "SendInput sent {sent} of {} keyboard events (GetLastError={})",
                events.len(),
                error.0
            ));
        }

        Ok(())
    }

    fn push_unicode_unit(events: &mut Vec<INPUT>, unit: u16) {
        events.push(unicode_input(unit, false));
        events.push(unicode_input(unit, true));
    }

    fn unicode_input(unit: u16, key_up: bool) -> INPUT {
        let flags = if key_up {
            KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
        } else {
            KEYEVENTF_UNICODE
        };

        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: unit,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use anyhow::{bail, Result};

    pub(super) fn inject_text_fast(
        text: &str,
        _add_trailing_space: bool,
        _add_trailing_newline: bool,
    ) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }

        bail!("text injection is unsupported on non-Windows platforms")
    }
}

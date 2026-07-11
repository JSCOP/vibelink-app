use anyhow::Result;
use parking_lot::Mutex;

#[derive(Debug, Default)]
struct MuteState {
    was_muted_before: bool,
    muted_by_us: bool,
}

pub struct SpeakerMute {
    enabled: bool,
    state: Mutex<MuteState>,
}

impl SpeakerMute {
    pub fn new(enabled: bool) -> Result<Self> {
        Ok(Self {
            enabled,
            state: Mutex::new(MuteState::default()),
        })
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn mute(&self) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }

        platform::mute(&self.state)
    }

    pub fn unmute(&self) -> Result<()> {
        platform::unmute(&self.state)
    }

    pub fn force_unmute(&self) -> Result<()> {
        platform::force_unmute(&self.state)
    }
}

#[cfg(windows)]
mod platform {
    use std::ptr::null;

    use anyhow::{Context, Result};
    use parking_lot::Mutex;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    use super::MuteState;

    pub(super) fn mute(state: &Mutex<MuteState>) -> Result<()> {
        with_endpoint_volume(|volume| {
            let was_muted = unsafe { volume.GetMute() }
                .context("failed to read speaker mute state")?
                .as_bool();

            let mut state = state.lock();
            state.was_muted_before = was_muted;
            state.muted_by_us = false;

            if !was_muted {
                unsafe { volume.SetMute(true, null()) }.context("failed to mute speakers")?;
                state.muted_by_us = true;
            }

            Ok(())
        })
    }

    pub(super) fn unmute(state: &Mutex<MuteState>) -> Result<()> {
        let should_unmute = {
            let state = state.lock();
            state.muted_by_us && !state.was_muted_before
        };

        if should_unmute {
            with_endpoint_volume(|volume| {
                unsafe { volume.SetMute(false, null()) }.context("failed to unmute speakers")
            })?;
        }

        let mut state = state.lock();
        state.muted_by_us = false;
        state.was_muted_before = false;
        Ok(())
    }

    pub(super) fn force_unmute(state: &Mutex<MuteState>) -> Result<()> {
        with_endpoint_volume(|volume| {
            unsafe { volume.SetMute(false, null()) }.context("failed to force-unmute speakers")
        })?;

        let mut state = state.lock();
        state.muted_by_us = false;
        state.was_muted_before = false;
        Ok(())
    }

    fn with_endpoint_volume<T>(call: impl FnOnce(&IAudioEndpointVolume) -> Result<T>) -> Result<T> {
        let com = ComApartment::initialize();
        let volume = endpoint_volume()?;
        let result = call(&volume);
        drop(volume);
        drop(com);
        result
    }

    fn endpoint_volume() -> Result<IAudioEndpointVolume> {
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .context("failed to create MMDeviceEnumerator")?;
            let endpoint = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .context("failed to get default render endpoint")?;
            endpoint
                .Activate(CLSCTX_ALL, None)
                .context("failed to activate speaker endpoint volume")
        }
    }

    struct ComApartment {
        uninitialize: bool,
    }

    impl ComApartment {
        fn initialize() -> Self {
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            Self {
                uninitialize: hr.is_ok(),
            }
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.uninitialize {
                unsafe { CoUninitialize() };
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use anyhow::Result;
    use parking_lot::Mutex;

    use super::MuteState;

    pub(super) fn mute(_state: &Mutex<MuteState>) -> Result<()> {
        Ok(())
    }

    pub(super) fn unmute(state: &Mutex<MuteState>) -> Result<()> {
        let mut state = state.lock();
        state.muted_by_us = false;
        state.was_muted_before = false;
        Ok(())
    }

    pub(super) fn force_unmute(state: &Mutex<MuteState>) -> Result<()> {
        unmute(state)
    }
}

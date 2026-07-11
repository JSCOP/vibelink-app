use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Host, SampleFormat, Stream, StreamConfig};
use parking_lot::Mutex;

use crate::protocol::AudioDeviceInfo;

const SAMPLE_RATE: u32 = 16_000;
const CHANNELS: u16 = 1;
const AUDIO_LEVEL_INTERVAL: Duration = Duration::from_micros(1_000_000 / 15);
const AUDIO_RMS_PEAK_DECAY: f32 = 0.998;
const AUDIO_RMS_THRESHOLD: f32 = 0.1;
const AUDIO_LEVEL_CURVE_EXPONENT: f32 = 0.5;
const INITIAL_RMS_PEAK: f32 = 50.0;

type LevelCallback = Arc<dyn Fn(f32) + Send + Sync + 'static>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedAudio {
    pub samples: Vec<i16>,
    pub sample_rate: u32,
    pub channels: u16,
}

impl CapturedAudio {
    pub fn frame_count(&self) -> usize {
        if self.channels == 0 {
            return 0;
        }
        self.samples.len() / usize::from(self.channels)
    }
}

#[derive(Default)]
struct CaptureState {
    recording: bool,
    samples: Vec<i16>,
    sample_rate: u32,
    channels: u16,
    rms_peak: f32,
    last_level_at: Option<Instant>,
}

pub struct AudioController {
    device_index: Option<usize>,
    stream: Option<Stream>,
    state: Arc<Mutex<CaptureState>>,
    level_callback: Option<LevelCallback>,
}

impl AudioController {
    pub fn new(device_index: Option<usize>) -> Result<Self> {
        Ok(Self {
            device_index,
            stream: None,
            state: Arc::new(Mutex::new(CaptureState {
                rms_peak: INITIAL_RMS_PEAK,
                ..CaptureState::default()
            })),
            level_callback: None,
        })
    }

    pub fn list_devices() -> Result<Vec<AudioDeviceInfo>> {
        let host = audio_host()?;
        let default_device = host.default_input_device();
        let mut devices = Vec::new();

        for (index, device) in host
            .input_devices()
            .context("failed to enumerate input audio devices")?
            .enumerate()
        {
            let info = device_info(index, &device, default_device.as_ref());
            devices.push(info);
        }

        Ok(devices)
    }

    pub fn set_level_callback<F>(&mut self, callback: F)
    where
        F: Fn(f32) + Send + Sync + 'static,
    {
        self.level_callback = Some(Arc::new(callback));
    }

    pub fn set_device_index(&mut self, device_index: Option<usize>) {
        self.device_index = device_index;
    }

    pub fn is_recording(&self) -> bool {
        self.state.lock().recording
    }

    pub fn start_recording(&mut self) -> Result<()> {
        if self.is_recording() {
            return Ok(());
        }

        let host = audio_host()?;
        let device = select_input_device(&host, self.device_index)?;
        let default_config = device
            .default_input_config()
            .context("failed to read default input stream config")?;
        let sample_format = default_config.sample_format();
        let config = default_config.config();
        let sample_rate = config.sample_rate;
        let channels = config.channels;

        {
            let mut state = self.state.lock();
            state.recording = true;
            state.samples.clear();
            state.sample_rate = sample_rate;
            state.channels = channels;
            state.rms_peak = INITIAL_RMS_PEAK;
            state.last_level_at = None;
        }

        tracing::info!(
            sample_rate,
            channels,
            sample_format = %sample_format,
            "audio_capture_configured"
        );

        let capture_state = Arc::clone(&self.state);
        let level_callback = self.level_callback.clone();
        let stream = match build_input_stream(
            &device,
            config,
            sample_format,
            Arc::clone(&capture_state),
            level_callback,
        ) {
            Ok(stream) => stream,
            Err(error) => {
                self.state.lock().recording = false;
                return Err(error).context("failed to build WASAPI input stream");
            }
        };

        if let Err(error) = stream.play() {
            self.state.lock().recording = false;
            return Err(error).context("failed to start input audio stream");
        }

        self.stream = Some(stream);
        Ok(())
    }

    pub fn stop_recording(&mut self) -> Result<CapturedAudio> {
        if !self.is_recording() {
            return Err(anyhow!("audio capture is not recording"));
        }

        self.state.lock().recording = false;
        if let Some(stream) = self.stream.take() {
            let _ = stream.pause();
            drop(stream);
        }

        let mut state = self.state.lock();
        let captured = CapturedAudio {
            samples: std::mem::take(&mut state.samples),
            sample_rate: state.sample_rate,
            channels: state.channels,
        };
        state.sample_rate = 0;
        state.channels = 0;
        state.rms_peak = INITIAL_RMS_PEAK;
        state.last_level_at = None;
        Ok(captured)
    }

    pub fn cancel_recording(&mut self) -> Result<()> {
        self.state.lock().recording = false;
        if let Some(stream) = self.stream.take() {
            let _ = stream.pause();
            drop(stream);
        }

        let mut state = self.state.lock();
        state.samples.clear();
        state.sample_rate = 0;
        state.channels = 0;
        state.rms_peak = INITIAL_RMS_PEAK;
        state.last_level_at = None;
        Ok(())
    }
}

fn build_input_stream(
    device: &Device,
    config: StreamConfig,
    sample_format: SampleFormat,
    state: Arc<Mutex<CaptureState>>,
    level_callback: Option<LevelCallback>,
) -> Result<Stream> {
    match sample_format {
        SampleFormat::I16 => device
            .build_input_stream(
                config,
                move |samples: &[i16], _| {
                    capture_converted_samples(samples, &state, level_callback.as_ref(), |sample| {
                        sample
                    });
                },
                move |error| tracing::warn!(%error, "audio input stream error"),
                None,
            )
            .map_err(Into::into),
        SampleFormat::F32 => device
            .build_input_stream(
                config,
                move |samples: &[f32], _| {
                    capture_converted_samples(
                        samples,
                        &state,
                        level_callback.as_ref(),
                        f32_sample_to_i16,
                    );
                },
                move |error| tracing::warn!(%error, "audio input stream error"),
                None,
            )
            .map_err(Into::into),
        SampleFormat::U16 => device
            .build_input_stream(
                config,
                move |samples: &[u16], _| {
                    capture_converted_samples(
                        samples,
                        &state,
                        level_callback.as_ref(),
                        u16_sample_to_i16,
                    );
                },
                move |error| tracing::warn!(%error, "audio input stream error"),
                None,
            )
            .map_err(Into::into),
        unsupported => Err(anyhow!("unsupported input sample format {unsupported}")),
    }
}

fn capture_converted_samples<T, F>(
    samples: &[T],
    state: &Arc<Mutex<CaptureState>>,
    level_callback: Option<&LevelCallback>,
    convert: F,
) where
    T: Copy,
    F: Fn(T) -> i16,
{
    if samples.is_empty() {
        return;
    }

    let now = Instant::now();
    let mut callback_level = None;

    {
        let mut state = state.lock();
        if !state.recording {
            return;
        }

        state.samples.reserve(samples.len());
        let mut sum_squares = 0.0_f64;
        for sample in samples {
            let pcm = convert(*sample);
            state.samples.push(pcm);
            let value = f64::from(pcm);
            sum_squares += value * value;
        }

        let rms = (sum_squares / samples.len() as f64).sqrt() as f32;
        if rms > state.rms_peak {
            state.rms_peak = rms;
        } else {
            state.rms_peak *= AUDIO_RMS_PEAK_DECAY;
        }

        let should_emit = state.last_level_at.map_or(true, |last| {
            now.saturating_duration_since(last) >= AUDIO_LEVEL_INTERVAL
        });
        if should_emit {
            state.last_level_at = Some(now);
            callback_level = Some(normalize_level(rms, state.rms_peak));
        }
    }

    if let (Some(callback), Some(level)) = (level_callback, callback_level) {
        callback(level);
    }
}

fn u16_sample_to_i16(sample: u16) -> i16 {
    ((sample as i32) - 32_768) as i16
}

fn f32_sample_to_i16(sample: f32) -> i16 {
    if sample <= -1.0 {
        return i16::MIN;
    }
    if sample >= 1.0 {
        return i16::MAX;
    }
    (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16
}

fn normalize_level(rms: f32, peak: f32) -> f32 {
    if peak <= AUDIO_RMS_THRESHOLD {
        return 0.0;
    }

    (rms / peak)
        .max(0.0)
        .powf(AUDIO_LEVEL_CURVE_EXPONENT)
        .min(1.0)
}

fn select_input_device(host: &Host, device_index: Option<usize>) -> Result<Device> {
    if let Some(index) = device_index {
        let devices = host
            .input_devices()
            .context("failed to enumerate input audio devices")?
            .collect::<Vec<_>>();
        return devices
            .into_iter()
            .nth(index)
            .ok_or_else(|| anyhow!("configured input audio device index {index} was not found"));
    }

    host.default_input_device().ok_or_else(|| {
        anyhow!(
            "no default input audio device available; connect a microphone and check Windows microphone privacy settings"
        )
    })
}

fn device_info(index: usize, device: &Device, default_device: Option<&Device>) -> AudioDeviceInfo {
    let default_config = device.default_input_config().ok();
    let name = device
        .description()
        .map(|description| description.name().to_owned())
        .unwrap_or_else(|_| "Unknown input device".to_owned());
    let channels = default_config
        .as_ref()
        .map_or(CHANNELS, |config| config.channels());
    let sample_rate = default_config
        .as_ref()
        .map_or(f64::from(SAMPLE_RATE), |config| {
            f64::from(config.sample_rate())
        });
    let is_default = default_device.is_some_and(|default_device| default_device == device);

    AudioDeviceInfo {
        index,
        name,
        channels,
        sample_rate,
        is_default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_f32_input_samples_to_i16_pcm() {
        let converted = [-1.0, 0.0, 0.5, 1.0].map(f32_sample_to_i16);

        assert_eq!(converted, [i16::MIN, 0, 16_384, i16::MAX]);
    }
}
#[cfg(windows)]
fn audio_host() -> Result<Host> {
    cpal::host_from_id(cpal::HostId::Wasapi).context("failed to initialize WASAPI audio host")
}

#[cfg(not(windows))]
fn audio_host() -> Result<Host> {
    Ok(cpal::default_host())
}

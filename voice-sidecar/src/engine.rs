use std::ffi::CStr;
use std::sync::LazyLock;
use std::time::Instant;

use anyhow::{bail, Context, Result};
use audioadapter_buffers::direct::SequentialSliceOfVecs;
use regex::Regex;
use rubato::{Fft, FixedSync, Resampler};
use whisper_rs::{
    convert_integer_to_float_audio, convert_stereo_to_mono_audio, FullParams, SamplingStrategy,
    WhisperContext, WhisperContextParameters, WhisperState,
};

use crate::model::ModelFile;
use crate::protocol::{
    ModelDownloadProgressPayload, ModelDownloadStage, ModelRuntimeInfo, SidecarConfig,
    TranscriptionPayload,
};
use tracing::warn;

const TARGET_SAMPLE_RATE: u32 = 16_000;
const STT_MIN_AUDIO_BYTES: usize = 1_000;
const STT_MIN_AUDIO_DURATION_SECONDS: f64 = 0.5;
const STT_RMS_SILENCE_THRESHOLD: f64 = 0.004;

static HALLUCINATION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)자막.*제공|광고.*플러스친구|kakaotalk|구독.*좋아요|시청.*감사|채널.*구독|^\s*감사합니다[.!?。．！？…]*\s*$",
    )
    .expect("Korean hallucination regex must compile")
});

pub type EngineResult = TranscriptionPayload;

pub struct Engine {
    config: SidecarConfig,
    context: Option<WhisperContext>,
    state: Option<WhisperState>,
    model_file: Option<ModelFile>,
    effective_device: String,
    effective_model_id: String,
}

impl Engine {
    pub fn new(config: SidecarConfig) -> Result<Self> {
        Ok(Self {
            effective_device: effective_device_label(&config.device).to_owned(),
            effective_model_id: config.model_id.clone(),
            config,
            context: None,
            state: None,
            model_file: None,
        })
    }

    pub fn is_loaded(&self) -> bool {
        self.context.is_some() && self.state.is_some()
    }

    pub fn apply_config(&mut self, config: SidecarConfig) -> Result<()> {
        validate_device(&config.device)?;

        let reload_required =
            self.config.model_id != config.model_id || self.config.device != config.device;

        if reload_required {
            self.unload();
            self.effective_device = effective_device_label(&config.device).to_owned();
            self.effective_model_id = config.model_id.clone();
        }

        self.config = config;
        Ok(())
    }

    pub fn unload(&mut self) {
        self.state = None;
        self.context = None;
        self.model_file = None;
    }

    pub fn load<F>(&mut self, model_file: ModelFile, mut progress: F) -> Result<ModelRuntimeInfo>
    where
        F: FnMut(ModelDownloadProgressPayload),
    {
        let requested_gpu = use_gpu_for_device(&self.config.device)?;

        progress(self.progress_payload(
            ModelDownloadStage::Initializing,
            "Initializing Whisper runtime",
            Some(0),
        ));

        let load_context = |use_gpu: bool| {
            let mut params = WhisperContextParameters::new();
            params.use_gpu(use_gpu);
            WhisperContext::new_with_params(&model_file.path, params)
        };
        let (context, effective_device) = match load_context(requested_gpu) {
            Ok(context) => (context, if requested_gpu { "gpu" } else { "cpu" }),
            Err(gpu_error) if requested_gpu => {
                warn!(error = %gpu_error, "whisper_gpu_load_failed_falling_back_to_cpu");
                let context = load_context(false).with_context(|| {
                    format!(
                        "failed to load Whisper model '{}' on GPU and CPU",
                        model_file.path.display()
                    )
                })?;
                (context, "cpu")
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "failed to load Whisper model '{}'",
                        model_file.path.display()
                    )
                })
            }
        };
        let state = context
            .create_state()
            .context("failed to create reusable Whisper state")?;

        self.effective_device = effective_device.to_owned();
        self.effective_model_id = model_file.model_id.clone();
        self.model_file = Some(model_file);
        self.state = Some(state);
        self.context = Some(context);

        progress(self.progress_payload(ModelDownloadStage::Ready, "Model ready", Some(100)));

        Ok(self.runtime_info())
    }

    pub fn runtime_info(&self) -> ModelRuntimeInfo {
        ModelRuntimeInfo {
            effective_device: self.effective_device.clone(),
            model_id: self.effective_model_id.clone(),
        }
    }

    pub fn transcribe_with_format(
        &mut self,
        samples: &[i16],
        sample_rate: u32,
        channels: u16,
    ) -> Result<EngineResult> {
        if !self.is_loaded() {
            bail!("Model not loaded. Call load() before transcribing.");
        }
        if sample_rate == 0 {
            bail!("sample_rate must be greater than zero");
        }
        if channels == 0 {
            bail!("channels must be greater than zero");
        }
        if samples.len() * std::mem::size_of::<i16>() < STT_MIN_AUDIO_BYTES {
            return Ok(empty_result(
                self.config.language.as_deref().unwrap_or_default(),
                0.0,
            ));
        }

        let channel_count = channels as usize;
        let frame_count = samples.len() / channel_count;
        let audio_duration = frame_count as f64 / sample_rate as f64;
        if audio_duration < STT_MIN_AUDIO_DURATION_SECONDS {
            return Ok(empty_result(
                self.config.language.as_deref().unwrap_or_default(),
                audio_duration,
            ));
        }

        let start = Instant::now();
        let audio = pcm_i16_to_mono_f32(samples, channel_count)?;
        let audio = resample_to_16khz(audio, sample_rate)?;
        if audio_rms(&audio) < STT_RMS_SILENCE_THRESHOLD {
            return Ok(empty_result(
                self.config.language.as_deref().unwrap_or_default(),
                audio_duration,
            ));
        }

        let decode_language = whisper_decode_language(self.config.language.as_deref());
        let mut params = FullParams::new(sampling_strategy(self.config.beam_size));
        params.set_n_threads(whisper_thread_count());
        params.set_language(decode_language.language);
        params.set_detect_language(decode_language.detect_only);
        params.set_translate(false);
        params.set_no_context(true);
        params.set_no_timestamps(true);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        if !self.config.initial_prompt.trim().is_empty() {
            params.set_initial_prompt(&self.config.initial_prompt);
        }

        let state = self
            .state
            .as_mut()
            .context("Whisper state is unavailable")?;
        state
            .full(params, &audio)
            .context("Whisper transcription failed")?;

        let detected_language =
            detected_language_from_state(state, self.config.language.as_deref());
        let mut text = collect_segments(state)?;

        if !text.is_empty() && is_korean_hallucination(&text) {
            text.clear();
        }

        let processing_time = start.elapsed().as_secs_f64();
        if text.is_empty() {
            return Ok(TranscriptionPayload {
                text,
                language: detected_language,
                audio_duration,
                processing_time,
            });
        }

        Ok(TranscriptionPayload {
            text,
            language: detected_language,
            audio_duration,
            processing_time: start.elapsed().as_secs_f64(),
        })
    }

    fn progress_payload(
        &self,
        stage: ModelDownloadStage,
        message: &str,
        percent: Option<u8>,
    ) -> ModelDownloadProgressPayload {
        let file_name = self
            .model_file
            .as_ref()
            .map(|model| model.file_name.clone())
            .unwrap_or_default();
        ModelDownloadProgressPayload {
            stage,
            message: message.to_owned(),
            percent,
            downloaded_bytes: None,
            total_bytes: None,
            file_name,
            model_id: self.effective_model_id.clone(),
            requested_device: self.config.device.clone(),
            effective_device: self.effective_device.clone(),
        }
    }
}

pub fn is_korean_hallucination(text: &str) -> bool {
    HALLUCINATION_RE.is_match(text)
}

fn validate_device(device: &str) -> Result<()> {
    match device.trim().to_ascii_lowercase().as_str() {
        "auto" | "gpu" | "cpu" => Ok(()),
        other => bail!("unsupported device '{other}'; expected auto, gpu, or cpu"),
    }
}

fn use_gpu_for_device(device: &str) -> Result<bool> {
    validate_device(device)?;
    Ok(!device.trim().eq_ignore_ascii_case("cpu"))
}

fn effective_device_label(device: &str) -> &'static str {
    if device.trim().eq_ignore_ascii_case("cpu") {
        "cpu"
    } else {
        "gpu"
    }
}

fn normalize_source_language_for_whisper(language: Option<&str>) -> Option<&'static str> {
    let language = language?.trim();
    if language.is_empty() || language.eq_ignore_ascii_case("auto") {
        return None;
    }

    if language.eq_ignore_ascii_case("zh")
        || language.eq_ignore_ascii_case("zh-cn")
        || language.eq_ignore_ascii_case("zh-hans")
        || language.eq_ignore_ascii_case("zh-tw")
        || language.eq_ignore_ascii_case("zh-hant")
        || language.eq_ignore_ascii_case("zh-hk")
        || language.eq_ignore_ascii_case("zhcn")
        || language.eq_ignore_ascii_case("zhtw")
    {
        return Some("zh");
    }

    if language.eq_ignore_ascii_case("jp") || matches_language_tag(language, "ja") {
        return Some("ja");
    }
    if matches_language_tag(language, "ko") {
        return Some("ko");
    }
    if matches_language_tag(language, "en") {
        return Some("en");
    }
    if matches_language_tag(language, "es") {
        return Some("es");
    }
    if matches_language_tag(language, "fr") {
        return Some("fr");
    }
    if matches_language_tag(language, "de") {
        return Some("de");
    }

    None
}

#[derive(Debug, PartialEq, Eq)]
struct WhisperDecodeLanguage {
    language: Option<&'static str>,
    detect_only: bool,
}

fn whisper_decode_language(language: Option<&str>) -> WhisperDecodeLanguage {
    let language = normalize_source_language_for_whisper(language);

    WhisperDecodeLanguage {
        language,
        // whisper.cpp treats detect_language=true as detect-only mode and exits before decoding text.
        detect_only: false,
    }
}

fn matches_language_tag(value: &str, code: &str) -> bool {
    if value.eq_ignore_ascii_case(code) {
        return true;
    }

    let Some(prefix) = value.get(..code.len()) else {
        return false;
    };
    prefix.eq_ignore_ascii_case(code)
        && matches!(value.as_bytes().get(code.len()), Some(b'-' | b'_'))
}

/// whisper-rs defaults to min(4, hw). Cap CPU fallback threads to improve
/// throughput without oversubscribing memory bandwidth on interactive runs.
const WHISPER_MAX_THREADS: usize = 8;

fn whisper_thread_count() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, WHISPER_MAX_THREADS) as i32
}

fn sampling_strategy(beam_size: usize) -> SamplingStrategy {
    if beam_size <= 1 {
        return SamplingStrategy::Greedy { best_of: 1 };
    }

    SamplingStrategy::BeamSearch {
        beam_size: beam_size as i32,
        patience: -1.0,
    }
}

fn empty_result(language: &str, audio_duration: f64) -> TranscriptionPayload {
    TranscriptionPayload {
        text: String::new(),
        language: language.to_owned(),
        audio_duration,
        processing_time: 0.0,
    }
}

fn audio_rms(audio: &[f32]) -> f64 {
    if audio.is_empty() {
        return 0.0;
    }

    let sum_squares = audio
        .iter()
        .map(|sample| f64::from(*sample) * f64::from(*sample))
        .sum::<f64>();

    (sum_squares / audio.len() as f64).sqrt()
}

fn pcm_i16_to_mono_f32(samples: &[i16], channels: usize) -> Result<Vec<f32>> {
    if samples.len() % channels != 0 {
        bail!(
            "PCM sample count {} is not divisible by channel count {}",
            samples.len(),
            channels
        );
    }

    let mut converted = vec![0.0_f32; samples.len()];
    convert_integer_to_float_audio(samples, &mut converted)
        .context("failed to convert PCM i16 to f32")?;

    match channels {
        1 => Ok(converted),
        2 => {
            let mut mono = vec![0.0_f32; converted.len() / 2];
            convert_stereo_to_mono_audio(&converted, &mut mono)
                .context("failed to convert stereo PCM to mono")?;
            Ok(mono)
        }
        _ => {
            let mut mono = Vec::with_capacity(converted.len() / channels);
            for frame in converted.chunks_exact(channels) {
                mono.push(frame.iter().sum::<f32>() / channels as f32);
            }
            Ok(mono)
        }
    }
}

fn resample_to_16khz(audio: Vec<f32>, sample_rate: u32) -> Result<Vec<f32>> {
    if sample_rate == TARGET_SAMPLE_RATE {
        return Ok(audio);
    }
    if audio.is_empty() {
        return Ok(audio);
    }

    let chunk_size = audio.len().min(4096).max(16);
    let mut resampler = Fft::<f32>::new(
        sample_rate as usize,
        TARGET_SAMPLE_RATE as usize,
        chunk_size,
        1,
        1,
        FixedSync::Both,
    )
    .context("failed to create sample-rate converter")?;

    let input_len = audio.len();
    let input_channels = vec![audio];
    let input = SequentialSliceOfVecs::new(&input_channels, 1, input_len)
        .context("failed to wrap resampler input buffer")?;
    let output_capacity = resampler.process_all_needed_output_len(input_len).max(1);
    let mut output_channels = vec![vec![0.0_f32; output_capacity]];
    let written = {
        let mut output = SequentialSliceOfVecs::new_mut(&mut output_channels, 1, output_capacity)
            .context("failed to wrap resampler output buffer")?;
        let (_, written) = resampler
            .process_all_into_buffer(&input, &mut output, input_len, None)
            .context("failed to resample audio")?;
        written
    };

    let mut output = output_channels.remove(0);
    output.truncate(written);
    Ok(output)
}

fn collect_segments(state: &WhisperState) -> Result<String> {
    let mut parts = Vec::new();
    for segment in state.as_iter() {
        let segment_text = segment
            .to_str_lossy()
            .context("failed to decode Whisper segment text")?;
        let segment_text = segment_text.trim();
        if !segment_text.is_empty() {
            parts.push(segment_text.to_owned());
        }
    }
    Ok(parts.join(" ").trim().to_owned())
}

fn detected_language_from_state(state: &WhisperState, fallback: Option<&str>) -> String {
    let language_id = state.full_lang_id_from_state();
    if language_id >= 0 {
        // SAFETY: whisper_lang_str returns a static null-terminated language code for a valid id.
        let ptr = unsafe { whisper_rs::whisper_rs_sys::whisper_lang_str(language_id) };
        if !ptr.is_null() {
            // SAFETY: non-null pointer is owned by whisper.cpp and points to a valid C string.
            let value = unsafe { CStr::from_ptr(ptr) }.to_string_lossy();
            if !value.is_empty() {
                return value.into_owned();
            }
        }
    }
    normalize_source_language_for_whisper(fallback)
        .unwrap_or_default()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_greedy_decoding_for_interactive_default() {
        assert!(matches!(
            sampling_strategy(1),
            SamplingStrategy::Greedy { best_of: 1 }
        ));
        assert!(matches!(
            sampling_strategy(0),
            SamplingStrategy::Greedy { best_of: 1 }
        ));
    }

    #[test]
    fn keeps_beam_search_available_for_explicit_accuracy_mode() {
        assert!(matches!(
            sampling_strategy(5),
            SamplingStrategy::BeamSearch { beam_size: 5, patience } if patience == -1.0
        ));
    }

    #[test]
    fn caps_whisper_threads_for_interactive_transcription() {
        let threads = whisper_thread_count();

        assert!((1..=WHISPER_MAX_THREADS as i32).contains(&threads));
    }

    #[test]
    fn filters_korean_hallucination_patterns() {
        assert!(is_korean_hallucination("자막은 누군가 제공했습니다"));
        assert!(is_korean_hallucination("광고 플러스친구에서 확인하세요"));
        assert!(is_korean_hallucination("KakaoTalk으로 문의하세요"));
        assert!(is_korean_hallucination("구독 그리고 좋아요"));
        assert!(is_korean_hallucination("시청해 주셔서 감사합니다"));
        assert!(is_korean_hallucination("채널 구독 부탁드립니다"));
        assert!(is_korean_hallucination("감사합니다"));
        assert!(!is_korean_hallucination("오늘 회의 내용을 정리합니다"));
    }

    #[test]
    fn measures_audio_rms_for_silence_gate() {
        assert_eq!(audio_rms(&[]), 0.0);
        assert!(audio_rms(&vec![0.0; TARGET_SAMPLE_RATE as usize]) < STT_RMS_SILENCE_THRESHOLD);
        assert!(audio_rms(&vec![0.002; TARGET_SAMPLE_RATE as usize]) < STT_RMS_SILENCE_THRESHOLD);
        assert!(audio_rms(&vec![0.02; TARGET_SAMPLE_RATE as usize]) > STT_RMS_SILENCE_THRESHOLD);
    }

    #[test]
    fn auto_source_language_does_not_enable_whisper_detect_only_mode() {
        assert_eq!(
            whisper_decode_language(None),
            WhisperDecodeLanguage {
                language: None,
                detect_only: false,
            }
        );
        assert_eq!(
            whisper_decode_language(Some("auto")),
            WhisperDecodeLanguage {
                language: None,
                detect_only: false,
            }
        );
        assert_eq!(
            whisper_decode_language(Some("ko-KR")),
            WhisperDecodeLanguage {
                language: Some("ko"),
                detect_only: false,
            }
        );
    }

    #[test]
    fn normalizes_source_languages_for_whisper_detection() {
        assert_eq!(normalize_source_language_for_whisper(None), None);
        assert_eq!(normalize_source_language_for_whisper(Some("")), None);
        assert_eq!(normalize_source_language_for_whisper(Some("auto")), None);
        assert_eq!(
            normalize_source_language_for_whisper(Some("ko-KR")),
            Some("ko")
        );
        assert_eq!(
            normalize_source_language_for_whisper(Some("en-US")),
            Some("en")
        );
        assert_eq!(
            normalize_source_language_for_whisper(Some("jp")),
            Some("ja")
        );
        assert_eq!(
            normalize_source_language_for_whisper(Some("zh-CN")),
            Some("zh")
        );
        assert_eq!(
            normalize_source_language_for_whisper(Some("zh-TW")),
            Some("zh")
        );
        assert_eq!(
            normalize_source_language_for_whisper(Some("es-MX")),
            Some("es")
        );
        assert_eq!(
            normalize_source_language_for_whisper(Some("fr-FR")),
            Some("fr")
        );
        assert_eq!(
            normalize_source_language_for_whisper(Some("de-DE")),
            Some("de")
        );
        assert_eq!(normalize_source_language_for_whisper(Some("ru")), None);
    }
}

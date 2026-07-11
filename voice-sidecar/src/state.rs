use std::path::PathBuf;
use std::sync::{Arc, Weak};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use tokio::sync::mpsc::UnboundedSender;
use tokio::task;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::audio::{AudioController, CapturedAudio};
use crate::engine::Engine;
use crate::inject::TextInjector;
use crate::model;
use crate::mute::SpeakerMute;
use crate::protocol::{
    AudioDeviceInfo, ModelDownloadProgressPayload, ModelRuntimeInfo, ServerEvent, ServerEventKind,
    SidecarConfig, SidecarConfigPatch, SidecarStatus, TranscriptionPayload,
};

const MIN_AUDIO_SAMPLES: usize = 500;

#[derive(Clone)]
pub struct SharedState {
    inner: Arc<StateInner>,
}

struct StateInner {
    config: Mutex<SidecarConfig>,
    status: Mutex<SidecarStatus>,
    connection: Mutex<Option<ConnectedSender>>,
    audio: Mutex<AudioController>,
    engine: Mutex<Engine>,
    injector: Mutex<TextInjector>,
    mute: Mutex<SpeakerMute>,
    models_dir: PathBuf,
    model_reload_required: Mutex<bool>,
    model_loading: Mutex<bool>,
}

struct ConnectedSender {
    id: Uuid,
    sender: UnboundedSender<ServerEvent>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ModelLoadState {
    Ready,
    Loading,
}

enum ModelLoadTaskResult {
    Loaded(ModelRuntimeInfo),
    Stale,
}

impl SharedState {
    pub fn new(config: SidecarConfig, models_dir: PathBuf) -> Result<Self> {
        let audio = AudioController::new(config.audio_device_index)
            .context("failed to initialize audio controller")?;
        let engine = Engine::new(config.clone()).context("failed to initialize STT engine")?;
        let mut injector = TextInjector::new().context("failed to initialize text injector")?;
        injector.set_options(config.add_trailing_space, config.add_trailing_newline);
        let mute =
            SpeakerMute::new(config.mute_speakers).context("failed to initialize speaker mute")?;

        let inner = Arc::new(StateInner {
            config: Mutex::new(config),
            status: Mutex::new(SidecarStatus::Idle),
            connection: Mutex::new(None),
            audio: Mutex::new(audio),
            engine: Mutex::new(engine),
            injector: Mutex::new(injector),
            mute: Mutex::new(mute),
            models_dir,
            model_reload_required: Mutex::new(false),
            model_loading: Mutex::new(false),
        });

        let weak_inner: Weak<StateInner> = Arc::downgrade(&inner);
        inner.audio.lock().set_level_callback(move |level| {
            if let Some(inner) = weak_inner.upgrade() {
                let level = (level.clamp(0.0, 1.0) * 1000.0).round() / 1000.0;
                send_event_to_inner(
                    &inner,
                    ServerEvent::new(ServerEventKind::AudioLevel { level }, None),
                );
            }
        });

        Ok(Self { inner })
    }

    pub fn connect(&self, sender: UnboundedSender<ServerEvent>) -> Uuid {
        let id = Uuid::new_v4();
        *self.inner.connection.lock() = Some(ConnectedSender { id, sender });

        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let state = self.clone();
            handle.spawn(async move {
                state.start_model_loading_if_needed();
            });
        }

        id
    }

    pub fn disconnect(&self, id: Uuid) {
        let disconnected = {
            let mut connection = self.inner.connection.lock();
            if connection
                .as_ref()
                .is_some_and(|connected| connected.id == id)
            {
                *connection = None;
                true
            } else {
                false
            }
        };
        if disconnected && self.status() == SidecarStatus::Recording {
            let _ = self.cancel_audio_capture();
            *self.inner.status.lock() = SidecarStatus::Idle;
        }
    }

    pub fn config(&self) -> SidecarConfig {
        self.inner.config.lock().clone()
    }

    pub fn status(&self) -> SidecarStatus {
        self.inner.status.lock().clone()
    }

    pub fn send_event(&self, event: ServerEvent) {
        send_event_to_inner(&self.inner, event);
    }

    pub fn send_status(
        &self,
        status: SidecarStatus,
        message: impl Into<String>,
        correlation_id: Option<String>,
    ) {
        *self.inner.status.lock() = status.clone();
        self.send_event(ServerEvent::new(
            ServerEventKind::Status {
                status,
                message: message.into(),
            },
            correlation_id,
        ));
    }

    pub fn send_error(
        &self,
        message: impl Into<String>,
        code: impl Into<String>,
        fatal: bool,
        recoverable: Option<bool>,
        correlation_id: Option<String>,
    ) {
        if fatal {
            *self.inner.status.lock() = SidecarStatus::Error;
        }

        self.send_event(ServerEvent::new(
            ServerEventKind::Error {
                message: message.into(),
                code: code.into(),
                recoverable: recoverable.unwrap_or(!fatal),
                fatal,
            },
            correlation_id,
        ));
    }

    pub fn send_model_download_progress(&self, payload: ModelDownloadProgressPayload) {
        self.send_event(ServerEvent::new(
            ServerEventKind::ModelDownloadProgress { payload },
            None,
        ));
    }

    pub fn send_model_runtime_info(&self, info: ModelRuntimeInfo) {
        self.send_event(ServerEvent::new(
            ServerEventKind::ModelRuntimeInfo {
                effective_device: info.effective_device,
                model_id: info.model_id,
            },
            None,
        ));
    }

    fn start_model_loading_if_needed(&self) -> ModelLoadState {
        if self.config().model_id.is_empty() {
            return ModelLoadState::Ready;
        }
        let reload_required = *self.inner.model_reload_required.lock();
        if !reload_required && self.inner.engine.lock().is_loaded() {
            return ModelLoadState::Ready;
        }

        {
            let mut model_loading = self.inner.model_loading.lock();
            if *model_loading {
                return ModelLoadState::Loading;
            }
            *model_loading = true;
        }

        *self.inner.model_reload_required.lock() = false;
        let requested_config = self.config();
        self.send_status(SidecarStatus::Loading, "Loading speech model", None);

        let state = self.clone();
        task::spawn(async move {
            state.load_model_task(requested_config).await;
        });

        ModelLoadState::Loading
    }

    async fn load_model_task(&self, requested_config: SidecarConfig) {
        match self.load_model_for_config(requested_config).await {
            Ok(ModelLoadTaskResult::Loaded(info)) => {
                *self.inner.model_loading.lock() = false;
                *self.inner.model_reload_required.lock() = false;
                self.send_model_runtime_info(info);
                self.send_status(SidecarStatus::Idle, "", None);
            }
            Ok(ModelLoadTaskResult::Stale) => {
                *self.inner.model_loading.lock() = false;
                self.start_model_loading_if_needed();
            }
            Err(err) => {
                error!(error = %err, "model_load_failed");
                *self.inner.model_loading.lock() = false;
                self.send_status(SidecarStatus::Error, "Failed to load speech model", None);
                self.send_error(
                    format!("Failed to load speech model: {err}"),
                    "model_load_failed",
                    false,
                    Some(true),
                    None,
                );
            }
        }
    }

    async fn load_model_for_config(
        &self,
        requested_config: SidecarConfig,
    ) -> Result<ModelLoadTaskResult> {
        let progress_state = self.clone();
        let progress_config = requested_config.clone();
        let models_dir = self.inner.models_dir.clone();
        let model_file = model::ensure_model_file(&requested_config, &models_dir, move |payload| {
            progress_state.send_model_download_progress(model_progress_with_config(
                payload,
                &progress_config,
            ));
        })
        .await
        .context("failed to prepare Whisper model file")?;

        if model_file_config_changed(&requested_config, &self.config()) {
            return Ok(ModelLoadTaskResult::Stale);
        }

        let load_state = self.clone();
        let progress_config = requested_config.clone();
        let runtime_info = task::spawn_blocking(move || {
            let progress_state = load_state.clone();
            let mut engine = load_state.inner.engine.lock();
            let runtime_info = engine.load(model_file, |payload| {
                progress_state.send_model_download_progress(model_progress_with_config(
                    payload,
                    &progress_config,
                ));
            })?;
            Ok::<ModelRuntimeInfo, anyhow::Error>(runtime_info)
        })
        .await
        .context("model load task failed")??;

        if model_file_config_changed(&requested_config, &self.config()) {
            self.inner.engine.lock().unload();
            return Ok(ModelLoadTaskResult::Stale);
        }

        Ok(ModelLoadTaskResult::Loaded(runtime_info))
    }

    pub async fn handle_get_status(&self, correlation_id: Option<String>) {
        self.send_status(self.status(), "", correlation_id);
    }

    pub async fn handle_get_devices(&self, correlation_id: Option<String>) {
        match AudioController::list_devices() {
            Ok(devices) => self.send_devices(devices, correlation_id),
            Err(err) => {
                error!(error = %err, "device_enumeration_failed");
                self.send_error(
                    format!("Failed to list devices: {err}"),
                    "device_error",
                    false,
                    Some(true),
                    correlation_id,
                );
            }
        }
    }

    pub async fn handle_set_config(
        &self,
        patch: SidecarConfigPatch,
        correlation_id: Option<String>,
    ) {
        let current = self.config();
        let (next, changed) = current.apply_patch(patch);

        if !changed.is_empty() {
            *self.inner.config.lock() = next.clone();
        }

        if changed.iter().any(|key| key == "audio_device_index") {
            self.inner
                .audio
                .lock()
                .set_device_index(next.audio_device_index);
        }
        if changed.iter().any(|key| key == "mute_speakers") {
            self.inner.mute.lock().set_enabled(next.mute_speakers);
        }
        if changed
            .iter()
            .any(|key| key == "add_trailing_space" || key == "add_trailing_newline")
        {
            self.inner
                .injector
                .lock()
                .set_options(next.add_trailing_space, next.add_trailing_newline);
        }

        if let Err(err) = self.inner.engine.lock().apply_config(next.clone()) {
            self.send_error(
                format!("Invalid engine configuration: {err}"),
                "invalid_config",
                false,
                Some(true),
                correlation_id,
            );
            return;
        }

        let model_keys_changed = changed
            .iter()
            .any(|key| matches!(key.as_str(), "model_id" | "device"));
        if model_keys_changed {
            if matches!(
                self.status(),
                SidecarStatus::Recording | SidecarStatus::Processing | SidecarStatus::Loading
            ) {
                *self.inner.model_reload_required.lock() = true;
            } else if !next.model_id.is_empty() {
                self.start_model_loading_if_needed();
            }
        }

        for key in &changed {
            info!(key, "config_key_updated");
        }

        self.send_event(ServerEvent::new(
            ServerEventKind::ConfigUpdated { changed },
            correlation_id,
        ));
    }

    pub async fn handle_start_recording(&self, correlation_id: Option<String>) {
        match self.status() {
            SidecarStatus::Recording => {
                warn!("start_recording_ignored_already_recording");
                return;
            }
            SidecarStatus::Processing => {
                warn!("start_recording_ignored_processing");
                return;
            }
            _ => {}
        }
        if self.config().model_id.is_empty() {
            self.send_error(
                "Select a voice model before recording.",
                "model_not_loaded",
                false,
                Some(true),
                correlation_id,
            );
            return;
        }

        let reload_required = *self.inner.model_reload_required.lock();
        if self.start_model_loading_if_needed() == ModelLoadState::Loading {
            if reload_required {
                self.send_error(
                    "Model settings changed. Reloading model now. Please try again in a moment.",
                    "model_reloading",
                    false,
                    Some(true),
                    correlation_id,
                );
            } else {
                self.send_error(
                    "STT model is loading. Please try again in a moment.",
                    "model_loading",
                    false,
                    Some(true),
                    correlation_id,
                );
            }
            return;
        }

        if let Err(err) = self.start_audio_capture() {
            error!(error = %err, "recording_start_failed");
            let _ = self.inner.mute.lock().force_unmute();
            self.send_error(
                format!("Failed to start recording: {err}"),
                "recording_error",
                true,
                Some(false),
                correlation_id,
            );
            self.send_status(SidecarStatus::Idle, "", None);
            return;
        }

        self.send_status(SidecarStatus::Recording, "", correlation_id);
        info!("recording_started");
    }

    pub async fn handle_stop_recording(&self, correlation_id: Option<String>) {
        if self.status() != SidecarStatus::Recording {
            warn!(status = self.status().as_str(), "stop_recording_ignored");
            return;
        }

        let samples = match self.stop_audio_capture() {
            Ok(samples) => samples,
            Err(err) => {
                error!(error = %err, "recording_stop_failed");
                let _ = self.inner.mute.lock().force_unmute();
                self.send_error(
                    format!("Processing failed: {err}"),
                    "processing_error",
                    true,
                    Some(false),
                    correlation_id,
                );
                self.send_status(SidecarStatus::Idle, "", None);
                return;
            }
        };

        if samples.frame_count() < MIN_AUDIO_SAMPLES {
            debug!(
                sample_count = samples.samples.len(),
                frames = samples.frame_count(),
                sample_rate = samples.sample_rate,
                channels = samples.channels,
                "recording_empty_audio"
            );
            self.send_status(SidecarStatus::Idle, "", correlation_id);
            return;
        }

        self.send_status(SidecarStatus::Processing, "", None);

        let processing_state = self.clone();
        match task::spawn_blocking(move || processing_state.transcribe_and_inject(&samples)).await {
            Ok(Ok(result)) => self.send_transcription_result(result, correlation_id),
            Ok(Err(err)) => {
                error!(error = %err, "recording_processing_failed");
                self.send_error(
                    format!("Processing failed: {err}"),
                    "processing_error",
                    true,
                    Some(false),
                    correlation_id,
                );
            }
            Err(err) => {
                error!(error = %err, "recording_processing_task_failed");
                self.send_error(
                    format!("Processing failed: {err}"),
                    "processing_error",
                    true,
                    Some(false),
                    correlation_id,
                );
            }
        }

        self.send_status(SidecarStatus::Idle, "", None);
    }

    pub async fn handle_cancel_recording(&self, correlation_id: Option<String>) {
        if self.status() != SidecarStatus::Recording {
            warn!(status = self.status().as_str(), "cancel_recording_ignored");
            return;
        }

        if let Err(err) = self.cancel_audio_capture() {
            error!(error = %err, "recording_cancel_failed");
            let _ = self.inner.mute.lock().force_unmute();
        }

        self.send_status(SidecarStatus::Idle, "", correlation_id);
        info!("recording_cancelled");
    }

    fn send_devices(&self, devices: Vec<AudioDeviceInfo>, correlation_id: Option<String>) {
        self.send_event(ServerEvent::new(
            ServerEventKind::Devices { devices },
            correlation_id,
        ));
    }

    fn start_audio_capture(&self) -> Result<()> {
        if self.inner.mute.lock().enabled() {
            self.inner
                .mute
                .lock()
                .mute()
                .context("failed to mute speakers")?;
        }
        self.inner
            .audio
            .lock()
            .start_recording()
            .context("failed to start audio capture")
    }

    fn stop_audio_capture(&self) -> Result<CapturedAudio> {
        let samples = self
            .inner
            .audio
            .lock()
            .stop_recording()
            .context("failed to stop audio capture");
        let unmute = self
            .inner
            .mute
            .lock()
            .unmute()
            .context("failed to unmute speakers");

        let samples = samples?;
        unmute?;
        Ok(samples)
    }

    fn cancel_audio_capture(&self) -> Result<()> {
        let cancel = self
            .inner
            .audio
            .lock()
            .cancel_recording()
            .context("failed to cancel audio capture");
        let unmute = self
            .inner
            .mute
            .lock()
            .unmute()
            .context("failed to unmute speakers");

        cancel?;
        unmute?;
        Ok(())
    }

    fn transcribe_and_inject(&self, audio: &CapturedAudio) -> Result<TranscriptionPayload> {
        let result = self
            .inner
            .engine
            .lock()
            .transcribe_with_format(&audio.samples, audio.sample_rate, audio.channels)
            .context("failed to transcribe audio")?;

        if !result.text.is_empty() {
            self.inner
                .injector
                .lock()
                .inject_text_fast(&result.text)
                .context("failed to inject transcription")?;
        }

        Ok(result)
    }

    fn send_transcription_result(
        &self,
        result: TranscriptionPayload,
        correlation_id: Option<String>,
    ) {
        self.send_event(ServerEvent::new(
            ServerEventKind::Transcription { payload: result },
            correlation_id,
        ));
    }
}

fn send_event_to_inner(inner: &StateInner, event: ServerEvent) {
    let sender = inner
        .connection
        .lock()
        .as_ref()
        .map(|connected| connected.sender.clone());

    if let Some(sender) = sender {
        if sender.send(event).is_err() {
            warn!("ws_event_send_failed");
        }
    }
}

fn model_file_config_changed(left: &SidecarConfig, right: &SidecarConfig) -> bool {
    left.model_id != right.model_id || left.device != right.device
}

fn model_progress_with_config(
    mut payload: ModelDownloadProgressPayload,
    config: &SidecarConfig,
) -> ModelDownloadProgressPayload {
    if payload.model_id.is_empty() {
        payload.model_id = config.model_id.clone();
    }
    if payload.requested_device.is_empty() {
        payload.requested_device = config.device.clone();
    }
    payload
}

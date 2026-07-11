use serde::{Deserialize, Serialize};

pub const SIDECAR_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SidecarStatus {
    Idle,
    Loading,
    Recording,
    Processing,
    Error,
}

impl SidecarStatus {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Loading => "loading",
            Self::Recording => "recording",
            Self::Processing => "processing",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SidecarConfig {
    pub model_id: String,
    pub device: String,
    pub language: Option<String>,
    pub beam_size: usize,
    pub audio_device_index: Option<usize>,
    pub mute_speakers: bool,
    pub add_trailing_space: bool,
    pub add_trailing_newline: bool,
    pub initial_prompt: String,
}

impl Default for SidecarConfig {
    fn default() -> Self {
        Self {
            model_id: String::new(),
            device: "auto".to_owned(),
            language: None,
            beam_size: 1,
            audio_device_index: None,
            mute_speakers: true,
            add_trailing_space: true,
            add_trailing_newline: false,
            initial_prompt: "한국어와 English가 섞인 대화. Technical terms like API, GPU, CLI, git, terminal을 자주 사용합니다.".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct SidecarConfigPatch {
    #[serde(default)]
    pub model_id: Patch<String>,
    #[serde(default)]
    pub device: Patch<String>,
    #[serde(default)]
    pub language: Patch<Option<String>>,
    #[serde(default)]
    pub beam_size: Patch<usize>,
    #[serde(default)]
    pub audio_device_index: Patch<Option<usize>>,
    #[serde(default)]
    pub mute_speakers: Patch<bool>,
    #[serde(default)]
    pub add_trailing_space: Patch<bool>,
    #[serde(default)]
    pub add_trailing_newline: Patch<bool>,
    #[serde(default)]
    pub initial_prompt: Patch<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Patch<T> {
    Missing,
    Value(T),
}
impl<T> Default for Patch<T> {
    fn default() -> Self {
        Self::Missing
    }
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        T::deserialize(deserializer).map(Self::Value)
    }
}

impl SidecarConfig {
    pub fn apply_patch(&self, patch: SidecarConfigPatch) -> (Self, Vec<String>) {
        let mut next = self.clone();
        let mut changed = Vec::new();
        apply_if_changed(&mut next.model_id, patch.model_id, "model_id", &mut changed);
        apply_if_changed(&mut next.device, patch.device, "device", &mut changed);
        apply_if_changed(&mut next.language, patch.language, "language", &mut changed);
        apply_if_changed(
            &mut next.beam_size,
            patch.beam_size,
            "beam_size",
            &mut changed,
        );
        apply_if_changed(
            &mut next.audio_device_index,
            patch.audio_device_index,
            "audio_device_index",
            &mut changed,
        );
        apply_if_changed(
            &mut next.mute_speakers,
            patch.mute_speakers,
            "mute_speakers",
            &mut changed,
        );
        apply_if_changed(
            &mut next.add_trailing_space,
            patch.add_trailing_space,
            "add_trailing_space",
            &mut changed,
        );
        apply_if_changed(
            &mut next.add_trailing_newline,
            patch.add_trailing_newline,
            "add_trailing_newline",
            &mut changed,
        );
        apply_if_changed(
            &mut next.initial_prompt,
            patch.initial_prompt,
            "initial_prompt",
            &mut changed,
        );
        (next, changed)
    }
}

fn apply_if_changed<T: PartialEq>(
    target: &mut T,
    value: Patch<T>,
    name: &'static str,
    changed: &mut Vec<String>,
) {
    if let Patch::Value(value) = value {
        if *target != value {
            *target = value;
            changed.push(name.to_owned());
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct ClientEnvelope {
    #[serde(rename = "_correlationId")]
    pub correlation_id: Option<String>,
    #[serde(flatten)]
    pub command: ClientCommand,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientCommand {
    Ping,
    GetStatus,
    GetDevices,
    SetConfig { config: SidecarConfigPatch },
    StartRecording,
    StopRecording,
    CancelRecording,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct AudioDeviceInfo {
    pub index: usize,
    pub name: String,
    pub channels: u16,
    pub sample_rate: f64,
    pub is_default: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct TranscriptionPayload {
    pub text: String,
    pub language: String,
    pub audio_duration: f64,
    pub processing_time: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelDownloadStage {
    Preparing,
    DownloadStart,
    Downloading,
    DownloadComplete,
    Initializing,
    Ready,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ModelDownloadProgressPayload {
    pub stage: ModelDownloadStage,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub file_name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub requested_device: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub effective_device: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ModelRuntimeInfo {
    pub effective_device: String,
    pub model_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ServerEvent {
    #[serde(rename = "_correlationId", skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(flatten)]
    pub event: ServerEventKind,
}

impl ServerEvent {
    pub fn new(event: ServerEventKind, correlation_id: Option<String>) -> Self {
        Self {
            correlation_id,
            event,
        }
    }
    pub fn ready() -> Self {
        Self::new(
            ServerEventKind::Ready {
                version: SIDECAR_VERSION.to_owned(),
            },
            None,
        )
    }
    pub fn pong(correlation_id: Option<String>) -> Self {
        Self::new(ServerEventKind::Pong, correlation_id)
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEventKind {
    Pong,
    Ready {
        version: String,
    },
    Status {
        status: SidecarStatus,
        #[serde(skip_serializing_if = "String::is_empty")]
        message: String,
    },
    Error {
        message: String,
        code: String,
        recoverable: bool,
        fatal: bool,
    },
    Transcription {
        #[serde(flatten)]
        payload: TranscriptionPayload,
    },
    AudioLevel {
        level: f32,
    },
    Devices {
        devices: Vec<AudioDeviceInfo>,
    },
    ConfigUpdated {
        changed: Vec<String>,
    },
    ModelDownloadProgress {
        #[serde(flatten)]
        payload: ModelDownloadProgressPayload,
    },
    ModelRuntimeInfo {
        effective_device: String,
        model_id: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_config_is_safe_and_local() {
        let config = SidecarConfig::default();
        assert!(config.model_id.is_empty());
        assert_eq!(config.device, "auto");
        assert!(config.add_trailing_space);
        assert!(!config.add_trailing_newline);
    }
}

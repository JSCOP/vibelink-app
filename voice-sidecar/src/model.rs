use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use reqwest::Client;
use tokio::io::AsyncWriteExt;

use crate::protocol::{ModelDownloadProgressPayload, ModelDownloadStage, SidecarConfig};

const HF_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelFile {
    pub path: PathBuf,
    pub file_name: String,
    pub model_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelSpec {
    pub model_id: &'static str,
    pub file_name: &'static str,
    pub expected_bytes: u64,
}

pub fn resolve_model_spec(model_id: &str) -> Result<ModelSpec> {
    let spec = match model_id.trim() {
        "tiny-q8_0" => ModelSpec {
            model_id: "tiny-q8_0",
            file_name: "ggml-tiny-q8_0.bin",
            expected_bytes: 43_537_433,
        },
        "base-q8_0" => ModelSpec {
            model_id: "base-q8_0",
            file_name: "ggml-base-q8_0.bin",
            expected_bytes: 81_768_585,
        },
        "small-q8_0" => ModelSpec {
            model_id: "small-q8_0",
            file_name: "ggml-small-q8_0.bin",
            expected_bytes: 264_464_607,
        },
        "medium-q8_0" => ModelSpec {
            model_id: "medium-q8_0",
            file_name: "ggml-medium-q8_0.bin",
            expected_bytes: 823_369_779,
        },
        "large-v3-turbo-q5_0" => ModelSpec {
            model_id: "large-v3-turbo-q5_0",
            file_name: "ggml-large-v3-turbo-q5_0.bin",
            expected_bytes: 574_041_195,
        },
        "large-v3-turbo-q8_0" => ModelSpec {
            model_id: "large-v3-turbo-q8_0",
            file_name: "ggml-large-v3-turbo-q8_0.bin",
            expected_bytes: 874_188_075,
        },
        "large-v3-q5_0" => ModelSpec {
            model_id: "large-v3-q5_0",
            file_name: "ggml-large-v3-q5_0.bin",
            expected_bytes: 1_081_140_203,
        },
        other => bail!("unsupported voice model '{other}'"),
    };
    Ok(spec)
}

pub async fn ensure_model_file<F>(
    config: &SidecarConfig,
    models_dir: &Path,
    mut progress: F,
) -> Result<ModelFile>
where
    F: FnMut(ModelDownloadProgressPayload),
{
    let spec = resolve_model_spec(&config.model_id)?;
    tokio::fs::create_dir_all(models_dir)
        .await
        .with_context(|| {
            format!(
                "failed to create model directory '{}'",
                models_dir.display()
            )
        })?;
    let target_path = models_dir.join(spec.file_name);
    progress(payload(
        &spec,
        ModelDownloadStage::Preparing,
        "Preparing Whisper model",
        Some(0),
        Some(0),
    ));

    if validate_file(&target_path, spec.expected_bytes)
        .await
        .is_ok()
    {
        return Ok(model_file(&spec, target_path));
    }
    if target_path.exists() {
        let _ = tokio::fs::remove_file(&target_path).await;
    }

    download_model_file(&spec, &target_path, &mut progress).await?;
    validate_file(&target_path, spec.expected_bytes)
        .await
        .with_context(|| {
            format!(
                "downloaded model '{}' failed validation",
                target_path.display()
            )
        })?;
    Ok(model_file(&spec, target_path))
}

fn model_file(spec: &ModelSpec, path: PathBuf) -> ModelFile {
    ModelFile {
        path,
        file_name: spec.file_name.to_owned(),
        model_id: spec.model_id.to_owned(),
    }
}

async fn download_model_file<F>(
    spec: &ModelSpec,
    target_path: &Path,
    progress: &mut F,
) -> Result<()>
where
    F: FnMut(ModelDownloadProgressPayload),
{
    let temp_path =
        target_path.with_file_name(format!("{}.tmp-{}", spec.file_name, std::process::id()));
    if temp_path.exists() {
        let _ = tokio::fs::remove_file(&temp_path).await;
    }
    let result = download_to_temp(spec, &temp_path, progress).await;
    if let Err(err) = result {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(err);
    }
    if target_path.exists() {
        let _ = tokio::fs::remove_file(target_path).await;
    }
    tokio::fs::rename(&temp_path, target_path)
        .await
        .with_context(|| {
            format!(
                "failed to move '{}' to '{}'",
                temp_path.display(),
                target_path.display()
            )
        })?;
    progress(payload(
        spec,
        ModelDownloadStage::DownloadComplete,
        "Whisper model download complete",
        Some(100),
        Some(spec.expected_bytes),
    ));
    Ok(())
}

async fn download_to_temp<F>(spec: &ModelSpec, temp_path: &Path, progress: &mut F) -> Result<()>
where
    F: FnMut(ModelDownloadProgressPayload),
{
    let url = format!("{HF_BASE_URL}/{}?download=true", spec.file_name);
    let client = Client::builder()
        .user_agent("VibeLink/voice-sidecar")
        .build()?;
    let mut response = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("failed to start download from {url}"))?
        .error_for_status()?;
    progress(payload(
        spec,
        ModelDownloadStage::DownloadStart,
        "Downloading Whisper model",
        Some(0),
        Some(0),
    ));
    let mut file = tokio::fs::File::create(temp_path).await?;
    let mut downloaded = 0_u64;
    let mut last_percent = 0_u8;
    while let Some(chunk) = response.chunk().await? {
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        let percent = ((downloaded.saturating_mul(100) / spec.expected_bytes).min(99)) as u8;
        if percent > last_percent {
            last_percent = percent;
            progress(payload(
                spec,
                ModelDownloadStage::Downloading,
                "Downloading Whisper model",
                Some(percent),
                Some(downloaded),
            ));
        }
    }
    file.flush().await?;
    drop(file);
    validate_file(temp_path, spec.expected_bytes).await
}

async fn validate_file(path: &Path, expected_bytes: u64) -> Result<()> {
    let metadata = tokio::fs::metadata(path).await?;
    if !metadata.is_file() {
        bail!("model path is not a file");
    }
    if metadata.len() != expected_bytes {
        bail!(
            "model size mismatch: expected {expected_bytes}, got {}",
            metadata.len()
        );
    }
    Ok(())
}

fn payload(
    spec: &ModelSpec,
    stage: ModelDownloadStage,
    message: &str,
    percent: Option<u8>,
    downloaded_bytes: Option<u64>,
) -> ModelDownloadProgressPayload {
    ModelDownloadProgressPayload {
        stage,
        message: message.to_owned(),
        percent,
        downloaded_bytes,
        total_bytes: Some(spec.expected_bytes),
        file_name: spec.file_name.to_owned(),
        model_id: spec.model_id.to_owned(),
        requested_device: String::new(),
        effective_device: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_curated_catalog() {
        assert_eq!(
            resolve_model_spec("large-v3-q5_0").unwrap().expected_bytes,
            1_081_140_203
        );
        assert!(resolve_model_spec("unsupported").is_err());
    }
}

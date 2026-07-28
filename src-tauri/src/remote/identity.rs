use crate::storage::write_bytes;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, PKCS_ECDSA_P256_SHA256};
use rustls::{
    pki_types::{CertificateDer, PrivateKeyDer},
    ServerConfig,
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, BufReader, Cursor},
    path::{Path, PathBuf},
    sync::Arc,
};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

const RE_PAIR_MARKER: &str = "identity-re-pair-required";

pub struct RemoteIdentity {
    cert_path: PathBuf,
    key_path: PathBuf,
    repair_marker_path: PathBuf,
    cert_der: CertificateDer<'static>,
    key_der: PrivateKeyDer<'static>,
    generated_on_load: bool,
    device_reset_required: bool,
}

impl RemoteIdentity {
    pub fn load_or_generate(directory: &Path) -> Result<Self> {
        fs::create_dir_all(directory)?;
        let cert_path = directory.join("cert.pem");
        let key_path = directory.join("key.pem");
        let repair_marker_path = directory.join(RE_PAIR_MARKER);
        let cert_exists = cert_path.exists();
        let key_exists = key_path.exists();

        if cert_exists && key_exists {
            if let Ok((cert_der, key_der)) = load_identity_material(&cert_path, &key_path) {
                return Ok(Self {
                    cert_path,
                    key_path,
                    device_reset_required: repair_marker_path.exists(),
                    repair_marker_path,
                    cert_der,
                    key_der,
                    generated_on_load: false,
                });
            }
            mark_re_pair_required(&repair_marker_path)?;
            quarantine_identity_files(&cert_path, &key_path)?;
            generate_identity(&cert_path, &key_path)?;
            return Self::load_generated(cert_path, key_path, repair_marker_path, true);
        }

        if cert_exists || key_exists {
            mark_re_pair_required(&repair_marker_path)?;
            quarantine_identity_files(&cert_path, &key_path)?;
            generate_identity(&cert_path, &key_path)?;
            return Self::load_generated(cert_path, key_path, repair_marker_path, true);
        }

        generate_identity(&cert_path, &key_path)?;
        Self::load_generated(
            cert_path,
            key_path,
            repair_marker_path.clone(),
            repair_marker_path.exists(),
        )
    }

    fn load_generated(
        cert_path: PathBuf,
        key_path: PathBuf,
        repair_marker_path: PathBuf,
        device_reset_required: bool,
    ) -> Result<Self> {
        let (cert_der, key_der) = load_identity_material(&cert_path, &key_path)?;
        Ok(Self {
            cert_path,
            key_path,
            repair_marker_path,
            cert_der,
            key_der,
            generated_on_load: true,
            device_reset_required,
        })
    }

    pub fn fingerprint(&self) -> String {
        STANDARD.encode(Sha256::digest(self.cert_der.as_ref()))
    }

    pub fn server_config(&self) -> Result<Arc<ServerConfig>> {
        Ok(Arc::new(build_server_config(
            &self.cert_der,
            &self.key_der,
        )?))
    }

    pub fn generated_on_load(&self) -> bool {
        self.generated_on_load
    }

    pub fn requires_device_reset(&self) -> bool {
        self.device_reset_required
    }

    pub fn mark_device_reset_required(&mut self) -> Result<()> {
        mark_re_pair_required(&self.repair_marker_path)?;
        self.device_reset_required = true;
        Ok(())
    }

    pub fn acknowledge_device_reset(&mut self) -> Result<()> {
        remove_if_present(&self.repair_marker_path)?;
        remove_if_present(&append_suffix(&self.repair_marker_path, ".bak"))?;
        self.device_reset_required = false;
        Ok(())
    }

    pub fn regenerate(&mut self) -> Result<()> {
        generate_identity(&self.cert_path, &self.key_path)?;
        let (cert_der, key_der) = load_identity_material(&self.cert_path, &self.key_path)?;
        self.cert_der = cert_der;
        self.key_der = key_der;
        self.generated_on_load = false;
        Ok(())
    }
}

#[cfg(test)]
pub fn verify_certificate_fingerprint(cert_der: &[u8], expected: &str) -> Result<()> {
    let actual = STANDARD.encode(Sha256::digest(cert_der));
    if expected.len() != actual.len()
        || expected
            .as_bytes()
            .iter()
            .zip(actual.as_bytes())
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            != 0
    {
        anyhow::bail!("remote-v2 TLS identity mismatch");
    }
    Ok(())
}

fn load_identity_material(
    cert_path: &Path,
    key_path: &Path,
) -> Result<(CertificateDer<'static>, PrivateKeyDer<'static>)> {
    let cert_bytes =
        fs::read(cert_path).with_context(|| format!("read {}", cert_path.display()))?;
    let key_bytes = fs::read(key_path).with_context(|| format!("read {}", key_path.display()))?;
    let cert_der = rustls_pemfile::certs(&mut BufReader::new(Cursor::new(cert_bytes)))
        .next()
        .transpose()
        .context("parse remote certificate PEM")?
        .ok_or_else(|| anyhow!("remote certificate PEM contains no certificate"))?;
    let key_der = rustls_pemfile::private_key(&mut BufReader::new(Cursor::new(key_bytes)))
        .context("parse remote private key PEM")?
        .ok_or_else(|| anyhow!("remote key PEM contains no private key"))?;
    build_server_config(&cert_der, &key_der)
        .context("validate remote certificate and private key pair")?;
    Ok((cert_der, key_der))
}

fn build_server_config(
    cert_der: &CertificateDer<'static>,
    key_der: &PrivateKeyDer<'static>,
) -> Result<ServerConfig> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert_der.clone()], key_der.clone_key())?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

fn generate_identity(cert_path: &Path, key_path: &Path) -> Result<()> {
    let mut params = CertificateParams::new(Vec::<String>::new())?;
    let mut distinguished_name = DistinguishedName::new();
    distinguished_name.push(DnType::CommonName, "VibeLink Remote");
    params.distinguished_name = distinguished_name;
    let now = OffsetDateTime::now_utc();
    params.not_before = now - Duration::days(1);
    params.not_after = now + Duration::days(3650);
    let key_pair = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?;
    let certificate = params.self_signed(&key_pair)?;
    write_bytes(cert_path, certificate.pem().as_bytes())?;
    write_bytes(key_path, key_pair.serialize_pem().as_bytes())?;
    Ok(())
}

fn mark_re_pair_required(path: &Path) -> Result<()> {
    if !path.exists() {
        write_bytes(path, b"remote identity changed")?;
    }
    Ok(())
}

fn quarantine_identity_files(cert_path: &Path, key_path: &Path) -> Result<()> {
    let suffix = format!(
        ".corrupt-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        Uuid::new_v4()
    );
    for path in [cert_path, key_path] {
        if path.exists() {
            let quarantine = append_suffix(path, &suffix);
            fs::rename(path, &quarantine).with_context(|| {
                format!(
                    "quarantine invalid remote identity file {} as {}",
                    path.display(),
                    quarantine.display()
                )
            })?;
        }
    }
    Ok(())
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn remove_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove {}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "vibelink-remote-identity-{label}-{}",
            Uuid::new_v4()
        ))
    }

    fn quarantine_count(directory: &Path, name: &str) -> usize {
        fs::read_dir(directory)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(&format!("{name}.corrupt-"))
            })
            .count()
    }

    #[test]
    fn normal_first_run_and_restart_preserve_fingerprint() {
        let directory = directory("stable");
        let identity = RemoteIdentity::load_or_generate(&directory).unwrap();
        let first = identity.fingerprint();
        assert!(identity.generated_on_load());
        assert!(!identity.requires_device_reset());

        let persisted = RemoteIdentity::load_or_generate(&directory).unwrap();
        assert_eq!(persisted.fingerprint(), first);
        assert!(!persisted.generated_on_load());
        assert!(!persisted.requires_device_reset());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn one_sided_identity_quarantines_present_file_and_requires_re_pair() {
        let directory = directory("one-sided");
        let first = RemoteIdentity::load_or_generate(&directory)
            .unwrap()
            .fingerprint();
        fs::remove_file(directory.join("key.pem")).unwrap();

        let recovered = RemoteIdentity::load_or_generate(&directory).unwrap();
        assert_ne!(recovered.fingerprint(), first);
        assert!(recovered.requires_device_reset());
        assert_eq!(quarantine_count(&directory, "cert.pem"), 1);
        assert_eq!(quarantine_count(&directory, "key.pem"), 0);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn mismatched_certificate_and_key_quarantine_both_and_regenerate() {
        let target_directory = directory("mismatch");
        let other_directory = directory("mismatch-source");
        let first = RemoteIdentity::load_or_generate(&target_directory)
            .unwrap()
            .fingerprint();
        let _ = RemoteIdentity::load_or_generate(&other_directory).unwrap();
        fs::copy(
            other_directory.join("key.pem"),
            target_directory.join("key.pem"),
        )
        .unwrap();

        let recovered = RemoteIdentity::load_or_generate(&target_directory).unwrap();
        assert_ne!(recovered.fingerprint(), first);
        assert!(recovered.requires_device_reset());
        assert_eq!(quarantine_count(&target_directory, "cert.pem"), 1);
        assert_eq!(quarantine_count(&target_directory, "key.pem"), 1);
        let _ = fs::remove_dir_all(target_directory);
        let _ = fs::remove_dir_all(other_directory);
    }

    #[test]
    fn malformed_private_key_is_never_included_in_identity_error() {
        let directory = directory("secret-error");
        let _ = RemoteIdentity::load_or_generate(&directory).unwrap();
        let sentinel = "PRIVATE-KEY-CONTENT-MUST-NOT-LEAK";
        fs::write(directory.join("key.pem"), sentinel).unwrap();

        let error =
            match load_identity_material(&directory.join("cert.pem"), &directory.join("key.pem")) {
                Ok(_) => panic!("malformed private key unexpectedly loaded"),
                Err(error) => error.to_string(),
            };
        assert!(!error.contains(sentinel));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn certificate_pin_rejects_wrong_tls_identity() {
        let certificate = b"certificate-der";
        let expected = STANDARD.encode(Sha256::digest(certificate));
        verify_certificate_fingerprint(certificate, &expected).unwrap();
        assert!(verify_certificate_fingerprint(b"different-certificate", &expected).is_err());
    }
}

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
    io::{BufReader, Cursor},
    path::{Path, PathBuf},
    sync::Arc,
};
use time::{Duration, OffsetDateTime};

pub struct RemoteIdentity {
    cert_path: PathBuf,
    key_path: PathBuf,
    cert_der: CertificateDer<'static>,
    key_der: PrivateKeyDer<'static>,
}

impl RemoteIdentity {
    pub fn load_or_generate(directory: &Path) -> Result<Self> {
        fs::create_dir_all(directory)?;
        let cert_path = directory.join("cert.pem");
        let key_path = directory.join("key.pem");
        if !cert_path.exists() || !key_path.exists() {
            generate_identity(&cert_path, &key_path)?;
        }
        Self::load(cert_path, key_path)
    }

    fn load(cert_path: PathBuf, key_path: PathBuf) -> Result<Self> {
        let cert_bytes =
            fs::read(&cert_path).with_context(|| format!("read {}", cert_path.display()))?;
        let key_bytes =
            fs::read(&key_path).with_context(|| format!("read {}", key_path.display()))?;
        let cert_der = rustls_pemfile::certs(&mut BufReader::new(Cursor::new(cert_bytes)))
            .next()
            .transpose()?
            .ok_or_else(|| anyhow!("remote certificate PEM contains no certificate"))?;
        let key_der = rustls_pemfile::private_key(&mut BufReader::new(Cursor::new(key_bytes)))?
            .ok_or_else(|| anyhow!("remote key PEM contains no private key"))?;
        Ok(Self {
            cert_path,
            key_path,
            cert_der,
            key_der,
        })
    }

    pub fn fingerprint(&self) -> String {
        STANDARD.encode(Sha256::digest(self.cert_der.as_ref()))
    }

    pub fn server_config(&self) -> Result<Arc<ServerConfig>> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![self.cert_der.clone()], self.key_der.clone_key())?;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Arc::new(config))
    }

    pub fn regenerate(&mut self) -> Result<()> {
        generate_identity(&self.cert_path, &self.key_path)?;
        *self = Self::load(self.cert_path.clone(), self.key_path.clone())?;
        Ok(())
    }
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
    fs::write(cert_path, certificate.pem())?;
    fs::write(key_path, key_pair.serialize_pem())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn identity_persists_fingerprint_and_regeneration_changes_it() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-remote-identity-{}", Uuid::new_v4()));
        let mut identity = RemoteIdentity::load_or_generate(&directory).unwrap();
        let first = identity.fingerprint();
        assert_eq!(
            RemoteIdentity::load_or_generate(&directory)
                .unwrap()
                .fingerprint(),
            first
        );
        identity.regenerate().unwrap();
        assert_ne!(identity.fingerprint(), first);
        let _ = fs::remove_dir_all(directory);
    }
}

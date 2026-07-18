use super::{
    authorization::{AuthorizationSnapshot, Capability},
    license::{LicenseService, LicenseStatusDto},
};
use anyhow::{anyhow, Result};
use chrono::Utc;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, RwLock,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const AUTHORIZATION_CHANGED_EVENT: &str = "authorization://changed";
const REVALIDATE_INTERVAL: Duration = Duration::from_secs(5 * 60);

pub struct EntitlementSupervisor {
    license: Arc<LicenseService>,
    snapshot: RwLock<AuthorizationSnapshot>,
    policy_epoch: AtomicU64,
    app: AppHandle,
}

impl EntitlementSupervisor {
    pub fn new(license: Arc<LicenseService>, app: AppHandle) -> Result<Arc<Self>> {
        let initial_epoch = 1;
        let snapshot = license.authorization_snapshot(initial_epoch)?;
        Ok(Arc::new(Self {
            license,
            snapshot: RwLock::new(snapshot),
            policy_epoch: AtomicU64::new(initial_epoch),
            app,
        }))
    }

    pub fn start_background(self: &Arc<Self>) {
        let supervisor = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                let refresh = Arc::clone(&supervisor);
                match tauri::async_runtime::spawn_blocking(move || refresh.refresh_now()).await {
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => tracing::warn!(?error, "entitlement revalidation failed"),
                    Err(error) => tracing::warn!(?error, "entitlement revalidation task failed"),
                }
                tokio::time::sleep(REVALIDATE_INTERVAL).await;
            }
        });
    }

    pub fn service(&self) -> Arc<LicenseService> {
        Arc::clone(&self.license)
    }

    pub fn snapshot(&self) -> Result<AuthorizationSnapshot> {
        self.snapshot
            .read()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| anyhow!("authorization snapshot poisoned"))
    }

    pub fn authorize(&self, capability: Capability) -> Result<()> {
        self.snapshot()?
            .authorize(capability, Utc::now())
            .map_err(|denied| anyhow!(denied.code.as_str()))
    }

    pub fn refresh_now(&self) -> Result<LicenseStatusDto> {
        let status = self.license.revalidate()?;
        self.license.persist_observed_now()?;
        self.publish_status(status.clone())?;
        Ok(status)
    }

    pub fn sync_cached(&self) -> Result<LicenseStatusDto> {
        let status = self.license.status()?;
        self.publish_status(status.clone())?;
        Ok(status)
    }

    pub fn publish_status(&self, status: LicenseStatusDto) -> Result<AuthorizationSnapshot> {
        let epoch = self.policy_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let snapshot = self.license.authorization_snapshot_for_status(status, epoch)?;
        *self
            .snapshot
            .write()
            .map_err(|_| anyhow!("authorization snapshot poisoned"))? = snapshot.clone();
        let _ = self.app.emit(AUTHORIZATION_CHANGED_EVENT, &snapshot);
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revalidation_interval_is_five_minutes() {
        assert_eq!(REVALIDATE_INTERVAL, Duration::from_secs(300));
    }
}

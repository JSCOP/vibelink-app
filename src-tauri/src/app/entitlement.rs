use super::{
    authorization::{AuthorizationSnapshot, Capability},
    license::{LicenseService, LicenseStatusDto},
};
use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use rand::Rng;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, RwLock,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const AUTHORIZATION_CHANGED_EVENT: &str = "authorization://changed";
const REVALIDATE_BASE_SECONDS: u64 = 60;
const REVALIDATE_JITTER_SECONDS: u64 = 10;
const MINIMUM_WAKE_DELAY: Duration = Duration::from_millis(10);

fn next_revalidation_delay() -> Duration {
    Duration::from_secs(rand::thread_rng().gen_range(
        (REVALIDATE_BASE_SECONDS - REVALIDATE_JITTER_SECONDS)
            ..=(REVALIDATE_BASE_SECONDS + REVALIDATE_JITTER_SECONDS),
    ))
}

pub type AuthorizationObserver = Arc<dyn Fn(AuthorizationSnapshot) + Send + Sync>;

struct AuthorizationClock {
    anchor: DateTime<Utc>,
    monotonic: Instant,
}

pub struct EntitlementSupervisor {
    license: Arc<LicenseService>,
    snapshot: RwLock<AuthorizationSnapshot>,
    policy_epoch: AtomicU64,
    observers: RwLock<Vec<AuthorizationObserver>>,
    app: AppHandle,
    clock: RwLock<AuthorizationClock>,
}

impl EntitlementSupervisor {
    pub fn new(license: Arc<LicenseService>, app: AppHandle) -> Result<Arc<Self>> {
        let initial_epoch = 1;
        let snapshot = license.authorization_snapshot(initial_epoch)?;
        Ok(Arc::new(Self {
            license,
            snapshot: RwLock::new(snapshot),
            policy_epoch: AtomicU64::new(initial_epoch),
            observers: RwLock::new(Vec::new()),
            app,
            clock: RwLock::new(AuthorizationClock {
                anchor: Utc::now(),
                monotonic: Instant::now(),
            }),
        }))
    }

    pub fn start_background(self: &Arc<Self>) {
        let supervisor = Arc::clone(self);
        std::thread::Builder::new()
            .name("vibelink-entitlement".to_string())
            .spawn(move || loop {
                if let Err(error) = supervisor.refresh_now() {
                    tracing::warn!(?error, "entitlement revalidation failed");
                }
                std::thread::sleep(supervisor.next_wake_delay());
            })
            .expect("spawn entitlement supervisor");
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

    pub fn subscribe(&self, observer: AuthorizationObserver) -> Result<()> {
        self.observers
            .write()
            .map_err(|_| anyhow!("authorization observers poisoned"))?
            .push(Arc::clone(&observer));
        observer(self.snapshot()?);
        Ok(())
    }

    pub fn authorize(&self, capability: Capability) -> Result<()> {
        self.snapshot()?
            .authorize(capability, self.effective_now()?)
            .map_err(|denied| anyhow!(denied.code.as_str()))
    }

    pub fn refresh_now(&self) -> Result<LicenseStatusDto> {
        let status = self.license.revalidate()?;
        self.license.persist_observed_now()?;
        self.publish_status(status.clone())?;
        Ok(status)
    }

    pub fn publish_status(&self, status: LicenseStatusDto) -> Result<AuthorizationSnapshot> {
        self.advance_clock()?;
        let current = self.snapshot()?;
        let mut snapshot = self
            .license
            .authorization_snapshot_for_status(status, current.policy_epoch)?;
        let changed = snapshot.state != current.state
            || snapshot.entitled != current.entitled
            || snapshot.lease_until != current.lease_until
            || snapshot.offline_grace_until != current.offline_grace_until;
        if changed {
            snapshot.policy_epoch = self.policy_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        }
        *self
            .snapshot
            .write()
            .map_err(|_| anyhow!("authorization snapshot poisoned"))? = snapshot.clone();
        let _ = self.app.emit(AUTHORIZATION_CHANGED_EVENT, &snapshot);
        let observers = self
            .observers
            .read()
            .map_err(|_| anyhow!("authorization observers poisoned"))?
            .clone();
        for observer in observers {
            observer(snapshot.clone());
        }
        Ok(snapshot)
    }

    fn effective_now(&self) -> Result<DateTime<Utc>> {
        let clock = self
            .clock
            .read()
            .map_err(|_| anyhow!("authorization clock poisoned"))?;
        let elapsed =
            chrono::Duration::from_std(clock.monotonic.elapsed()).unwrap_or(chrono::Duration::MAX);
        Ok((clock.anchor + elapsed).max(Utc::now()))
    }

    fn advance_clock(&self) -> Result<()> {
        let effective_now = self.effective_now()?;
        let wall_now = Utc::now();
        if wall_now > effective_now {
            *self
                .clock
                .write()
                .map_err(|_| anyhow!("authorization clock poisoned"))? = AuthorizationClock {
                anchor: wall_now,
                monotonic: Instant::now(),
            };
        }
        Ok(())
    }

    fn next_wake_delay(&self) -> Duration {
        let jittered = next_revalidation_delay();
        let Ok(snapshot) = self.snapshot() else {
            return jittered;
        };
        let Ok(now) = self.effective_now() else {
            return jittered;
        };
        let Ok(until_lease) = (snapshot.lease_until - now).to_std() else {
            return MINIMUM_WAKE_DELAY;
        };
        jittered.min(until_lease.max(MINIMUM_WAKE_DELAY))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revalidation_interval_stays_within_sixty_second_jitter() {
        for _ in 0..256 {
            let delay = next_revalidation_delay();
            assert!(delay >= Duration::from_secs(50));
            assert!(delay <= Duration::from_secs(70));
        }
    }
}

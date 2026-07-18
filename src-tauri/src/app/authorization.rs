use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthorizationState {
    Trial,
    TrialExpired,
    ValidOnline,
    Unlicensed,
    ConfigurationError,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationSnapshot {
    pub state: AuthorizationState,
    pub plan: Option<String>,
    pub entitled: bool,
    pub observed_at: DateTime<Utc>,
    pub lease_until: DateTime<Utc>,
    pub policy_epoch: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Capability {
    PaneCreate,
    PaneInput,
    PaneResume,
    TaskStart,
    ToolInvoke,
    ConfigMutate,
    SkillMutate,
    RemoteStart,
    RemotePair,
    RemoteWrite,
    AccountStatus,
    AccountSignIn,
    PurchaseOpen,
    DaemonShutdown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthorizationErrorCode {
    EntitlementRequired,
    AuthorizationStale,
}

impl AuthorizationErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::EntitlementRequired => "ENTITLEMENT_REQUIRED",
            Self::AuthorizationStale => "AUTHORIZATION_STALE",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthorizationDenied {
    pub code: AuthorizationErrorCode,
}

impl AuthorizationSnapshot {
    pub fn authorize(
        &self,
        capability: Capability,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationDenied> {
        if matches!(
            capability,
            Capability::AccountStatus
                | Capability::AccountSignIn
                | Capability::PurchaseOpen
                | Capability::DaemonShutdown
        ) {
            return Ok(());
        }
        if !self.entitled {
            return Err(AuthorizationDenied {
                code: AuthorizationErrorCode::EntitlementRequired,
            });
        }
        if now > self.lease_until {
            return Err(AuthorizationDenied {
                code: AuthorizationErrorCode::AuthorizationStale,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    const ENTITLED_CAPABILITIES: [Capability; 11] = [
        Capability::PaneCreate,
        Capability::PaneInput,
        Capability::PaneResume,
        Capability::TaskStart,
        Capability::ToolInvoke,
        Capability::ConfigMutate,
        Capability::SkillMutate,
        Capability::RemoteStart,
        Capability::RemotePair,
        Capability::RemoteWrite,
        Capability::AccountStatus,
    ];

    fn snapshot(entitled: bool, lease_until: DateTime<Utc>) -> AuthorizationSnapshot {
        AuthorizationSnapshot {
            state: if entitled {
                AuthorizationState::ValidOnline
            } else {
                AuthorizationState::TrialExpired
            },
            plan: Some(if entitled { "pro" } else { "none" }.to_string()),
            entitled,
            observed_at: lease_until - Duration::hours(1),
            lease_until,
            policy_epoch: 4,
        }
    }

    #[test]
    fn entitled_capabilities_require_an_active_lease() {
        let now = Utc::now();
        let active = snapshot(true, now + Duration::minutes(1));
        for capability in ENTITLED_CAPABILITIES {
            assert_eq!(active.authorize(capability, now), Ok(()), "{capability:?}");
        }
    }

    #[test]
    fn unentitled_snapshot_fails_closed_with_stable_code() {
        let now = Utc::now();
        let locked = snapshot(false, now);
        for capability in ENTITLED_CAPABILITIES.into_iter().filter(|capability| {
            !matches!(capability, Capability::AccountStatus)
        }) {
            assert_eq!(
                locked.authorize(capability, now),
                Err(AuthorizationDenied {
                    code: AuthorizationErrorCode::EntitlementRequired,
                }),
                "{capability:?}"
            );
        }
        assert_eq!(AuthorizationErrorCode::EntitlementRequired.as_str(), "ENTITLEMENT_REQUIRED");
    }

    #[test]
    fn stale_snapshot_fails_closed_with_stable_code() {
        let now = Utc::now();
        let stale = snapshot(true, now - Duration::milliseconds(1));
        assert_eq!(
            stale.authorize(Capability::PaneInput, now),
            Err(AuthorizationDenied {
                code: AuthorizationErrorCode::AuthorizationStale,
            })
        );
        assert_eq!(AuthorizationErrorCode::AuthorizationStale.as_str(), "AUTHORIZATION_STALE");
    }

    #[test]
    fn account_recovery_and_authenticated_shutdown_stay_available() {
        let now = Utc::now();
        let locked = snapshot(false, now - Duration::days(1));
        for capability in [
            Capability::AccountStatus,
            Capability::AccountSignIn,
            Capability::PurchaseOpen,
            Capability::DaemonShutdown,
        ] {
            assert_eq!(locked.authorize(capability, now), Ok(()), "{capability:?}");
        }
    }
}

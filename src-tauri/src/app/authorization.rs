use crate::protocol::{AuthorizationLease, AuthorizationStateWire};
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
    pub entitled: bool,
    pub observed_at: DateTime<Utc>,
    pub lease_until: DateTime<Utc>,
    pub offline_grace_until: Option<DateTime<Utc>>,
    pub policy_epoch: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Capability {
    AccountStatus,
    AccountSignIn,
    PurchaseOpen,
    DaemonShutdown,
    WorkspaceRead,
    WorkspaceMutate,
    TerminalRead,
    TerminalWrite,
    McpCall,
    CliControl,
    RemoteConnect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthorizationErrorCode {
    AuthRequired,
    EntitlementRequired,
    AuthorizationStale,
    DaemonProtocolMismatch,
}

impl AuthorizationErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AuthRequired => "AUTH_REQUIRED",
            Self::EntitlementRequired => "ENTITLEMENT_REQUIRED",
            Self::AuthorizationStale => "AUTHORIZATION_STALE",
            Self::DaemonProtocolMismatch => "DAEMON_PROTOCOL_MISMATCH",
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

impl From<AuthorizationSnapshot> for AuthorizationLease {
    fn from(snapshot: AuthorizationSnapshot) -> Self {
        Self {
            state: match snapshot.state {
                AuthorizationState::Trial => AuthorizationStateWire::Trial,
                AuthorizationState::TrialExpired => AuthorizationStateWire::TrialExpired,
                AuthorizationState::ValidOnline => AuthorizationStateWire::ValidOnline,
                AuthorizationState::Unlicensed => AuthorizationStateWire::Unlicensed,
                AuthorizationState::ConfigurationError => {
                    AuthorizationStateWire::ConfigurationError
                }
            },
            entitled: snapshot.entitled,
            observed_at: snapshot.observed_at,
            lease_until: snapshot.lease_until,
            offline_grace_until: snapshot.offline_grace_until,
            policy_epoch: snapshot.policy_epoch,
        }
    }
}

impl From<AuthorizationLease> for AuthorizationSnapshot {
    fn from(snapshot: AuthorizationLease) -> Self {
        Self {
            state: match snapshot.state {
                AuthorizationStateWire::Trial => AuthorizationState::Trial,
                AuthorizationStateWire::TrialExpired => AuthorizationState::TrialExpired,
                AuthorizationStateWire::ValidOnline => AuthorizationState::ValidOnline,
                AuthorizationStateWire::Unlicensed => AuthorizationState::Unlicensed,
                AuthorizationStateWire::ConfigurationError => {
                    AuthorizationState::ConfigurationError
                }
            },
            entitled: snapshot.entitled,
            observed_at: snapshot.observed_at,
            lease_until: snapshot.lease_until,
            offline_grace_until: snapshot.offline_grace_until,
            policy_epoch: snapshot.policy_epoch,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    const ENTITLED_CAPABILITIES: [Capability; 7] = [
        Capability::WorkspaceRead,
        Capability::WorkspaceMutate,
        Capability::TerminalRead,
        Capability::TerminalWrite,
        Capability::McpCall,
        Capability::CliControl,
        Capability::RemoteConnect,
    ];

    fn snapshot(entitled: bool, lease_until: DateTime<Utc>) -> AuthorizationSnapshot {
        AuthorizationSnapshot {
            state: if entitled {
                AuthorizationState::ValidOnline
            } else {
                AuthorizationState::TrialExpired
            },
            entitled,
            observed_at: lease_until - Duration::hours(1),
            lease_until,
            offline_grace_until: Some(lease_until),
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
        for capability in ENTITLED_CAPABILITIES {
            assert_eq!(
                locked.authorize(capability, now),
                Err(AuthorizationDenied {
                    code: AuthorizationErrorCode::EntitlementRequired,
                }),
                "{capability:?}"
            );
        }
        assert_eq!(
            AuthorizationErrorCode::EntitlementRequired.as_str(),
            "ENTITLEMENT_REQUIRED"
        );
    }

    #[test]
    fn stale_snapshot_fails_closed_with_stable_code() {
        let now = Utc::now();
        let stale = snapshot(true, now - Duration::milliseconds(1));
        assert_eq!(
            stale.authorize(Capability::TerminalWrite, now),
            Err(AuthorizationDenied {
                code: AuthorizationErrorCode::AuthorizationStale,
            })
        );
        assert_eq!(
            AuthorizationErrorCode::AuthorizationStale.as_str(),
            "AUTHORIZATION_STALE"
        );
        assert_eq!(
            AuthorizationErrorCode::AuthRequired.as_str(),
            "AUTH_REQUIRED"
        );
        assert_eq!(
            AuthorizationErrorCode::DaemonProtocolMismatch.as_str(),
            "DAEMON_PROTOCOL_MISMATCH"
        );
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

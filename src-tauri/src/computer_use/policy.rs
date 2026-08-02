use super::types::{AppIdentity, ElementRecord, ProviderError, ProviderErrorCode, REDACTED_VALUE};
use std::collections::BTreeSet;

const DEFAULT_BLOCKED_EXECUTABLES: &[&str] = &[
    "1password.exe",
    "authy.exe",
    "bitwarden.exe",
    "credentialuibroker.exe",
    "dashlane.exe",
    "keepass.exe",
    "keepassxc.exe",
    "lastpass.exe",
    "logonui.exe",
    "nordpass.exe",
    "protonpass.exe",
    "securityhealthhost.exe",
    "windowssecurity.exe",
];

const DEFAULT_BLOCKED_TITLES: &[&str] = &[
    "user account control",
    "windows security",
    "windows sign-in",
    "[release - protected host]",
];

const DEFAULT_BLOCKED_EXACT_TITLES: &[&str] = &["vibelink"];

const SECRET_PHRASES: &[&str] = &[
    "one-time code",
    "one time code",
    "verification code",
    "security code",
    "recovery code",
    "authenticator code",
];

const SECRET_WORDS: &[&str] = &["otp", "pin", "password", "passcode", "secret", "token"];

#[derive(Clone, Debug)]
pub struct SensitiveAppPolicy {
    blocked_executables: BTreeSet<String>,
    blocked_exact_titles: BTreeSet<String>,
    blocked_title_fragments: BTreeSet<String>,
}

impl Default for SensitiveAppPolicy {
    fn default() -> Self {
        Self {
            blocked_executables: DEFAULT_BLOCKED_EXECUTABLES
                .iter()
                .map(|value| value.to_string())
                .collect(),
            blocked_exact_titles: DEFAULT_BLOCKED_EXACT_TITLES
                .iter()
                .map(|value| value.to_string())
                .collect(),
            blocked_title_fragments: DEFAULT_BLOCKED_TITLES
                .iter()
                .map(|value| value.to_string())
                .collect(),
        }
    }
}

impl SensitiveAppPolicy {
    pub fn with_blocked_executables<I, S>(mut self, names: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.blocked_executables.extend(
            names
                .into_iter()
                .map(|name| normalize_executable_name(name.as_ref())),
        );
        self
    }

    pub fn with_blocked_exact_titles<I, S>(mut self, titles: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.blocked_exact_titles.extend(
            titles
                .into_iter()
                .map(|title| title.as_ref().trim().to_ascii_lowercase()),
        );
        self
    }

    pub fn with_blocked_title_fragments<I, S>(mut self, titles: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.blocked_title_fragments.extend(
            titles
                .into_iter()
                .map(|title| title.as_ref().trim().to_ascii_lowercase()),
        );
        self
    }

    pub fn is_app_blocked(&self, app: &AppIdentity, window_title: Option<&str>) -> bool {
        let executable = normalize_executable_name(&app.executable_name);
        if self.blocked_executables.contains(&executable) {
            return true;
        }
        let title = window_title.unwrap_or_default().trim().to_ascii_lowercase();
        self.blocked_exact_titles.contains(&title)
            || self
                .blocked_title_fragments
                .iter()
                .any(|fragment| !fragment.is_empty() && title.contains(fragment))
    }

    pub fn require_allowed(
        &self,
        app: &AppIdentity,
        window_title: Option<&str>,
    ) -> Result<(), ProviderError> {
        if self.is_app_blocked(app, window_title) {
            return Err(ProviderError::new(
                ProviderErrorCode::AppBlocked,
                "computer use is blocked for this sensitive application",
            )
            .with_detail("processId", app.process_id.to_string())
            .with_detail(
                "executable",
                normalize_executable_name(&app.executable_name),
            ));
        }
        Ok(())
    }
}

pub fn redact_element(element: &mut ElementRecord) {
    let secret =
        element.password || is_secret_label(&element.name) || is_secret_label(&element.role);
    if secret {
        if element.value.is_some() {
            element.value = Some(REDACTED_VALUE.to_string());
        }
        element.password = true;
        element.redacted = true;
    }
}

pub fn redact_selected_text(selected_text: &mut Option<String>, focused: Option<&ElementRecord>) {
    if focused.is_some_and(|element| element.password || element.redacted) {
        if selected_text.is_some() {
            *selected_text = Some(REDACTED_VALUE.to_string());
        }
    }
}

pub fn is_secret_label(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    if SECRET_PHRASES
        .iter()
        .any(|phrase| normalized.contains(phrase))
    {
        return true;
    }
    normalized
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .any(|word| SECRET_WORDS.contains(&word))
}

fn normalize_executable_name(value: &str) -> String {
    value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(value)
        .trim()
        .to_ascii_lowercase()
}

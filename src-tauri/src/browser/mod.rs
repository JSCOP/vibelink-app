mod error;
mod grab_script;
mod manager;
mod policy;
mod provider;
mod types;

pub use error::{BrowserError, BrowserErrorCode, BrowserResult};
pub use manager::{BrowserManager, LatestFrameQueue};
pub use policy::BrowserPolicy;
#[cfg(windows)]
pub use provider::NativeBrowserProvider;
pub use provider::{BrowserProvider, UnsupportedBrowserProvider};

/// The `BrowserProvider` this build drives child pages with.
///
/// Windows owns the only native implementation, which hosts WebView2 child controls on the
/// application's HWND. Targets without that runtime resolve to `UnsupportedBrowserProvider`,
/// so browser methods answer a structured `BrowserError` instead of failing to compile or
/// panicking at runtime.
#[cfg(windows)]
pub type PlatformBrowserProvider = NativeBrowserProvider;
#[cfg(not(windows))]
pub type PlatformBrowserProvider = UnsupportedBrowserProvider;
pub use types::*;

use url::Url;

const RELEASE_LICENSE_ORIGIN: &str = "https://vibelink.moobang.net";

fn main() {
    let configured = std::env::var("VIBELINK_LICENSE_API_URL").ok();
    let raw = configured.as_deref().unwrap_or_else(|| {
        if cfg!(debug_assertions) {
            "http://localhost:3000"
        } else {
            panic!("VIBELINK_LICENSE_API_URL is required for release builds")
        }
    });
    let url = Url::parse(raw).expect("VIBELINK_LICENSE_API_URL must be an absolute URL");
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (url.path() != "/" && !url.path().is_empty())
    {
        panic!("VIBELINK_LICENSE_API_URL must be an origin without credentials, path, query, or fragment");
    }
    if !cfg!(debug_assertions) && url.scheme() != "https" {
        panic!("VIBELINK_LICENSE_API_URL must use HTTPS for release builds");
    }
    if !cfg!(debug_assertions) && url.origin().ascii_serialization() != RELEASE_LICENSE_ORIGIN {
        panic!("VIBELINK_LICENSE_API_URL must be https://vibelink.moobang.net for release builds");
    }
    if url.scheme() != "http" && url.scheme() != "https" {
        panic!("VIBELINK_LICENSE_API_URL must use HTTP(S)");
    }
    println!("cargo:rerun-if-env-changed=VIBELINK_LICENSE_API_URL");
    println!("cargo:rustc-env=VIBELINK_LICENSE_API_URL={}", url.origin().ascii_serialization());
    tauri_build::build()
}

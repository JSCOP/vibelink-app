use super::*;

fn temp_root(prefix: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("vibelink-{prefix}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create temp root");
    root
}

fn write_cache(root: &Path, skill: &str, body: &str) {
    let path = cache_path(root, skill);
    fs::create_dir_all(path.parent().expect("cache parent")).expect("create cache dir");
    fs::write(&path, body).expect("write cache");
}

fn valid_doc(name: &str) -> String {
    format!("---\nname: {name}\ndescription: test\n---\n\n# Body\n")
}

#[test]
fn a_valid_published_document_is_accepted() {
    assert!(validate("vibelink-memory", &valid_doc("vibelink-memory")).is_ok());
}

#[test]
fn a_document_naming_a_different_skill_is_rejected() {
    // The path said one skill and the document says another: writing this into
    // an agent home would silently swap the instructions for that capability.
    let error = validate("vibelink-browser", &valid_doc("vibelink-memory"))
        .expect_err("mismatched name must be refused");
    assert!(error.to_string().contains("declares a different name"));
}

#[test]
fn a_redirect_to_html_is_rejected_instead_of_being_installed() {
    let error = validate("vibelink-memory", "<!DOCTYPE html><title>404</title>")
        .expect_err("html must be refused");
    assert!(error.to_string().contains("no frontmatter"));
}

#[test]
fn an_unterminated_frontmatter_block_is_rejected() {
    let error = validate("vibelink-memory", "---\nname: vibelink-memory\nstill going")
        .expect_err("unterminated frontmatter must be refused");
    assert!(error.to_string().contains("unterminated"));
}

#[test]
fn cached_returns_nothing_when_the_cache_holds_a_corrupt_document() {
    let root = temp_root("skill-remote-corrupt");
    write_cache(&root, "vibelink-memory", "not a skill at all");
    // A corrupt cache must read as absent so the caller falls back to the
    // bundled copy rather than installing garbage.
    assert!(cached(&root, "vibelink-memory").is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn cached_returns_the_document_once_it_is_valid() {
    let root = temp_root("skill-remote-valid");
    let doc = valid_doc("vibelink-memory");
    write_cache(&root, "vibelink-memory", &doc);
    assert_eq!(
        cached(&root, "vibelink-memory").as_deref(),
        Some(doc.as_str())
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn a_fresh_cache_entry_is_not_refetched() {
    let root = temp_root("skill-remote-fresh");
    write_cache(&root, "vibelink-memory", &valid_doc("vibelink-memory"));
    // Freshly written, so `refresh` must short-circuit before any network use.
    // Offline CI would fail here if the TTL check were wrong.
    assert!(!refresh(&root, "vibelink-memory").expect("fresh cache short-circuits"));
    let _ = fs::remove_dir_all(root);
}
// Network behaviour is not unit-tested: standing up an HTTP server here would
// cost more than it proves. The offline guarantee that matters is structural —
// `refresh` returns `Result` and every caller ignores the error, and `cached`
// keeps returning the last good document — and it is covered above.

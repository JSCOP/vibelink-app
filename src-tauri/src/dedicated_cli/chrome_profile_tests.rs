use super::*;

fn temp_root() -> PathBuf {
    env::temp_dir().join(format!("vibelink-chrome-profile-{}", Uuid::new_v4()))
}

#[test]
fn managed_destination_validation_enforces_isolation() {
    let artifact_root = temp_root();
    let managed_root = artifact_root.join("chrome");
    let valid = managed_root.join("profiles").join("chrome-0123456789ab");
    let real_chrome_path = managed_root
        .join("profiles")
        .join("Google")
        .join("Chrome")
        .join("User Data")
        .join("copy");
    let parent_path = managed_root
        .join("profiles")
        .join("..")
        .join("chrome-0123456789ab");
    let outside = artifact_root.join("outside").join("chrome-0123456789ab");

    assert!(validate_user_data_dir(&managed_root, &valid).is_ok());
    assert!(validate_user_data_dir(&managed_root, &real_chrome_path).is_err());
    assert!(validate_user_data_dir(&managed_root, &parent_path).is_err());
    assert!(validate_user_data_dir(&managed_root, &outside).is_err());

    let _ = fs::remove_dir_all(artifact_root);
}

#[test]
fn cache_exclusion_is_case_insensitive_and_keeps_profile_data() {
    for skipped in [
        "Cache",
        "Code Cache",
        "GPUCache",
        "DawnCache",
        "DawnGraphiteCache",
        "DawnWebGPUCache",
        "GrShaderCache",
        "ShaderCache",
        "component_crx_cache",
        "extensions_crx_cache",
        "optimization_guide_model_store",
        "optimization_guide_prediction_model_downloads",
        "Crashpad",
        "blob_storage",
    ] {
        assert!(should_skip_directory(Path::new(skipped)), "{skipped}");
        assert!(
            should_skip_directory(Path::new(&skipped.to_ascii_uppercase())),
            "{}",
            skipped.to_ascii_uppercase()
        );
    }
    for kept in [
        "Cookies",
        "Login Data",
        "Local Storage",
        "Network",
        "Storage/ext",
        "Extension State",
    ] {
        assert!(!should_skip_directory(Path::new(kept)), "{kept}");
    }
}

#[test]
fn registry_round_trip_and_invalid_files_are_absent() {
    let artifact_root = temp_root();
    let managed_root = artifact_root.join("chrome");
    let registry_path = managed_root.join("registry.json");
    let record = ChromeProfileRecord {
        profile_id: "chrome-0123456789ab".to_string(),
        port: 19_400,
        user_data_dir: managed_root.join("profiles").join("chrome-0123456789ab"),
        source_directory: "Profile 20".to_string(),
        source_name: "Work".to_string(),
        copied_at_ms: 123,
    };
    let registry = ChromeRegistry {
        version: REGISTRY_VERSION,
        profiles: vec![record],
        pending_cleanup: Vec::new(),
    };

    write_registry(&registry_path, &managed_root, &registry).unwrap();
    let parsed = read_registry_path(&registry_path, &managed_root).unwrap();
    assert_eq!(parsed.version, REGISTRY_VERSION);
    assert_eq!(parsed.profiles.len(), 1);
    assert_eq!(parsed.profiles[0].profile_id, "chrome-0123456789ab");
    assert_eq!(parsed.profiles[0].source_directory, "Profile 20");
    assert_eq!(parsed.profiles[0].source_name, "Work");
    assert_eq!(parsed.profiles[0].port, 19_400);
    assert_eq!(parsed.profiles[0].copied_at_ms, 123);

    fs::write(
        &registry_path,
        serde_json::to_vec(&ChromeRegistry {
            version: REGISTRY_VERSION + 1,
            profiles: Vec::new(),
            pending_cleanup: Vec::new(),
        })
        .unwrap(),
    )
    .unwrap();
    assert!(read_registry_path(&registry_path, &managed_root).is_none());

    File::create(&registry_path)
        .unwrap()
        .set_len(MAX_REGISTRY_BYTES + 1)
        .unwrap();
    assert!(read_registry_path(&registry_path, &managed_root).is_none());

    let _ = fs::remove_dir_all(artifact_root);
}

#[test]
fn source_selection_prefers_directory_and_rejects_ambiguous_names() {
    let sources = vec![
        ChromeSource {
            directory: "Default".to_string(),
            name: "Profile 20".to_string(),
            last_used: false,
        },
        ChromeSource {
            directory: "Profile 20".to_string(),
            name: "Work".to_string(),
            last_used: true,
        },
        ChromeSource {
            directory: "Profile 1".to_string(),
            name: "Shared".to_string(),
            last_used: false,
        },
        ChromeSource {
            directory: "Profile 2".to_string(),
            name: "Shared".to_string(),
            last_used: false,
        },
    ];

    assert_eq!(select_source(&sources, None).unwrap().directory, "Profile 20");
    assert_eq!(
        select_source(&sources, Some("profile 20"))
            .unwrap()
            .directory,
        "Profile 20"
    );
    assert_eq!(select_source(&sources, Some("work")).unwrap().directory, "Profile 20");
    let error = select_source(&sources, Some("shared")).unwrap_err().to_string();
    assert!(error.contains("Profile 1"), "{error}");
    assert!(error.contains("Profile 2"), "{error}");
}

#[test]
fn refresh_does_not_delete_a_live_managed_profile() {
    let artifact_root = temp_root();
    let managed_root = artifact_root.join("chrome");
    let profile = managed_root.join("profiles").join("chrome-0123456789ab");
    fs::create_dir_all(&profile).unwrap();
    fs::write(profile.join("sentinel"), b"keep").unwrap();

    let error = remove_managed_copy_with(&managed_root, &profile, |_| {
        Err::<(), _>(anyhow!("managed Chrome process is still running"))
    })
        .unwrap_err()
        .to_string();
    assert!(error.contains("still running"), "{error}");
    assert!(profile.join("sentinel").is_file());

    let _ = fs::remove_dir_all(artifact_root);
}

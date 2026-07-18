pub(crate) mod auth;
pub(crate) mod detect;
pub(crate) mod github;
pub(crate) mod gitlab;

use crate::app::license::LicenseService;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostingInfo {
    pub provider: Option<String>,
    pub host: Option<String>,
    pub owner: Option<String>,
    pub repo: Option<String>,
    pub web_url: Option<String>,
    pub token_present: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePrRequest {
    pub title: String,
    pub body: String,
    pub source_branch: String,
    pub target_branch: String,
    pub draft: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub source_branch: String,
    pub target_branch: String,
    pub draft: bool,
    pub url: String,
    pub state: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCreated {
    pub number: u64,
    pub url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiCheck {
    pub name: String,
    pub state: String,
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiStatus {
    pub state: String,
    pub checks: Vec<CiCheck>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub author: String,
    pub source_branch: String,
    pub target_branch: String,
    pub draft: bool,
    pub url: String,
    pub state: String,
    pub checks: Vec<CiCheck>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub device_code_handle: String,
}

pub(crate) trait HostingClient {
    fn list_prs(&self) -> Result<Vec<PrInfo>>;
    fn create_pr(&self, request: &CreatePrRequest) -> Result<PrCreated>;
    fn pr_detail(&self, number: u64) -> Result<PrDetail>;
    fn ci_status(&self, ref_name: &str) -> Result<CiStatus>;
}

#[tauri::command]
pub async fn hosting_detect(license: State<'_, Arc<LicenseService>>, workspace_folder: String) -> Result<HostingInfo, String> {
    entitled_spawn(license, move || detect::detect_hosting(&workspace_folder)).await
}

#[tauri::command]
pub async fn hosting_token_set(license: State<'_, Arc<LicenseService>>, host: String, token: String) -> Result<(), String> {
    entitled_spawn(license, move || auth::set_token(&host, &token)).await
}

#[tauri::command]
pub async fn hosting_token_clear(license: State<'_, Arc<LicenseService>>, host: String) -> Result<(), String> {
    entitled_spawn(license, move || auth::clear_token(&host)).await
}

#[tauri::command]
pub async fn hosting_token_status(license: State<'_, Arc<LicenseService>>, host: String) -> Result<bool, String> {
    entitled_spawn(license, move || auth::token_status(&host)).await
}

#[tauri::command]
pub async fn hosting_provider_override(license: State<'_, Arc<LicenseService>>, host: String, provider: String) -> Result<(), String> {
    entitled_spawn(license, move || detect::set_provider_override(&host, &provider)).await
}

#[tauri::command]
pub async fn hosting_github_device_start(license: State<'_, Arc<LicenseService>>) -> Result<DeviceCodeInfo, String> {
    entitled_spawn(license, auth::github_device_start).await
}

#[tauri::command]
pub async fn hosting_github_device_poll(license: State<'_, Arc<LicenseService>>, handle: String) -> Result<bool, String> {
    entitled_spawn(license, move || auth::github_device_poll(&handle)).await
}

#[tauri::command]
pub async fn hosting_prs_list(license: State<'_, Arc<LicenseService>>, workspace_folder: String) -> Result<Vec<PrInfo>, String> {
    entitled_spawn(license, move || with_client(&workspace_folder, |client| client.list_prs())).await
}

#[tauri::command]
pub async fn hosting_pr_create(license: State<'_, Arc<LicenseService>>, workspace_folder: String, request: CreatePrRequest) -> Result<PrCreated, String> {
    entitled_spawn(license, move || {
        if request.title.trim().is_empty() || request.source_branch.trim().is_empty() || request.target_branch.trim().is_empty() {
            bail!("pull request title, source branch, and target branch are required");
        }
        with_client(&workspace_folder, |client| client.create_pr(&request))
    }).await
}

#[tauri::command]
pub async fn hosting_pr_detail(license: State<'_, Arc<LicenseService>>, workspace_folder: String, number: u64) -> Result<PrDetail, String> {
    entitled_spawn(license, move || with_client(&workspace_folder, |client| client.pr_detail(number))).await
}

#[tauri::command]
pub async fn hosting_ci_status(license: State<'_, Arc<LicenseService>>, workspace_folder: String, ref_name: String) -> Result<CiStatus, String> {
    entitled_spawn(license, move || {
        if ref_name.trim().is_empty() { bail!("CI reference must not be empty"); }
        with_client(&workspace_folder, |client| client.ci_status(&ref_name))
    }).await
}

fn with_client<T, F>(repo: &str, operation: F) -> Result<T>
where
    F: FnOnce(&dyn HostingClient) -> Result<T>,
{
    let info = detect::detect_hosting(repo)?;
    let provider = info.provider.context("no supported Git hosting provider detected")?;
    let host = info.host.context("Git hosting remote has no host")?;
    let owner = info.owner.context("Git hosting remote has no owner")?;
    let repository = info.repo.context("Git hosting remote has no repository")?;
    let token = auth::read_token(&host)?.ok_or_else(|| anyhow::anyhow!("AUTH: no token stored for {host}"))?;
    let client: Box<dyn HostingClient> = match provider.as_str() {
        "github" if host.eq_ignore_ascii_case("github.com") => Box::new(github::GithubClient::new(owner, repository, token)),
        "github" => Box::new(github::GithubClient::with_base_url(format!("https://{host}/api/v3"), owner, repository, token)),
        "gitlab" => Box::new(gitlab::GitlabClient::new(&host, owner, repository, token)),
        _ => bail!("unsupported Git hosting provider {provider}"),
    };
    operation(client.as_ref()).map_err(|error| anyhow::anyhow!(auth::redact_error(&host, &error.to_string())))
}

async fn entitled_spawn<T, F>(license: State<'_, Arc<LicenseService>>, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(operation).await.map_err(to_string)?.map_err(to_string)
}

fn to_string(error: impl std::fmt::Display) -> String { error.to_string() }

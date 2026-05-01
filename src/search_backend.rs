use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use serde::Deserialize;
use tokio::process::Command;

use crate::qmd_collection::mounted_source_names;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SearchMode {
    #[default]
    Hybrid,
    Fast,
    Semantic,
}

pub fn parse_mode(input: Option<&str>) -> Result<SearchMode> {
    match input {
        None => Ok(SearchMode::Hybrid),
        Some(s) => match s {
            "hybrid" => Ok(SearchMode::Hybrid),
            "fast" => Ok(SearchMode::Fast),
            "semantic" => Ok(SearchMode::Semantic),
            other => Err(anyhow!(
                "unknown search mode \"{other}\"; expected one of hybrid, fast, semantic"
            )),
        },
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchHit {
    pub path: String,
    pub score: f64,
    pub title: Option<String>,
    pub snippet: String,
    pub source: &'static str,
}

#[derive(Debug, Clone)]
pub struct SearchOptions<'a> {
    pub query: &'a str,
    pub mode: SearchMode,
    pub scope: Option<&'a str>,
    pub top_n: usize,
}

#[async_trait]
pub trait SearchBackend: Send + Sync {
    async fn search(&self, opts: &SearchOptions<'_>) -> Result<Vec<SearchHit>>;
    fn name(&self) -> &'static str;
}

const QMD_TOP_K: usize = 50;
const BRAIN_COLLECTION: &str = "brain";

pub struct QmdBackend {
    brain_home: PathBuf,
}

impl QmdBackend {
    pub fn new(brain_home: PathBuf) -> Self {
        Self { brain_home }
    }

    fn collection_filters(&self) -> Vec<String> {
        let mut names = vec![BRAIN_COLLECTION.to_string()];
        names.extend(mounted_source_names(&self.brain_home.join("sources")));
        names
    }
}

#[derive(Debug, Deserialize)]
struct QmdRawHit {
    #[serde(default)]
    score: Option<f64>,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    snippet: Option<String>,
}

/// Translate `qmd://<collection>/<path>` to a brain-relative path.
/// If the URI doesn't match the expected shape or the collection isn't `brain`,
/// return the raw value unchanged so the agent still sees something useful.
/// `qmd query --json` writes status lines (e.g. `Expanding query...`) to stdout
/// before the JSON array. Returns the trimmed JSON slice, or None if no array starts.
pub fn extract_qmd_json_array(stdout: &str) -> Option<&str> {
    let start = if stdout.trim_start().starts_with('[') {
        stdout.find('[')?
    } else {
        stdout.find("\n[").map(|i| i + 1)?
    };
    Some(stdout[start..].trim())
}

/// Translate a `qmd://<collection>/<path>` URI to a brain-relative path.
///   * `qmd://brain/projects/foo.md`        → `projects/foo.md`
///   * `qmd://gstack-projects/foo/bar.md`   → `sources/gstack-projects/foo/bar.md`
///     (when `gstack-projects` is in `known_sources`)
///   * Anything else → raw URI unchanged.
pub fn qmd_uri_to_path_with_sources(uri: &str, known_sources: &[String]) -> String {
    let Some(rest) = uri.strip_prefix("qmd://") else {
        return uri.to_string();
    };
    let Some((collection, path)) = rest.split_once('/') else {
        return uri.to_string();
    };
    if collection == BRAIN_COLLECTION {
        return path.to_string();
    }
    if known_sources.iter().any(|n| n == collection) {
        return format!("sources/{collection}/{path}");
    }
    uri.to_string()
}

pub fn qmd_uri_to_path(uri: &str) -> String {
    qmd_uri_to_path_with_sources(uri, &[])
}

#[async_trait]
impl SearchBackend for QmdBackend {
    async fn search(&self, opts: &SearchOptions<'_>) -> Result<Vec<SearchHit>> {
        if opts.query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let subcommand = match opts.mode {
            SearchMode::Hybrid => "query",
            SearchMode::Fast => "search",
            SearchMode::Semantic => "vsearch",
        };

        let collections = self.collection_filters();
        let mut cmd = Command::new("qmd");
        cmd.arg(subcommand);
        for c in &collections {
            cmd.arg("-c").arg(c);
        }
        cmd.arg("--json").arg(opts.query);
        let output = cmd
            .output()
            .await
            .with_context(|| format!("failed to spawn qmd {subcommand}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow!(
                "qmd {subcommand} exited with status {}: {}",
                output.status,
                stderr.trim()
            ));
        }

        let stdout = std::str::from_utf8(&output.stdout)
            .context("qmd stdout was not valid utf-8")?;
        if stdout.trim().is_empty() {
            return Ok(Vec::new());
        }

        let json_slice = extract_qmd_json_array(stdout)
            .ok_or_else(|| anyhow!("qmd {subcommand} stdout had no JSON array"))?;

        let raw: Vec<QmdRawHit> = serde_json::from_str(json_slice)
            .with_context(|| format!("failed to parse qmd {subcommand} JSON output"))?;

        let mut hits: Vec<SearchHit> = raw
            .into_iter()
            .take(QMD_TOP_K)
            .filter_map(|r| {
                let raw_path = r.file?;
                Some(SearchHit {
                    path: qmd_uri_to_path_with_sources(&raw_path, &collections),
                    score: r.score.unwrap_or(0.0),
                    title: r.title,
                    snippet: r.snippet.unwrap_or_default(),
                    source: "qmd",
                })
            })
            .collect();

        if let Some(scope) = opts.scope {
            hits.retain(|h| h.path.starts_with(scope));
        }
        hits.truncate(opts.top_n);
        Ok(hits)
    }

    fn name(&self) -> &'static str {
        "qmd"
    }
}

pub struct RipgrepBackend {
    brain_home: PathBuf,
}

impl RipgrepBackend {
    pub fn new(brain_home: PathBuf) -> Self {
        Self { brain_home }
    }
}

#[derive(Debug, Deserialize)]
struct RgEnvelope {
    #[serde(rename = "type")]
    kind: String,
    data: serde_json::Value,
}

#[async_trait]
impl SearchBackend for RipgrepBackend {
    async fn search(&self, opts: &SearchOptions<'_>) -> Result<Vec<SearchHit>> {
        if opts.query.trim().is_empty() {
            return Ok(Vec::new());
        }

        let mut cmd = Command::new("rg");
        cmd.arg("--json")
            .arg("--type")
            .arg("md")
            .arg(opts.query)
            .arg(&self.brain_home);

        let output = cmd
            .output()
            .await
            .context("failed to spawn rg (ripgrep)")?;

        // rg exit codes: 0 = matches, 1 = no matches, 2+ = error.
        if let Some(code) = output.status.code()
            && code > 1
        {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow!("rg failed (exit {code}): {}", stderr.trim()));
        }
        if output.stdout.is_empty() {
            return Ok(Vec::new());
        }

        let stdout = std::str::from_utf8(&output.stdout).context("rg stdout was not valid utf-8")?;

        let mut hits: Vec<SearchHit> = Vec::new();
        let canonical_home = self
            .brain_home
            .canonicalize()
            .unwrap_or_else(|_| self.brain_home.clone());
        for line in stdout.lines() {
            if line.is_empty() {
                continue;
            }
            let env: RgEnvelope = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if env.kind != "match" {
                continue;
            }
            let path_text = env
                .data
                .get("path")
                .and_then(|p| p.get("text"))
                .and_then(|t| t.as_str())
                .map(|s| s.to_string());
            let lines_text = env
                .data
                .get("lines")
                .and_then(|l| l.get("text"))
                .and_then(|t| t.as_str())
                .map(|s| s.trim_end_matches('\n').to_string())
                .unwrap_or_default();
            let Some(abs_path) = path_text else { continue };
            let abs = PathBuf::from(&abs_path);
            let relative = abs
                .strip_prefix(&canonical_home)
                .or_else(|_| abs.strip_prefix(&self.brain_home))
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or(abs_path);
            hits.push(SearchHit {
                path: relative,
                score: 0.0,
                title: None,
                snippet: lines_text,
                source: "ripgrep",
            });
        }

        if let Some(scope) = opts.scope {
            hits.retain(|h| h.path.starts_with(scope));
        }
        hits.truncate(opts.top_n);
        Ok(hits)
    }

    fn name(&self) -> &'static str {
        "ripgrep"
    }
}

pub fn pick_backend(brain_home: PathBuf) -> Box<dyn SearchBackend> {
    if which::which("qmd").is_ok() {
        Box::new(QmdBackend::new(brain_home))
    } else {
        Box::new(RipgrepBackend::new(brain_home))
    }
}

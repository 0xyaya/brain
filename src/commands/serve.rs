use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use rmcp::{
    ErrorData as McpError, ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars,
    tool, tool_handler, tool_router,
    transport::stdio,
};
use tokio_util::sync::CancellationToken;

use crate::brain::Brain;
use brainmd::remember::{RememberInput, remember_inner};
use brainmd::search_backend::{SearchOptions, parse_mode, pick_backend};
use brainmd::serve_lock::ServeLock;
use brainmd::watcher::spawn_watcher;
use brainmd::worker::{DrainOutcome, drain_one_pass, spawn_worker};

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct BrainContextArgs {
    /// Optional project name. When provided and projects/<project>.md exists, its content is included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct BrainReadArgs {
    /// Path relative to the brain home (e.g. "areas/user.md", "sources/gstack-projects/foo.md").
    /// Absolute paths are accepted but must resolve within the brain home.
    pub path: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct BrainSearchArgs {
    /// Search query string. Empty queries return no hits.
    pub query: String,
    /// Optional brain-relative path prefix to filter results (e.g. "projects" or "areas/user").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Search mode: "hybrid" (default), "fast" (BM25), or "semantic" (vectors). Ignored on ripgrep fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct BrainRememberArgs {
    /// PARA bucket: must be "projects", "areas", or "resources".
    /// "archive" is human-curated; "sources" is foreign territory; both are rejected.
    pub category: String,
    /// Markdown content to append. A metadata header is prepended automatically.
    pub content: String,
    /// Optional sub-key for the destination filename. Without it, writes to <category>/inbox.md.
    /// Example: category="projects", project="brain" writes to projects/brain.md.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Clone)]
pub struct BrainServer {
    brain: Arc<Brain>,
    // Read by the #[tool_router] / #[tool_handler] macros at runtime; flagged dead by the linter.
    #[allow(dead_code)]
    tool_router: ToolRouter<BrainServer>,
}

#[tool_router]
impl BrainServer {
    pub fn new(brain: Brain) -> Self {
        Self {
            brain: Arc::new(brain),
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        description = "Discover what's in the brain. Call with no args at session start to learn the folder layout, mounted sources, and the user's identity (areas/user.md). Pass `project` to also include the matching projects/<project>.md."
    )]
    async fn brain_context(
        &self,
        Parameters(args): Parameters<BrainContextArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut out = String::new();
        out.push_str(&format!("# Brain at {}\n\n", self.brain.home.display()));

        out.push_str("## Layout (pure PARA + sources)\n");
        out.push_str("- `projects/`  active work with deadlines\n");
        out.push_str("- `areas/`     ongoing responsibilities (areas/user.md is identity)\n");
        out.push_str("- `resources/` reference material\n");
        out.push_str("- `archive/`   inactive (human-curated; never written via brain_remember)\n");
        out.push_str("- `sources/`   read-only mounted external markdown\n\n");

        // user identity
        let user_md = self.brain.home.join("areas").join("user.md");
        if user_md.is_file() {
            out.push_str("## User identity (from areas/user.md)\n\n");
            match std::fs::read_to_string(&user_md) {
                Ok(s) => {
                    out.push_str(&s);
                    if !s.ends_with('\n') {
                        out.push('\n');
                    }
                }
                Err(e) => out.push_str(&format!("(error reading: {e})\n")),
            }
            out.push('\n');
        } else {
            out.push_str("## User identity\n_areas/user.md does not exist yet. Ask the user to write one._\n\n");
        }

        // Mounted sources
        out.push_str("## Mounted sources\n");
        let sources_dir = self.brain.sources_dir();
        let mut count = 0;
        if sources_dir.is_dir()
            && let Ok(entries) = std::fs::read_dir(&sources_dir)
        {
            let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let name = entry.file_name().to_string_lossy().into_owned();
                let path = entry.path();
                if let Ok(target) = std::fs::read_link(&path) {
                    let broken_marker = if path.exists() { "" } else { " **[broken]**" };
                    out.push_str(&format!("- `{}` → {}{}\n", name, target.display(), broken_marker));
                    count += 1;
                }
            }
        }
        if count == 0 {
            out.push_str("_(no sources mounted yet)_\n");
        }
        out.push('\n');

        // Optional project focus
        if let Some(project) = args.project.as_deref()
            && !project.contains('/')
            && !project.contains("..")
        {
            let proj_md = self.brain.home.join("projects").join(format!("{project}.md"));
            if proj_md.is_file() {
                out.push_str(&format!("## Project: {project}\n\n"));
                match std::fs::read_to_string(&proj_md) {
                    Ok(s) => {
                        out.push_str(&s);
                        if !s.ends_with('\n') {
                            out.push('\n');
                        }
                    }
                    Err(e) => out.push_str(&format!("(error reading: {e})\n")),
                }
                out.push('\n');
            } else {
                out.push_str(&format!(
                    "## Project: {project}\n_projects/{project}.md does not exist yet._\n\n"
                ));
            }
        }

        out.push_str("## How to use\n");
        out.push_str("- **Read**: `brain_read(path)` for any file. Paths relative to the brain home; symlinks into sources/ are followed.\n");
        out.push_str("- **Write for the user**: `brain_remember(category, content, project?)`. category ∈ {projects, areas, resources}. Append-only with auto-attribution.\n");
        out.push_str("- **List sources**: `brain_list_sources()` returns structured JSON.\n");
        out.push_str("- **Never** write to `sources/` (foreign territory) or `archive/` (human-curated).\n");
        out.push_str("- **Agent self-memory** (your own identity, daily notes) belongs in your tool's own store, not in brain. brain is the user's brain; you are a guest.\n");

        Ok(CallToolResult::success(vec![Content::text(out)]))
    }

    #[tool(
        description = "Read a file inside the brain. Path is relative to the brain home (e.g. \"areas/user.md\", \"sources/gstack-projects/SOMETHING.md\") or absolute under the brain home. Symlinks are followed so mounted sources work transparently. Refuses path traversal."
    )]
    async fn brain_read(
        &self,
        Parameters(args): Parameters<BrainReadArgs>,
    ) -> Result<CallToolResult, McpError> {
        let resolved = self
            .resolve_path(&args.path)
            .map_err(|e| McpError::invalid_params(format!("invalid path: {e}"), None))?;

        match std::fs::read_to_string(&resolved) {
            Ok(s) => Ok(CallToolResult::success(vec![Content::text(s)])),
            Err(e) => Err(McpError::internal_error(
                format!("read failed for {}: {}", resolved.display(), e),
                None,
            )),
        }
    }

    #[tool(
        description = "Append a markdown note to a PARA bucket on the user's behalf. Append-only; never overwrites. Auto-prepends a metadata header (timestamp, provenance). category MUST be \"projects\", \"areas\", or \"resources\" — \"archive\" and \"sources\" are rejected. Returns JSON: {path, bytes_written, created}."
    )]
    async fn brain_remember(
        &self,
        Parameters(args): Parameters<BrainRememberArgs>,
    ) -> Result<CallToolResult, McpError> {
        let input = RememberInput {
            category: &args.category,
            content: &args.content,
            project: args.project.as_deref(),
        };
        let response = remember_inner(&self.brain.home, &input)?;
        Ok(CallToolResult::success(vec![Content::text(response.to_string())]))
    }

    #[tool(
        description = "Force-drain the index queue once, synchronously. Returns JSON: {outcome: \"nothing_to_do\" | \"drained\" | \"failed\", attempted_at?: <rfc3339>, error?: string}. Useful when an agent wants a fresh search immediately after a write."
    )]
    async fn brain_sync(&self) -> Result<CallToolResult, McpError> {
        let outcome = drain_one_pass(&self.brain.home).await.map_err(|e| {
            McpError::internal_error(format!("drain_one_pass: {e:#}"), None)
        })?;
        let response = drain_outcome_to_json(&outcome);
        Ok(CallToolResult::success(vec![Content::text(response.to_string())]))
    }

    #[tool(
        description = "Search the brain corpus. `query` is a free-text search string. `scope` is an optional brain-relative path prefix (e.g. \"projects\" or \"areas/user\"). `mode` is \"hybrid\" (default; semantic + keyword + rerank), \"fast\" (BM25 keyword), or \"semantic\" (vector similarity). When qmd is unavailable, brain falls back to ripgrep keyword search and all modes silently degrade to \"fast\". Returns JSON: {hits: [{path, score, title, snippet, source}], backend, mode}."
    )]
    async fn brain_search(
        &self,
        Parameters(args): Parameters<BrainSearchArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mode = parse_mode(args.mode.as_deref())
            .map_err(|e| McpError::invalid_params(e.to_string(), None))?;

        let backend = pick_backend(self.brain.home.clone());
        let opts = SearchOptions {
            query: &args.query,
            mode,
            scope: args.scope.as_deref(),
            top_n: 10,
        };

        let hits = backend.search(&opts).await.map_err(|e| {
            McpError::internal_error(format!("search via {}: {e}", backend.name()), None)
        })?;

        let mode_str = match mode {
            brainmd::search_backend::SearchMode::Hybrid => "hybrid",
            brainmd::search_backend::SearchMode::Fast => "fast",
            brainmd::search_backend::SearchMode::Semantic => "semantic",
        };

        let response = serde_json::json!({
            "hits": hits,
            "backend": backend.name(),
            "mode": mode_str,
        });

        Ok(CallToolResult::success(vec![Content::text(response.to_string())]))
    }

    #[tool(
        description = "List all mounted sources. Returns JSON array: [{name, target, broken}, ...]. \"broken\" is true if the symlink target does not exist."
    )]
    async fn brain_list_sources(&self) -> Result<CallToolResult, McpError> {
        let sources_dir = self.brain.sources_dir();
        let mut items = Vec::new();
        if sources_dir.is_dir() {
            let entries = std::fs::read_dir(&sources_dir).map_err(|e| {
                McpError::internal_error(format!("reading {}: {}", sources_dir.display(), e), None)
            })?;
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                let meta = match path.symlink_metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if !meta.file_type().is_symlink() {
                    continue;
                }
                let target = match std::fs::read_link(&path) {
                    Ok(t) => t.to_string_lossy().into_owned(),
                    Err(_) => continue,
                };
                items.push(serde_json::json!({
                    "name": name,
                    "target": target,
                    "broken": !path.exists(),
                }));
            }
        }
        items.sort_by(|a, b| {
            a.get("name")
                .and_then(|v| v.as_str())
                .cmp(&b.get("name").and_then(|v| v.as_str()))
        });
        Ok(CallToolResult::success(vec![Content::text(
            serde_json::Value::Array(items).to_string(),
        )]))
    }

    fn resolve_path(&self, input: &str) -> Result<PathBuf, String> {
        let p = std::path::Path::new(input);
        let absolute = if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.brain.home.join(p)
        };
        let canonical = absolute
            .canonicalize()
            .map_err(|e| format!("could not resolve {}: {}", absolute.display(), e))?;
        let brain_canonical = self
            .brain
            .home
            .canonicalize()
            .map_err(|e| format!("brain home unreachable: {e}"))?;
        if !canonical.starts_with(&brain_canonical) {
            return Err(format!(
                "path {} escapes brain home {}",
                canonical.display(),
                brain_canonical.display()
            ));
        }
        Ok(canonical)
    }
}

#[tool_handler]
impl ServerHandler for BrainServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::from_build_env())
            .with_protocol_version(ProtocolVersion::V_2024_11_05)
            .with_instructions(
                "brain — the user's MCP-served second brain. \
                 Call brain_context first at session start to learn the layout, mounted sources, and the user's identity. \
                 Use brain_read for any file (sources are followed transparently via symlinks). \
                 Use brain_remember to deposit notes for the user (append-only, PARA-typed). \
                 Use brain_list_sources for structured source enumeration. \
                 brain is the user's brain; agents are guests acting on the user's behalf."
                    .to_string(),
            )
    }
}

pub fn drain_outcome_to_json(outcome: &DrainOutcome) -> serde_json::Value {
    match outcome {
        DrainOutcome::NothingToDo => serde_json::json!({ "outcome": "nothing_to_do" }),
        DrainOutcome::Drained { attempted_at } => {
            let dt: time::OffsetDateTime = (*attempted_at).into();
            let formatted = dt
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_else(|_| "unknown-time".to_string());
            serde_json::json!({
                "outcome": "drained",
                "attempted_at": formatted,
            })
        }
        DrainOutcome::Failed { stderr } => serde_json::json!({
            "outcome": "failed",
            "error": stderr,
        }),
    }
}

pub fn run(brain: Brain) -> Result<()> {
    if !brain.home.is_dir() {
        anyhow::bail!(
            "brain not initialized at {}. Run `brain init` first.",
            brain.home.display()
        );
    }

    let lock = match ServeLock::try_acquire(&brain.home)? {
        Some(l) => l,
        None => anyhow::bail!("another brain serve already owns this brain — exiting"),
    };

    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async {
        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| "info".into()),
            )
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .init();

        tracing::info!("brain serve starting at {}", brain.home.display());

        let cancel = CancellationToken::new();
        let worker_handle = spawn_worker(brain.home.clone(), 5, cancel.clone()).await;
        let watcher_handle = match spawn_watcher(brain.home.clone(), cancel.clone()).await {
            Ok(h) => Some(h),
            Err(e) => {
                tracing::warn!("file-watcher failed to start: {e:#}; continuing without it");
                None
            }
        };

        let service = BrainServer::new(brain).serve(stdio()).await?;
        let waiting = service.waiting().await;

        cancel.cancel();
        if let Err(e) = tokio::time::timeout(Duration::from_secs(5), worker_handle).await {
            tracing::warn!("worker shutdown timed out: {e}");
        }
        if let Some(handle) = watcher_handle
            && let Err(e) = tokio::time::timeout(Duration::from_secs(5), handle).await {
                tracing::warn!("watcher shutdown timed out: {e}");
            }

        waiting?;
        Ok::<(), anyhow::Error>(())
    })?;
    drop(lock);
    Ok(())
}

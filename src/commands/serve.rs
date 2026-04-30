use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use rmcp::{
    ErrorData as McpError, ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars,
    tool, tool_handler, tool_router,
    transport::stdio,
};

use crate::brain::{Brain, PARA_WRITABLE};

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
        description = "Discover what's in the brain. Call with no args at session start to learn the folder layout, mounted sources, and Yann's identity (areas/user.md). Pass `project` to also include the matching projects/<project>.md."
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

        // Yann's identity
        let user_md = self.brain.home.join("areas").join("user.md");
        if user_md.is_file() {
            out.push_str("## Yann (from areas/user.md)\n\n");
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
            out.push_str("## Yann\n_areas/user.md does not exist yet. Ask Yann to write one._\n\n");
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
        out.push_str("- **Write for Yann**: `brain_remember(category, content, project?)`. category ∈ {projects, areas, resources}. Append-only with auto-attribution.\n");
        out.push_str("- **List sources**: `brain_list_sources()` returns structured JSON.\n");
        out.push_str("- **Never** write to `sources/` (foreign territory) or `archive/` (human-curated).\n");
        out.push_str("- **Agent self-memory** (your own identity, daily notes) belongs in your tool's own store, not in brain. brain is Yann's brain; you are a guest.\n");

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
        description = "Append a markdown note to a PARA bucket on Yann's behalf. Append-only; never overwrites. Auto-prepends a metadata header (timestamp, provenance). category MUST be \"projects\", \"areas\", or \"resources\" — \"archive\" and \"sources\" are rejected. Returns JSON: {path, bytes_written, created}."
    )]
    async fn brain_remember(
        &self,
        Parameters(args): Parameters<BrainRememberArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !PARA_WRITABLE.contains(&args.category.as_str()) {
            return Err(McpError::invalid_params(
                format!(
                    "category must be one of {PARA_WRITABLE:?}, got \"{}\"",
                    args.category
                ),
                None,
            ));
        }
        let project = args.project.as_deref().unwrap_or("inbox");
        if project.contains('/') || project.contains("..") || project.is_empty() {
            return Err(McpError::invalid_params(
                format!("project name must be non-empty and not contain '/' or '..': {project}"),
                None,
            ));
        }
        let target = self
            .brain
            .home
            .join(&args.category)
            .join(format!("{project}.md"));

        let created = !target.exists();

        let now = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| "unknown-time".to_string());

        let block = format!(
            "\n---\nwritten: {now}\nby: mcp-client\n---\n{}\n",
            args.content.trim_end()
        );

        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                McpError::internal_error(format!("creating {}: {}", parent.display(), e), None)
            })?;
        }

        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&target)
            .map_err(|e| {
                McpError::internal_error(format!("opening {}: {}", target.display(), e), None)
            })?;
        let bytes_written = block.len();
        file.write_all(block.as_bytes()).map_err(|e| {
            McpError::internal_error(format!("writing {}: {}", target.display(), e), None)
        })?;

        let response = serde_json::json!({
            "path": target.to_string_lossy(),
            "bytes_written": bytes_written,
            "created": created,
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
                "brain — Yann's MCP-served second brain. \
                 Call brain_context first at session start to learn the layout, mounted sources, and Yann's identity. \
                 Use brain_read for any file (sources are followed transparently via symlinks). \
                 Use brain_remember to deposit notes for Yann (append-only, PARA-typed). \
                 Use brain_list_sources for structured source enumeration. \
                 brain is Yann's brain; agents are guests acting on his behalf."
                    .to_string(),
            )
    }
}

pub fn run(brain: Brain) -> Result<()> {
    if !brain.home.is_dir() {
        anyhow::bail!(
            "brain not initialized at {}. Run `brain init` first.",
            brain.home.display()
        );
    }

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

        let service = BrainServer::new(brain).serve(stdio()).await?;
        service.waiting().await?;
        Ok::<(), anyhow::Error>(())
    })
}

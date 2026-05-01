use std::path::Path;

use rmcp::ErrorData as McpError;

use crate::index_dirty;

pub const PARA_WRITABLE: &[&str] = &["projects", "areas", "resources"];

pub struct RememberInput<'a> {
    pub category: &'a str,
    pub content: &'a str,
    pub project: Option<&'a str>,
}

pub fn remember_inner(
    brain_home: &Path,
    input: &RememberInput<'_>,
) -> Result<serde_json::Value, McpError> {
    if !PARA_WRITABLE.contains(&input.category) {
        return Err(McpError::invalid_params(
            format!(
                "category must be one of {PARA_WRITABLE:?}, got \"{}\"",
                input.category
            ),
            None,
        ));
    }
    let project = input.project.unwrap_or("inbox");
    if project.contains('/') || project.contains("..") || project.is_empty() {
        return Err(McpError::invalid_params(
            format!("project name must be non-empty and not contain '/' or '..': {project}"),
            None,
        ));
    }
    let target = brain_home
        .join(input.category)
        .join(format!("{project}.md"));

    let created = !target.exists();

    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown-time".to_string());

    let block = format!(
        "\n---\nwritten: {now}\nby: mcp-client\n---\n{}\n",
        input.content.trim_end()
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

    if let Err(e) = index_dirty::touch(brain_home) {
        tracing::warn!("brain_remember succeeded but dirty-touch failed: {e:#}");
    }

    Ok(serde_json::json!({
        "path": target.to_string_lossy(),
        "bytes_written": bytes_written,
        "created": created,
    }))
}

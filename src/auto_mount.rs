use std::path::{Path, PathBuf};

pub struct AutoMount {
    pub name: &'static str,
    pub target: PathBuf,
}

impl AutoMount {
    pub fn target_exists(&self) -> bool {
        self.target.exists()
    }
}

pub fn discover() -> Vec<AutoMount> {
    let home = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => return Vec::new(),
    };

    let mut mounts = vec![
        AutoMount {
            name: "gstack-projects",
            target: home.join(".gstack/projects"),
        },
        AutoMount {
            name: "builder-journey.md",
            target: home.join(".gstack/builder-journey.md"),
        },
    ];

    if let Some(claude_memory) = resolve_claude_memory(&home) {
        mounts.push(AutoMount {
            name: "claude-memory",
            target: claude_memory,
        });
    }

    // OpenClaw paths are TBD pending canonical layout documentation.
    // Manual mount: brain source add openclaw-agents <path>

    mounts
}

fn resolve_claude_memory(home: &Path) -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let cwd_str = cwd.to_str()?;
    // Claude Code encodes cwd by replacing each '/' with '-'. An absolute path
    // already starts with '/', so the result has a single leading '-' (e.g.
    // /Users/<u>/dev/brain -> -Users-<u>-dev-brain). Do not prepend another '-'.
    let encoded = cwd_str.replace('/', "-");
    let candidate = home.join(".claude/projects").join(&encoded).join("memory");
    if candidate.exists() { Some(candidate) } else { None }
}

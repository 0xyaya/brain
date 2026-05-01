use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

use crate::brain::Brain;
use crate::commands;

#[derive(Parser)]
#[command(
    name = "brain",
    version,
    about = "MCP-served aggregator of AI artifacts (PARA + sources)"
)]
pub struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Scaffold a new brain folder (PARA dirs + auto-mount default sources).
    Init {
        /// Allow init in a non-empty directory; existing files are not deleted.
        #[arg(long)]
        force: bool,
    },
    /// Validate brain folder structure and report issues.
    Doctor,
    /// Create a portable tar.zst archive of the brain folder.
    Snapshot {
        /// Output path (default: brain-snapshot-<unix-ts>.tar.zst).
        #[arg(long)]
        out: Option<PathBuf>,
        /// Preserve symlinks instead of following them.
        /// Smaller archive, only restorable on the same machine.
        #[arg(long)]
        no_deref: bool,
    },
    /// Manage external memory mounts under sources/.
    Source {
        #[command(subcommand)]
        action: SourceAction,
    },
    /// Run brain as an MCP server over stdio.
    /// Wire this into your Claude Code MCP config to expose brain to agents.
    Serve,
    /// Index management commands.
    Index {
        #[command(subcommand)]
        action: IndexAction,
    },
}

#[derive(Subcommand)]
enum IndexAction {
    /// Force-drain the index queue once. Refuses if `brain serve` is running.
    Sync,
}

#[derive(Subcommand)]
enum SourceAction {
    /// Symlink an external path into <brain>/sources/<NAME>.
    Add {
        /// Mount name (used as the symlink filename under sources/).
        name: String,
        /// Path to mount. Must exist.
        path: PathBuf,
        /// Overwrite an existing source with the same name.
        #[arg(long)]
        force: bool,
    },
    /// Enumerate all mounted sources.
    List,
    /// Remove a source mount. Unlinks the symlink; never touches the target.
    Remove {
        name: String,
    },
}

impl Cli {
    pub fn run(self) -> Result<()> {
        let brain = Brain::resolve()?;
        match self.command {
            Command::Init { force } => commands::init::run(&brain, force),
            Command::Doctor => commands::doctor::run(&brain),
            Command::Snapshot { out, no_deref } => {
                commands::snapshot::run(&brain, out, !no_deref)
            }
            Command::Source { action } => match action {
                SourceAction::Add { name, path, force } => {
                    commands::source::add(&brain, &name, &path, force)
                }
                SourceAction::List => commands::source::list(&brain),
                SourceAction::Remove { name } => commands::source::remove(&brain, &name),
            },
            Command::Serve => commands::serve::run(brain),
            Command::Index { action } => match action {
                IndexAction::Sync => commands::index::sync(&brain),
            },
        }
    }
}

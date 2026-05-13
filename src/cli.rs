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
        /// Skip `git init` and the default .gitignore.
        /// Brain initializes git by default so sync (`brain hub init` /
        /// `brain join`) works without a separate setup step.
        #[arg(long)]
        no_git: bool,
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
    /// Sync the brain folder with its git remote (commit, pull --rebase, push).
    /// Safe to run on a clean repo. Skips pull/push if no remote is configured.
    Sync,
    /// Manage this machine's role in the brain sync topology.
    Hub {
        #[command(subcommand)]
        action: HubAction,
    },
    /// Attach this machine to a brain hub.
    ///
    /// Clones the brain from <HUB_URL> into $BRAIN_HOME (default ~/brain),
    /// sets a per-host git identity, installs a 5-minute sync timer
    /// (launchd on macOS, systemd user timer on Linux), and runs an initial
    /// `brain sync` to verify the round trip.
    Join {
        /// SSH (or local) URL of the hub's bare repo.
        hub_url: String,
        /// Skip installing the per-OS sync timer.
        #[arg(long)]
        no_schedule: bool,
        /// Push this machine's existing brain to an (empty) hub instead of
        /// cloning. For migrating an existing single-machine brain into a
        /// fresh hub.
        #[arg(long)]
        seed_from_here: bool,
    },
}

#[derive(Subcommand)]
enum HubAction {
    /// Promote this machine to be the hub: create a bare repo alongside the
    /// working copy, install the post-receive checkout hook, and wire origin.
    Init,
}

#[derive(Subcommand)]
enum IndexAction {
    /// Force-drain the index queue once. Refuses if `brain serve` is running.
    Sync,
}

#[derive(Subcommand)]
enum SourceAction {
    /// Register an external folder as a mirrored source.
    ///
    /// Brain copies the content into <brain>/sources/<NAME>/ on first
    /// run and re-syncs (one-way, origin → mirror) on `brain source sync`
    /// or `brain serve`'s watcher loop. The mirror dir is what syncs
    /// across machines via git; the origin path stays per-host.
    Add {
        /// Mount name. Becomes the subdir under sources/ on every machine.
        /// Convention: host-namespace it (e.g. `cc-mac`, `gstack-vps`)
        /// so peer machines don't collide.
        name: String,
        /// Absolute path to the origin folder on this host.
        #[arg(long)]
        from: PathBuf,
        /// Re-register a name that's already registered (replaces the
        /// origin path; does NOT delete the existing mirror content).
        #[arg(long)]
        force: bool,
    },
    /// Enumerate all registered sources with their origin paths.
    List,
    /// Unregister a source and delete its mirror dir.
    /// Never touches the origin folder.
    Remove { name: String },
    /// Run a one-way mirror from origin into the brain's mirror dir.
    /// With no name, sync all sources.
    Sync {
        /// If provided, sync only this source.
        name: Option<String>,
    },
}

impl Cli {
    pub fn run(self) -> Result<()> {
        let brain = Brain::resolve()?;
        match self.command {
            Command::Init { force, no_git } => commands::init::run(&brain, force, no_git),
            Command::Doctor => commands::doctor::run(&brain),
            Command::Snapshot { out, no_deref } => {
                commands::snapshot::run(&brain, out, !no_deref)
            }
            Command::Source { action } => match action {
                SourceAction::Add { name, from, force } => {
                    commands::source::add(&brain, &name, &from, force)
                }
                SourceAction::List => commands::source::list(&brain),
                SourceAction::Remove { name } => commands::source::remove(&brain, &name),
                SourceAction::Sync { name } => {
                    commands::source::sync(&brain, name.as_deref())
                }
            },
            Command::Serve => commands::serve::run(brain),
            Command::Index { action } => match action {
                IndexAction::Sync => commands::index::sync(&brain),
            },
            Command::Sync => commands::sync::run(&brain),
            Command::Hub { action } => match action {
                HubAction::Init => commands::hub::init(&brain),
            },
            Command::Join { hub_url, no_schedule, seed_from_here } => {
                commands::join::run(&brain, &hub_url, no_schedule, seed_from_here)
            }
        }
    }
}

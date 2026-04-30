mod auto_mount;
mod brain;
mod cli;
mod commands;

use anyhow::Result;
use clap::Parser;

fn main() -> Result<()> {
    cli::Cli::parse().run()
}

mod auto_mount;
mod brain;
mod cli;
mod commands;
#[allow(dead_code)]
mod index_dirty;
#[allow(dead_code)]
mod worker;

use anyhow::Result;
use clap::Parser;

fn main() -> Result<()> {
    cli::Cli::parse().run()
}

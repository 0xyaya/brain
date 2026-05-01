use anyhow::Result;
use brainmd::serve_lock::ServeLock;
use brainmd::worker::{DrainOutcome, drain_one_pass};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::brain::Brain;

pub fn sync(brain: &Brain) -> Result<()> {
    let _lock = match ServeLock::try_acquire(&brain.home)? {
        Some(l) => l,
        None => {
            eprintln!(
                "brain serve already draining; restart your Claude Code session or stop brain serve first"
            );
            std::process::exit(1);
        }
    };

    let rt = tokio::runtime::Runtime::new()?;
    let outcome = rt.block_on(drain_one_pass(&brain.home))?;
    match outcome {
        DrainOutcome::NothingToDo => println!("nothing to do"),
        DrainOutcome::Drained { attempted_at } => {
            let dt: OffsetDateTime = attempted_at.into();
            let formatted = dt
                .format(&Rfc3339)
                .unwrap_or_else(|_| "unknown-time".to_string());
            println!("drained at {formatted}");
        }
        DrainOutcome::Failed { stderr } => {
            println!("failed: {}", stderr.trim_end());
        }
    }
    Ok(())
}

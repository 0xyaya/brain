use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::Result;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::index_dirty;

#[derive(Debug)]
pub enum DrainOutcome {
    NothingToDo,
    Drained { attempted_at: SystemTime },
    Failed { stderr: String },
}

pub async fn drain_one_pass(brain_home: &Path) -> Result<DrainOutcome> {
    let Some(marker) = index_dirty::marker_mtime(brain_home)? else {
        return Ok(DrainOutcome::NothingToDo);
    };
    let watermark = index_dirty::read_last_indexed(brain_home)?
        .unwrap_or(SystemTime::UNIX_EPOCH);
    if marker <= watermark {
        return Ok(DrainOutcome::NothingToDo);
    }
    let attempting_at = marker;

    let update = Command::new("qmd")
        .arg("update")
        .kill_on_drop(true)
        .output()
        .await?;
    if !update.status.success() {
        return Ok(DrainOutcome::Failed {
            stderr: String::from_utf8_lossy(&update.stderr).into_owned(),
        });
    }

    let embed = Command::new("qmd")
        .arg("embed")
        .kill_on_drop(true)
        .output()
        .await?;
    if !embed.status.success() {
        return Ok(DrainOutcome::Failed {
            stderr: String::from_utf8_lossy(&embed.stderr).into_owned(),
        });
    }

    index_dirty::write_last_indexed(brain_home, attempting_at)?;
    Ok(DrainOutcome::Drained {
        attempted_at: attempting_at,
    })
}

fn clamp_interval_from_env(default_secs: u64) -> u64 {
    let raw = std::env::var("BRAIN_INDEX_INTERVAL").ok();
    let parsed = raw
        .as_deref()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default_secs);
    parsed.clamp(1, 60)
}

async fn run_drain(brain_home: &Path) {
    match drain_one_pass(brain_home).await {
        Ok(DrainOutcome::NothingToDo) => {}
        Ok(DrainOutcome::Drained { attempted_at }) => {
            tracing::info!("brain index drained (watermark={:?})", attempted_at);
        }
        Ok(DrainOutcome::Failed { stderr }) => {
            tracing::warn!("brain index drain failed: {stderr}");
        }
        Err(e) => {
            tracing::warn!("brain index drain error: {e:#}");
        }
    }
}

pub async fn spawn_worker(
    brain_home: PathBuf,
    interval_secs: u64,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    let interval = Duration::from_secs(clamp_interval_from_env(interval_secs));
    tokio::spawn(async move {
        loop {
            run_drain(&brain_home).await;
            tokio::select! {
                _ = cancel.cancelled() => {
                    let final_drain = tokio::time::timeout(
                        Duration::from_secs(5),
                        run_drain(&brain_home),
                    )
                    .await;
                    if final_drain.is_err() {
                        tracing::warn!("final drain timed out after 5s");
                    }
                    break;
                }
                _ = tokio::time::sleep(interval) => {}
            }
        }
    })
}

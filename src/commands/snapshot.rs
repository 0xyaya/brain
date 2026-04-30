use anyhow::{Context, Result, bail};
use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::brain::Brain;

pub fn run(brain: &Brain, out: Option<PathBuf>, deref: bool) -> Result<()> {
    if !brain.home.is_dir() {
        bail!("{} does not exist. Run: brain init", brain.home.display());
    }

    let out = out.unwrap_or_else(|| {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        PathBuf::from(format!("brain-snapshot-{stamp}.tar.zst"))
    });

    let file = File::create(&out).with_context(|| format!("creating {}", out.display()))?;
    let zstd_writer = zstd::stream::write::Encoder::new(BufWriter::new(file), 9)
        .context("creating zstd encoder")?
        .auto_finish();

    let mut tar = tar::Builder::new(zstd_writer);
    tar.follow_symlinks(deref);
    tar.append_dir_all("brain", &brain.home)
        .with_context(|| format!("archiving {}", brain.home.display()))?;
    tar.finish().context("finalizing tar")?;
    drop(tar);

    let mode = if deref { "dereferenced" } else { "preserved" };
    println!("Snapshot written to {} ({mode} symlinks)", out.display());
    Ok(())
}

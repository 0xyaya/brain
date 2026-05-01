use std::fs;

use tempfile::TempDir;

use brainmd::search_backend::{
    RipgrepBackend, SearchBackend, SearchMode, SearchOptions, parse_mode, pick_backend,
    qmd_uri_to_path,
};

fn opts<'a>(query: &'a str, scope: Option<&'a str>, top_n: usize) -> SearchOptions<'a> {
    SearchOptions {
        query,
        mode: SearchMode::Fast,
        scope,
        top_n,
    }
}

#[test]
fn qmd_uri_to_path_translation() {
    assert_eq!(
        qmd_uri_to_path("qmd://brain/projects/foo.md"),
        "projects/foo.md"
    );
    assert_eq!(
        qmd_uri_to_path("qmd://brain/areas/user.md"),
        "areas/user.md"
    );
    // Other collection: keep raw URI.
    assert_eq!(
        qmd_uri_to_path("qmd://other/foo.md"),
        "qmd://other/foo.md"
    );
    // Non-qmd URI: keep raw value.
    assert_eq!(
        qmd_uri_to_path("/abs/path/to/foo.md"),
        "/abs/path/to/foo.md"
    );
}

#[test]
fn mode_parse_default_hybrid() {
    assert_eq!(parse_mode(None).unwrap(), SearchMode::Hybrid);
    assert_eq!(parse_mode(Some("hybrid")).unwrap(), SearchMode::Hybrid);
    assert_eq!(parse_mode(Some("fast")).unwrap(), SearchMode::Fast);
    assert_eq!(parse_mode(Some("semantic")).unwrap(), SearchMode::Semantic);
    assert!(parse_mode(Some("bogus")).is_err());
}

fn write_md(home: &std::path::Path, rel: &str, content: &str) {
    let target = home.join(rel);
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(target, content).unwrap();
}

#[tokio::test]
async fn ripgrep_backend_finds_match() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().to_path_buf();
    write_md(&home, "projects/note.md", "look for SHIBBOLETH-XYZ here\n");
    write_md(&home, "areas/other.md", "no match\n");

    let backend = RipgrepBackend::new(home);
    let opts = opts("SHIBBOLETH-XYZ", None, 10);
    let hits = backend.search(&opts).await.expect("rg search ok");
    assert_eq!(hits.len(), 1, "expected exactly one hit, got {:?}", hits);
    assert_eq!(hits[0].path, "projects/note.md");
    assert_eq!(hits[0].source, "ripgrep");
}

#[tokio::test]
async fn ripgrep_backend_scope_filter() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().to_path_buf();
    write_md(&home, "projects/a.md", "MARKER-FOO\n");
    write_md(&home, "projects/b.md", "MARKER-FOO\n");
    write_md(&home, "areas/c.md", "MARKER-FOO\n");

    let backend = RipgrepBackend::new(home);
    let opts = opts("MARKER-FOO", Some("projects"), 10);
    let hits = backend.search(&opts).await.unwrap();
    assert_eq!(hits.len(), 2, "scope filter expected 2 hits, got {:?}", hits);
    for hit in &hits {
        assert!(
            hit.path.starts_with("projects"),
            "hit outside scope: {}",
            hit.path
        );
    }
}

#[tokio::test]
async fn ripgrep_backend_top_n_truncation() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().to_path_buf();
    for i in 0..12 {
        write_md(&home, &format!("projects/n{i:02}.md"), "MARKER-TRUNC\n");
    }

    let backend = RipgrepBackend::new(home);
    let opts = opts("MARKER-TRUNC", None, 5);
    let hits = backend.search(&opts).await.unwrap();
    assert_eq!(hits.len(), 5, "top_n=5 should truncate; got {}", hits.len());
}

#[tokio::test]
async fn ripgrep_backend_empty_query() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().to_path_buf();
    write_md(&home, "projects/n.md", "any content\n");
    let backend = RipgrepBackend::new(home);
    let opts = opts("", None, 10);
    let hits = backend.search(&opts).await.unwrap();
    assert!(hits.is_empty());
}

#[test]
#[ignore = "requires PATH manipulation that can interfere with cargo's environment"]
fn pick_backend_returns_ripgrep_when_qmd_absent() {
    // Save original PATH; clear it so `which qmd` fails.
    let original = std::env::var_os("PATH");
    // Keep only directories that don't contain qmd. Easiest: empty string.
    // SAFETY: tests run single-threaded by default; this still racy if other tests touch PATH.
    unsafe {
        std::env::set_var("PATH", "");
    }
    let backend = pick_backend(std::path::PathBuf::from("/tmp"));
    let name = backend.name();
    if let Some(p) = original {
        unsafe {
            std::env::set_var("PATH", p);
        }
    } else {
        unsafe {
            std::env::remove_var("PATH");
        }
    }
    assert_eq!(name, "ripgrep");
}

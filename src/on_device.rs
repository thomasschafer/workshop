//! Optional on-device runtime bundles (such as GHC WASM): pinned manifest, SHA-256 verification,
//! and streaming downloads into the server's cache so phones can fetch and cache them over
//! Tailscale without bloating the Workshop binary.

use std::fmt::Write as _;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use workshop_toolchain::packages::InstallLog;

const CATALOG_JSON: &str = include_str!("../on-device/bundles.json");

#[derive(Debug, Clone, Deserialize)]
struct BundleCatalog {
    bundles: Vec<BundleSpec>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleSpec {
    pub id: String,
    pub version: String,
    pub language: String,
    pub engine: String,
    pub description: String,
    pub packages: Vec<String>,
    pub ghc_libdir: String,
    pub ghc_lib_search_dir: String,
    pub main_so_path: String,
    pub files: Vec<BundleFile>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleFile {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub content_type: String,
}

impl BundleSpec {
    /// Directory and URL segment `<id>@<version>`.
    pub fn key(&self) -> String {
        format!("{}@{}", self.id, self.version)
    }

    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }

    pub fn file(&self, name: &str) -> Option<&BundleFile> {
        self.files.iter().find(|f| f.name == name)
    }
}

/// Every pinned on-device runtime bundle Workshop knows about.
pub fn catalog() -> &'static [BundleSpec] {
    static CATALOG: OnceLock<Vec<BundleSpec>> = OnceLock::new();
    CATALOG
        .get_or_init(|| {
            let parsed: BundleCatalog = serde_json::from_str(CATALOG_JSON)
                .expect("embedded on-device/bundles.json must be valid JSON");
            for bundle in &parsed.bundles {
                assert!(
                    !bundle.id.is_empty() && !bundle.version.is_empty(),
                    "bundle id and version must be non-empty"
                );
                for file in &bundle.files {
                    assert!(
                        !file.name.contains('/') && !file.name.contains(".."),
                        "bundle file name must be a single segment: {}",
                        file.name
                    );
                    assert_eq!(
                        file.sha256.len(),
                        64,
                        "bundle file sha256 must be 64 hex chars: {}",
                        file.name
                    );
                }
            }
            parsed.bundles
        })
        .as_slice()
}

pub fn find_by_id(id: &str) -> Option<&'static BundleSpec> {
    catalog().iter().find(|b| b.id == id)
}

pub fn find_by_key(key: &str) -> Option<&'static BundleSpec> {
    catalog()
        .iter()
        .find(|b| key == format!("{}@{}", b.id, b.version))
}

pub fn bundle_dir(base: &Path, spec: &BundleSpec) -> PathBuf {
    base.join(spec.key())
}

pub fn file_path(base: &Path, spec: &BundleSpec, file: &BundleFile) -> PathBuf {
    bundle_dir(base, spec).join(&file.name)
}

/// Quick check used for status endpoints: every pinned file exists with its expected byte size.
pub fn is_installed(base: &Path, spec: &BundleSpec) -> bool {
    spec.files.iter().all(|file| {
        std::fs::metadata(file_path(base, spec, file))
            .map(|meta| meta.is_file() && meta.len() == file.size)
            .unwrap_or(false)
    })
}

/// Computes the lowercase hex SHA-256 digest of a file on disk.
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// Verifies every file of `spec` on disk matches its pinned byte length and SHA-256 checksum.
pub fn verify_installed(base: &Path, spec: &BundleSpec) -> Result<()> {
    for file in &spec.files {
        let path = file_path(base, spec, file);
        let meta = std::fs::metadata(&path)
            .with_context(|| format!("missing bundle file {}", file.name))?;
        if meta.len() != file.size {
            bail!(
                "{} has {} bytes, expected {}",
                file.name,
                meta.len(),
                file.size
            );
        }
        let actual = sha256_file(&path)?;
        if actual != file.sha256 {
            bail!(
                "{} SHA-256 mismatch: expected {}, got {actual}",
                file.name,
                file.sha256
            );
        }
    }
    Ok(())
}

/// Downloads any missing or invalid files of `spec` into `base/<id>@<version>/`, verifying exact
/// byte length and SHA-256 before moving each file into place.
pub async fn download_bundle(
    base: &Path,
    spec: &BundleSpec,
    cancel: &CancellationToken,
    log: &InstallLog,
) -> Result<()> {
    let dir = bundle_dir(base, spec);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;

    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()?;

    for file in &spec.files {
        let dest = dir.join(&file.name);
        if dest.is_file()
            && std::fs::metadata(&dest).is_ok_and(|m| m.len() == file.size)
            && sha256_file(&dest).is_ok_and(|sum| sum == file.sha256)
        {
            log.push(format!("{} already verified", file.name));
            continue;
        }
        download_file(&http, &dir, file, cancel, log).await?;
    }

    verify_installed(base, spec)?;
    log.push(format!("{} ready on server", spec.engine));
    Ok(())
}

async fn download_file(
    http: &reqwest::Client,
    dir: &Path,
    file: &BundleFile,
    cancel: &CancellationToken,
    log: &InstallLog,
) -> Result<()> {
    let dest = dir.join(&file.name);
    let partial = dir.join(format!("{}.part", file.name));
    log.push(format!("Downloading {}…", file.name));

    let mut response = http
        .get(&file.url)
        .send()
        .await
        .with_context(|| format!("couldn't reach {} to download {}", file.url, file.name))?
        .error_for_status()
        .with_context(|| format!("server refused download for {}", file.name))?;

    let mut out = tokio::fs::File::create(&partial)
        .await
        .with_context(|| format!("creating {}", partial.display()))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut reported_mb = 0;

    let download = async {
        while let Some(chunk) = response
            .chunk()
            .await
            .with_context(|| format!("downloading {}", file.name))?
        {
            tokio::io::AsyncWriteExt::write_all(&mut out, &chunk).await?;
            hasher.update(&chunk);
            received += chunk.len() as u64;
            let mb = received / 1_000_000;
            if mb >= reported_mb + 5 {
                reported_mb = mb;
                let total_mb = file.size / 1_000_000;
                log.push(format!("Downloading {}: {mb} of {total_mb} MB", file.name));
            }
        }
        tokio::io::AsyncWriteExt::flush(&mut out).await?;
        anyhow::Ok(())
    };

    let result = tokio::select! {
        res = download => res,
        () = cancel.cancelled() => Err(anyhow::anyhow!("Downloading was cancelled.")),
    };
    drop(out);

    let verified = result.and_then(|()| {
        if received != file.size {
            bail!("{} stopped at {received} of {} bytes", file.name, file.size);
        }
        let actual = hex_lower(&hasher.finalize());
        if actual != file.sha256 {
            bail!(
                "{} SHA-256 mismatch: expected {}, got {actual}",
                file.name,
                file.sha256
            );
        }
        Ok(())
    });

    if let Err(err) = verified {
        let _ = std::fs::remove_file(&partial);
        return Err(err);
    }

    std::fs::rename(&partial, &dest).with_context(|| format!("moving {} into place", file.name))?;
    log.push(format!("Verified {}", file.name));
    Ok(())
}

pub fn remove_bundle(base: &Path, spec: &BundleSpec) -> Result<()> {
    let dir = bundle_dir(base, spec);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).with_context(|| format!("removing {}", dir.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_loads_and_looks_up_haskell_bundle() {
        let spec = find_by_id("haskell-ghc-wasm").expect("haskell-ghc-wasm bundle");
        assert_eq!(spec.language, "haskell");
        assert!(find_by_key(&spec.key()).is_some());
        assert!(spec.file("rootfs.tar.zst").is_some());
        assert!(spec.file("bsdtar.wasm").is_some());
        assert!(spec.total_bytes() > 40_000_000);
    }

    #[test]
    fn verify_installed_detects_missing_and_corrupt_files() {
        let dir = tempfile::tempdir().unwrap();
        let spec = BundleSpec {
            id: "test-bundle".into(),
            version: "1.0.0".into(),
            language: "haskell".into(),
            engine: "Test".into(),
            description: "Test".into(),
            packages: vec![],
            ghc_libdir: "/tmp".into(),
            ghc_lib_search_dir: "/tmp".into(),
            main_so_path: "/tmp/main.so".into(),
            files: vec![BundleFile {
                name: "hello.bin".into(),
                url: "https://example.invalid/hello.bin".into(),
                size: 5,
                // sha256("hello")
                sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".into(),
                content_type: "application/octet-stream".into(),
            }],
        };
        assert!(!is_installed(dir.path(), &spec));
        assert!(verify_installed(dir.path(), &spec).is_err());

        let bdir = bundle_dir(dir.path(), &spec);
        std::fs::create_dir_all(&bdir).unwrap();
        std::fs::write(bdir.join("hello.bin"), b"world").unwrap();
        assert!(is_installed(dir.path(), &spec));
        assert!(verify_installed(dir.path(), &spec).is_err());

        std::fs::write(bdir.join("hello.bin"), b"hello").unwrap();
        assert!(verify_installed(dir.path(), &spec).is_ok());

        remove_bundle(dir.path(), &spec).unwrap();
        assert!(!is_installed(dir.path(), &spec));
    }
}

// The frontend is embedded from frontend/dist. Create it if missing so that Rust-only builds
// (such as `cargo clippy` without building the frontend) still compile; the server then explains
// that the frontend needs building.
fn main() {
    let dist = std::path::Path::new("frontend/dist");
    if !dist.exists() {
        std::fs::create_dir_all(dist).expect("creating frontend/dist");
    }
    println!("cargo:rerun-if-changed=frontend/dist");
}

fn main() {
    // Declaring the app's own commands gives each an allow-<name> permission.
    // The UI is served from http://localhost (see lib.rs), which Tauri treats
    // as a remote origin, and remote origins may only call commands a
    // capability grants by name.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "daemon_token",
            "daemon_url",
            "daemon_status",
            "start_daemon",
            "daemon_logs",
        ]),
    ))
    .expect("failed to run tauri-build");
}

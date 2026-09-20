mod commands;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::file_meta,
            commands::resolve_cli_file,
            commands::recents_get,
            commands::recents_add,
            commands::recents_clear,
            commands::signatures_list,
            commands::signature_read,
            commands::signature_save,
            commands::signature_delete,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // `RunEvent::Opened` only exists on macOS and iOS, so this whole
            // arm has to be compiled out elsewhere or the crate does not build.
            // Windows and Linux deliver "open with" paths on argv instead,
            // which `resolve_cli_file` already handles.
            #[cfg(target_os = "macos")]
            {
                // macOS delivers Finder "Open With" / dock drops here rather
                // than on argv, so forward them to the window as an event.
                if let tauri::RunEvent::Opened { urls } = event {
                    let paths: Vec<String> = urls
                        .iter()
                        .filter_map(|u| u.to_file_path().ok())
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect();
                    if !paths.is_empty() {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("pdf://open-paths", paths);
                        }
                    }
                }
            }

            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

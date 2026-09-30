mod commands;
pub mod encrypt;
pub mod optimize;
#[cfg(target_os = "macos")]
mod glass;
mod license;
mod license_key;
mod settings;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Only reassigned off macOS, where the single-instance plugin is added.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    /*
     * Hand a double-clicked file to the running app rather than starting
     * another copy. This has to be decided before the app is built, which is
     * why the preference lives in a file rather than in localStorage.
     *
     * Not on macOS: the system already refuses to launch a second copy of a
     * bundle and delivers the file as `RunEvent::Opened` below.
     */
    #[cfg(not(target_os = "macos"))]
    if settings::load().single_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let paths: Vec<String> = argv
                    .iter()
                    .skip(1)
                    .filter(|a| {
                        let p = std::path::Path::new(a);
                        p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")) && p.is_file()
                    })
                    .cloned()
                    .collect();
                if !paths.is_empty() {
                    let _ = window.emit("pdf://open-paths", paths);
                }
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            if let Some(window) = _app.get_webview_window("main") {
                glass::install(&window);
            }
            Ok(())
        })
        .on_window_event(|_window, _event| {
            // AppKit puts the traffic lights back wherever it likes after any
            // of these; put them back on the toolbar row.
            #[cfg(target_os = "macos")]
            if matches!(
                _event,
                tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::Focused(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
                    | tauri::WindowEvent::ThemeChanged(_)
            ) {
                if let Ok(ns_window) = _window.ns_window() {
                    glass::place_traffic_lights(ns_window);
                }
            }
        })
        .manage(commands::OpenedFiles::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::file_meta,
            commands::resolve_cli_file,
            commands::opened_files_take,
            commands::recents_get,
            commands::recents_add,
            commands::recents_clear,
            commands::signatures_list,
            commands::signature_read,
            commands::signature_save,
            commands::signature_delete,
            commands::settings_get,
            commands::settings_set,
            commands::license_status,
            commands::license_activate,
            commands::license_remove,
            commands::get_desktop_environment,
            commands::print_pdf,
            commands::optimize_image,
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
                    // On a cold launch these arrive before the window exists,
                    // let alone the page's listener, so they queue until the
                    // page collects them.
                    let ready = app.state::<commands::OpenedFiles>().arrived(paths);
                    if let Some(window) = app.get_webview_window("main") {
                        // Double-clicking a file should bring the app forward.
                        let _ = window.set_focus();
                        if let Some(paths) = ready.filter(|p| !p.is_empty()) {
                            let _ = window.emit("pdf://open-paths", paths);
                        }
                    }
                }
            }

            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

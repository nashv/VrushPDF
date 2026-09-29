//! Preferences that Rust has to know about before the window exists.
//!
//! Everything the frontend can own lives in `localStorage`. This file is for
//! the exception: whether to run as a single instance is decided while the
//! `tauri::Builder` is still being assembled, long before a webview could be
//! asked.
//!
//! The path is resolved the same way Tauri resolves `app_config_dir()` — the
//! platform config directory joined with the bundle identifier — because this
//! module reads the file without an `AppHandle` while `commands.rs` writes it
//! through one, and the two have to agree.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const SETTINGS_FILE: &str = "settings.json";
const IDENTIFIER: &str = "com.nachiket.vrushpdf";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Hand a double-clicked file to the running app instead of starting
    /// another copy. Always effectively true on macOS, which does it for us.
    pub single_instance: bool,
    /// Warn before saving a signed document unflattened.
    pub warn_unflattened_signatures: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            single_instance: true,
            warn_unflattened_signatures: true,
        }
    }
}

pub fn config_dir() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join(IDENTIFIER))
}

fn settings_path() -> Option<PathBuf> {
    Some(config_dir()?.join(SETTINGS_FILE))
}

/// Read the stored settings. Anything missing or unreadable means defaults —
/// a corrupt file must not stop the app from starting.
pub fn load() -> Settings {
    let Some(path) = settings_path() else {
        return Settings::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn store(settings: &Settings) -> Result<(), String> {
    let path = settings_path().ok_or("no config directory")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("{}: {e}", path.display()))
}

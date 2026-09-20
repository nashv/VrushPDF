//! Filesystem + app-storage commands.
//!
//! PDFs are read and written as raw IPC bodies rather than as `Vec<u8>` command
//! arguments: a JSON array of bytes costs roughly 3x the payload size and a
//! stringify/parse pass on both sides, which is very visible on a 20 MB file.
//! Reads return `ipc::Response`; writes receive `ipc::InvokeBody::Raw` and carry
//! their destination in a percent-encoded header (HTTP headers are not safe for
//! arbitrary UTF-8 filenames).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::{ipc, AppHandle, Manager, Runtime};

const RECENTS_FILE: &str = "recents.json";
const SIGNATURES_DIR: &str = "signatures";
const MAX_RECENTS: usize = 15;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileMeta {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Milliseconds since the Unix epoch, or `None` if the platform withholds it.
    pub modified: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SignatureMeta {
    pub id: String,
    pub name: String,
}

/// Decode `encodeURIComponent` output back into a path.
fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .ok_or("malformed percent-encoding")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "malformed percent-encoding")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "path is not valid UTF-8".to_string())
}

fn header(request: &ipc::Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("missing `{name}` header"))?
        .to_str()
        .map_err(|_| format!("`{name}` header is not valid ASCII"))?;
    percent_decode(raw)
}

fn raw_body<'a>(request: &'a ipc::Request<'a>) -> Result<&'a [u8], String> {
    match request.body() {
        ipc::InvokeBody::Raw(bytes) => Ok(bytes),
        ipc::InvokeBody::Json(_) => {
            Err("expected a raw ArrayBuffer body, got JSON".to_string())
        }
    }
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn meta_for(path: &Path) -> Result<FileMeta, String> {
    let md = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let modified = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(FileMeta {
        path: path.to_string_lossy().into_owned(),
        name: file_name_of(path),
        size: md.len(),
        modified,
    })
}

// ---------------------------------------------------------------- file access

#[tauri::command]
pub fn read_file(path: String) -> Result<ipc::Response, String> {
    let bytes = fs::read(&path).map_err(|e| format!("could not read {path}: {e}"))?;
    Ok(ipc::Response::new(bytes))
}

/// Write bytes to `x-file-path`. Writes to a sibling temp file and renames, so
/// an interrupted save cannot leave the user with a truncated PDF.
#[tauri::command]
pub fn write_file(request: ipc::Request<'_>) -> Result<FileMeta, String> {
    let path = PathBuf::from(header(&request, "x-file-path")?);
    let bytes = raw_body(&request)?;

    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or("destination has no parent directory")?;
    fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;

    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    fs::write(&tmp, bytes).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not save {}: {e}", path.display())
    })?;

    meta_for(&path)
}

#[tauri::command]
pub fn file_meta(path: String) -> Result<FileMeta, String> {
    meta_for(Path::new(&path))
}

/// A PDF path passed on argv, used for file associations and `open -a`.
#[tauri::command]
pub fn resolve_cli_file() -> Option<String> {
    std::env::args().skip(1).find(|arg| {
        let p = Path::new(arg);
        p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")) && p.is_file()
    })
}

// -------------------------------------------------------------------- recents

fn recents_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir.join(RECENTS_FILE))
}

#[tauri::command]
pub fn recents_get<R: Runtime>(app: AppHandle<R>) -> Result<Vec<FileMeta>, String> {
    let path = recents_path(&app)?;
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    let stored: Vec<FileMeta> = serde_json::from_str(&text).unwrap_or_default();
    // Drop entries the user has since moved or deleted.
    Ok(stored
        .into_iter()
        .filter(|m| Path::new(&m.path).is_file())
        .collect())
}

#[tauri::command]
pub fn recents_add<R: Runtime>(app: AppHandle<R>, path: String) -> Result<Vec<FileMeta>, String> {
    let entry = meta_for(Path::new(&path))?;
    let mut list = recents_get(app.clone())?;
    list.retain(|m| m.path != entry.path);
    list.insert(0, entry);
    list.truncate(MAX_RECENTS);

    let file = recents_path(&app)?;
    let json = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    fs::write(&file, json).map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(list)
}

#[tauri::command]
pub fn recents_clear<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let file = recents_path(&app)?;
    // A missing file is already an empty list.
    match fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", file.display())),
    }
}

// ------------------------------------------------------------------ settings

#[tauri::command]
pub fn settings_get() -> crate::settings::Settings {
    crate::settings::load()
}

#[tauri::command]
pub fn settings_set(settings: crate::settings::Settings) -> Result<(), String> {
    crate::settings::store(&settings)
}

// ----------------------------------------------------------------- signatures

fn signatures_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no data dir: {e}"))?
        .join(SIGNATURES_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

/// Reject anything that could escape the signatures directory.
fn signature_file<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid signature id: {id}"));
    }
    Ok(signatures_dir(app)?.join(format!("{id}.png")))
}

#[tauri::command]
pub fn signatures_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<SignatureMeta>, String> {
    let dir = signatures_dir(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "png") {
            let id = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
            let name = fs::read_to_string(path.with_extension("name"))
                .unwrap_or_else(|_| "Signature".to_string());
            out.push(SignatureMeta { id, name });
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[tauri::command]
pub fn signature_read<R: Runtime>(app: AppHandle<R>, id: String) -> Result<ipc::Response, String> {
    let path = signature_file(&app, &id)?;
    let bytes = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(ipc::Response::new(bytes))
}

/// Body is the PNG; `x-signature-id` and `x-signature-name` carry the metadata.
#[tauri::command]
pub fn signature_save<R: Runtime>(
    app: AppHandle<R>,
    request: ipc::Request<'_>,
) -> Result<SignatureMeta, String> {
    let id = header(&request, "x-signature-id")?;
    let name = header(&request, "x-signature-name")?;
    let bytes = raw_body(&request)?;

    let path = signature_file(&app, &id)?;
    fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    fs::write(path.with_extension("name"), &name).map_err(|e| e.to_string())?;
    Ok(SignatureMeta { id, name })
}

#[tauri::command]
pub fn signature_delete<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let path = signature_file(&app, &id)?;
    fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let _ = fs::remove_file(path.with_extension("name"));
    Ok(())
}

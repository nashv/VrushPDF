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
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::{ipc, AppHandle, Manager, Runtime};

use crate::license;

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
    require_license()?;
    let path = PathBuf::from(header(&request, "x-file-path")?);
    let password = header(&request, "x-password").ok();
    let raw_bytes = raw_body(&request)?;

    let encrypted_bytes;
    let bytes_to_write = if let Some(ref pwd) = password {
        if !pwd.is_empty() {
            encrypted_bytes = crate::encrypt::encrypt_pdf(raw_bytes, pwd)?;
            &encrypted_bytes[..]
        } else {
            raw_bytes
        }
    } else {
        raw_bytes
    };

    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or("destination has no parent directory")?;
    fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;

    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    fs::write(&tmp, bytes_to_write).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
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

/*
 * Finder "Open With" on macOS. The system hands the files over while the app is
 * still starting, before the page has subscribed to `pdf://open-paths`, and an
 * event nobody is listening for is simply lost. So they wait here until the
 * page asks for them; after that, `lib.rs` emits them straight away.
 */
#[derive(Default)]
pub struct OpenedFiles(Mutex<Opened>);

#[derive(Default)]
struct Opened {
    /// The page is listening, so new files can be emitted rather than queued.
    listening: bool,
    pending: Vec<String>,
}

impl OpenedFiles {
    /// Either queues `paths` or, once the page is listening, returns them to
    /// be emitted. One lock covers both, so none can slip between the page
    /// collecting the queue and starting to listen.
    pub fn arrived(&self, paths: Vec<String>) -> Option<Vec<String>> {
        let mut opened = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if opened.listening {
            Some(paths)
        } else {
            opened.pending.extend(paths);
            None
        }
    }
}

/// Files that arrived before the page was listening. Called once, after it
/// has subscribed to `pdf://open-paths`.
#[tauri::command]
pub fn opened_files_take(state: tauri::State<'_, OpenedFiles>) -> Vec<String> {
    let mut opened = state.0.lock().unwrap_or_else(|e| e.into_inner());
    opened.listening = true;
    std::mem::take(&mut opened.pending)
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
    require_license()?;
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

// -------------------------------------------------------------------- license

/*
 * Every save, and saving a signature, goes through a command above, so this is
 * where an ended trial actually stops writes. The frontend hides the tools and
 * explains first; this holds even if it did not.
 */
fn require_license() -> Result<(), String> {
    if license::can_edit() {
        Ok(())
    } else {
        Err("Your VrushPDF trial has ended. Enter a license key to save changes.".into())
    }
}

/*
 * On the blocking pool: every one of these reads or writes `license.json`, so
 * none belongs on the main thread where synchronous commands run.
 */
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn license_status() -> Result<license::Status, String> {
    blocking(license::status).await
}

#[tauri::command]
pub async fn license_activate(key: String) -> Result<license::Status, String> {
    blocking(move || license::activate(&key)).await?
}

#[tauri::command]
pub fn get_desktop_environment() -> String {
    #[cfg(target_os = "windows")]
    return "win".to_string();

    #[cfg(target_os = "macos")]
    return "mac".to_string();

    #[cfg(target_os = "linux")]
    {
        let de = std::env::var("XDG_CURRENT_DESKTOP")
            .unwrap_or_default()
            .to_lowercase();
        if de.contains("kde") || de.contains("plasma") {
            "kde".to_string()
        } else if de.contains("gnome") {
            "gnome".to_string()
        } else {
            "linux".to_string()
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    "linux".to_string()
}

#[tauri::command]
pub async fn license_remove() -> Result<license::Status, String> {
    blocking(license::remove).await
}

// -------------------------------------------------------------------- printing

#[tauri::command]
pub fn print_pdf<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    request: ipc::Request<'_>,
) -> Result<(), String> {
    let title = header(&request, "x-doc-title").unwrap_or_else(|_| "Document".to_string());
    let raw_bytes = raw_body(&request)?;
    print_pdf_native(&app, &window, raw_bytes, &title)
}

#[cfg(target_os = "macos")]
fn print_pdf_native<R: Runtime>(
    _app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    pdf_bytes: &[u8],
    _title: &str,
) -> Result<(), String> {
    use std::ffi::c_void;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!(
        "vrushpdf_print_{}_{}.pdf",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    fs::write(&temp_file, pdf_bytes).map_err(|e| format!("could not write temp print file: {e}"))?;

    let path_str = temp_file.to_string_lossy();
    let ns_path = NSString::from_str(&path_str);

    unsafe {
        extern "C" {
            fn dlopen(filename: *const std::ffi::c_char, flag: std::ffi::c_int) -> *mut c_void;
        }
        let pdfkit_path = std::ffi::CString::new("/System/Library/Frameworks/PDFKit.framework/PDFKit").unwrap();
        dlopen(pdfkit_path.as_ptr(), 1 /* RTLD_LAZY */);

        let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: &*ns_path];
        if url.is_null() {
            let _ = fs::remove_file(&temp_file);
            return Err("could not create file URL for printing".into());
        }

        let doc_class = AnyClass::get(c"PDFDocument").ok_or_else(|| {
            let _ = fs::remove_file(&temp_file);
            "PDFKit PDFDocument class not available".to_string()
        })?;

        let doc: *mut AnyObject = msg_send![doc_class, alloc];
        let doc: *mut AnyObject = msg_send![doc, initWithURL: url];
        if doc.is_null() {
            let _ = fs::remove_file(&temp_file);
            return Err("failed to load PDFDocument for printing".into());
        }

        let print_info: *mut AnyObject = msg_send![class!(NSPrintInfo), sharedPrintInfo];
        if !print_info.is_null() {
            let _: () = msg_send![print_info, setHorizontallyCentered: true];
            let _: () = msg_send![print_info, setVerticallyCentered: true];
        }

        let op: *mut AnyObject = msg_send![
            doc,
            printOperationForPrintInfo: print_info,
            scalingMode: 0isize,
            autoRotate: true
        ];

        if op.is_null() {
            let _ = fs::remove_file(&temp_file);
            return Err("could not create NSPrintOperation".into());
        }

        let _: () = msg_send![op, setShowsPrintPanel: true];
        let _: () = msg_send![op, setShowsProgressPanel: true];

        if let Ok(ns_window) = window.ns_window() {
            let _: () = msg_send![
                op,
                runOperationModalForWindow: ns_window as *mut c_void,
                delegate: std::ptr::null_mut::<AnyObject>(),
                didRunSelector: std::ptr::null_mut::<c_void>(),
                contextInfo: std::ptr::null_mut::<c_void>()
            ];
        } else {
            let _: bool = msg_send![op, runOperation];
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn print_pdf_native<R: Runtime>(
    _app: &AppHandle<R>,
    _window: &tauri::WebviewWindow<R>,
    pdf_bytes: &[u8],
    _title: &str,
) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!(
        "vrushpdf_print_{}.pdf",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    fs::write(&temp_file, pdf_bytes).map_err(|e| format!("could not write temp print file: {e}"))?;

    let cmd_str = format!(
        "Start-Process -FilePath '{}' -Verb Print",
        temp_file.to_string_lossy().replace('\'', "''")
    );
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &cmd_str])
        .status()
        .map_err(|e| format!("failed to start print process: {e}"))?;

    if !status.success() {
        return Err(format!("print process exited with status: {status}"));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn print_pdf_native<R: Runtime>(
    _app: &AppHandle<R>,
    _window: &tauri::WebviewWindow<R>,
    pdf_bytes: &[u8],
    _title: &str,
) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!(
        "vrushpdf_print_{}.pdf",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    fs::write(&temp_file, pdf_bytes).map_err(|e| format!("could not write temp print file: {e}"))?;

    let result = std::process::Command::new("gtklp")
        .arg(&temp_file)
        .status()
        .or_else(|_| std::process::Command::new("lpr").arg(&temp_file).status())
        .or_else(|_| std::process::Command::new("lp").arg(&temp_file).status());

    match result {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("print command failed with status: {status}")),
        Err(err) => Err(format!("no print utility (gtklp/lpr/lp) found: {err}")),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn print_pdf_native<R: Runtime>(
    _app: &AppHandle<R>,
    _window: &tauri::WebviewWindow<R>,
    _pdf_bytes: &[u8],
    _title: &str,
) -> Result<(), String> {
    Err("Printing is not supported on this platform".to_string())
}

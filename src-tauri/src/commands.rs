//! Filesystem + app-storage commands.
//!
//! PDFs are read and written as raw IPC bodies rather than as `Vec<u8>` command
//! arguments: a JSON array of bytes costs roughly 3x the payload size and a
//! stringify/parse pass on both sides, which is very visible on a 20 MB file.
//! Reads return `ipc::Response`; writes receive `ipc::InvokeBody::Raw` and carry
//! their destination in a percent-encoded header (HTTP headers are not safe for
//! arbitrary UTF-8 filenames).

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{ipc, AppHandle, Emitter, Manager, Runtime};

use crate::license;
use crate::optimize::{self, OptimizeImageRequest, OptimizeImageResponse};

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
            .or_else(|_| std::env::var("DESKTOP_SESSION"))
            .unwrap_or_default()
            .to_lowercase();
        if de.contains("kde") || de.contains("plasma") || de.contains("lxqt") {
            "kde".to_string()
        } else if de.contains("gnome") || de.contains("unity") || de.contains("pantheon") || de.contains("cinnamon") || de.contains("mate") || de.contains("budgie") {
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

#[tauri::command]
pub fn optimize_image(req: OptimizeImageRequest) -> Result<OptimizeImageResponse, String> {
    optimize::optimize_image_buffer(req)
}

// ----------------------------------------------------------------- auto-update

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SystemTarget {
    pub os: String,
    pub arch: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DownloadUpdateArgs {
    pub download_url: String,
    pub asset_name: String,
    pub sha256_url: Option<String>,
    pub expected_sha256: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UpdateProgressPayload {
    pub loaded: u64,
    pub total: u64,
    pub percent: u32,
}

#[tauri::command]
pub fn get_system_target() -> SystemTarget {
    SystemTarget {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[tauri::command]
pub fn check_latest_release() -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(8))
        .timeout_read(std::time::Duration::from_secs(10))
        .build();

    let resp = agent
        .get("https://api.github.com/repos/nashv/VrushPDF/releases/latest")
        .set("User-Agent", "VrushPDF-App")
        .set("Accept", "application/vnd.github.v3+json")
        .call()
        .map_err(|e| format!("Release check failed: {e}"))?;

    let body = resp
        .into_string()
        .map_err(|e| format!("Could not read release response: {e}"))?;
    Ok(body)
}

fn parse_checksum_from_sums(sums_text: &str, asset_name: &str) -> Option<String> {
    for line in sums_text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() >= 2 {
            let filename = parts[1].trim_start_matches('*');
            if filename.eq_ignore_ascii_case(asset_name) {
                return Some(parts[0].trim().to_lowercase());
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn execute_platform_installer(_asset_name: &str, temp_dmg: &Path) -> Result<(), String> {
    let mount_point = std::env::temp_dir().join(format!(
        "vrushpdf_mount_{}",
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let _ = fs::create_dir_all(&mount_point);

    // Find current app bundle if running from .app
    let mut app_bundle = None;
    if let Ok(current_exe) = std::env::current_exe() {
        let mut cur = current_exe.as_path();
        while let Some(parent) = cur.parent() {
            if parent.extension().is_some_and(|ext| ext == "app") {
                app_bundle = Some(parent.to_path_buf());
                break;
            }
            cur = parent;
        }
    }

    let script = if let Some(target_app) = app_bundle {
        format!(
            r#"
            sleep 1
            hdiutil attach -nobrowse -readonly "{dmg}" -mountpoint "{mount}" || exit 1
            if [ -d "{mount}/VrushPDF.app" ]; then
                rm -rf "{target}"
                ditto "{mount}/VrushPDF.app" "{target}"
            fi
            hdiutil detach "{mount}" -force || true
            rm -f "{dmg}"
            open -a "{target}"
            "#,
            dmg = temp_dmg.display(),
            mount = mount_point.display(),
            target = target_app.display()
        )
    } else {
        format!(
            r#"
            sleep 1
            open "{dmg}"
            "#,
            dmg = temp_dmg.display()
        )
    };

    std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(&script)
        .spawn()
        .map_err(|e| format!("failed to launch updater: {e}"))?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn execute_platform_installer(asset_name: &str, temp_file: &Path) -> Result<(), String> {
    if asset_name.ends_with(".exe") {
        std::process::Command::new(temp_file)
            .arg("/S")
            .spawn()
            .map_err(|e| format!("failed to launch installer: {e}"))?;
    } else if asset_name.ends_with(".msi") {
        std::process::Command::new("msiexec")
            .args(["/i", &temp_file.to_string_lossy(), "/passive"])
            .spawn()
            .map_err(|e| format!("failed to launch msi installer: {e}"))?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn execute_platform_installer(asset_name: &str, temp_file: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(temp_file) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = fs::set_permissions(temp_file, perms);
        }
    }

    if asset_name.ends_with(".AppImage") {
        std::process::Command::new(temp_file)
            .spawn()
            .map_err(|e| format!("failed to launch AppImage: {e}"))?;
    } else if asset_name.ends_with(".deb") {
        std::process::Command::new("xdg-open")
            .arg(temp_file)
            .spawn()
            .map_err(|e| format!("failed to open deb package: {e}"))?;
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn execute_platform_installer(_asset_name: &str, _temp_file: &Path) -> Result<(), String> {
    Err("Automatic installation is not supported on this platform".to_string())
}

#[tauri::command]
pub fn download_and_install_update<R: Runtime>(
    app: AppHandle<R>,
    args: DownloadUpdateArgs,
) -> Result<(), String> {
    let expected_sha256 = match args.expected_sha256 {
        Some(h) if !h.trim().is_empty() => Some(h.trim().to_lowercase()),
        _ => {
            if let Some(sha_url) = args.sha256_url {
                match ureq::get(&sha_url)
                    .set("User-Agent", "VrushPDF-Updater")
                    .call()
                {
                    Ok(resp) => {
                        if let Ok(text) = resp.into_string() {
                            parse_checksum_from_sums(&text, &args.asset_name)
                        } else {
                            None
                        }
                    }
                    Err(_) => None,
                }
            } else {
                None
            }
        }
    };

    let temp_dir = std::env::temp_dir();
    let temp_file_path = temp_dir.join(&args.asset_name);
    let mut file = fs::File::create(&temp_file_path)
        .map_err(|e| format!("Could not create temporary file for update: {e}"))?;

    let response = ureq::get(&args.download_url)
        .set("User-Agent", "VrushPDF-Updater")
        .call()
        .map_err(|e| format!("Download request failed: {e}"))?;

    let total_bytes: u64 = response
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let mut reader = response.into_reader();
    let mut buffer = [0u8; 64 * 1024];
    let mut loaded_bytes: u64 = 0;
    let mut hasher = Sha256::new();
    let mut last_emit = std::time::Instant::now();

    loop {
        let read_bytes = reader
            .read(&mut buffer)
            .map_err(|e| format!("Failed while downloading file: {e}"))?;
        if read_bytes == 0 {
            break;
        }
        let chunk = &buffer[..read_bytes];
        hasher.update(chunk);
        file.write_all(chunk)
            .map_err(|e| format!("Failed writing update to disk: {e}"))?;
        loaded_bytes += read_bytes as u64;

        let percent = if total_bytes > 0 {
            ((loaded_bytes as f64 / total_bytes as f64) * 100.0).min(100.0) as u32
        } else {
            0
        };

        if last_emit.elapsed() > std::time::Duration::from_millis(50) || percent == 100 {
            let _ = app.emit(
                "update-progress",
                UpdateProgressPayload {
                    loaded: loaded_bytes,
                    total: if total_bytes > 0 { total_bytes } else { loaded_bytes },
                    percent,
                },
            );
            last_emit = std::time::Instant::now();
        }
    }

    let _ = file.flush();
    drop(file);

    let actual_hash = format!("{:x}", hasher.finalize());
    if let Some(expected) = expected_sha256 {
        if !actual_hash.eq_ignore_ascii_case(&expected) {
            let _ = fs::remove_file(&temp_file_path);
            return Err(format!(
                "Checksum verification failed for {}. Expected {}, computed {}",
                args.asset_name, expected, actual_hash
            ));
        }
    }

    execute_platform_installer(&args.asset_name, &temp_file_path)?;

    Ok(())
}

/// Receive downloaded update binary payload and execute platform installation.
#[tauri::command]
pub fn install_update_payload<R: Runtime>(
    _app: AppHandle<R>,
    request: ipc::Request<'_>,
) -> Result<(), String> {
    let asset_name = header(&request, "x-asset-name")?;
    let bytes = raw_body(&request)?;

    let temp_dir = std::env::temp_dir();
    let temp_file_path = temp_dir.join(&asset_name);
    fs::write(&temp_file_path, bytes).map_err(|e| format!("could not write installer: {e}"))?;

    execute_platform_installer(&asset_name, &temp_file_path)
}

#[tauri::command]
pub fn relaunch_app<R: Runtime>(app: AppHandle<R>) {
    app.restart();
}

#[cfg(test)]
mod updater_tests {
    use super::*;

    #[test]
    fn test_check_latest_release() {
        let res = check_latest_release();
        println!("Result: {:?}", res.is_ok());
        assert!(res.is_ok());
    }
}

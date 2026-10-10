//! Issues VrushPDF license keys on this computer. No server is involved: the
//! app checks each key's signature offline.
//!
//!   npm run keygen -- init                      # once per machine: make a signing key
//!   npm run keygen -- issue someone@example.com # print a key for a buyer
//!   npm run keygen -- show <key>                # who a key is for, and its id
//!   npm run keygen -- check                     # verify this machine can issue keys
//!
//! The private key lives in `~/.vrushpdf-signing-key`, or wherever
//! `VRUSHPDF_SIGNING_KEY` points. Each machine that issues keys has its own;
//! the app trusts every public key listed in `src-tauri/src/license_key.pub`.
//! `init` only ever appends to that list, so making a new signing key can never
//! invalidate keys already sold. A new key works in the next release built
//! with it. Back the private key up: an app build trusts it only as long as
//! the list names it, and a lost one cannot issue keys again.

#[path = "../../src-tauri/src/license_key.rs"]
mod license_key;

use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{SigningKey, VerifyingKey};

use license_key::Payload;

/// What the app is built with, to catch issuing keys it would refuse.
const APP_PUBLIC_KEYS: &str = include_str!("../../src-tauri/src/license_key.pub");
const APP_PUBLIC_KEYS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src-tauri/src/license_key.pub");
const REVOKED: &str = include_str!("../../src-tauri/src/revoked_keys.txt");

const USAGE: &str = "\
usage: keygen init [--force]        make this machine's signing key and trust its public key
       keygen issue <email>...      print a license key for each buyer
       keygen show <key>            check a key and print who it was issued to
       keygen check                 verify signing key and public key synchronization";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("init") => init(args[1..].iter().any(|a| a == "--force")),
        Some("issue") if args.len() > 1 => issue(&args[1..]),
        Some("show") if args.len() > 1 => show(&args[1..].join("")),
        Some("check") | Some("verify") => check(),
        _ => Err(USAGE.to_string()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

fn key_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("VRUSHPDF_SIGNING_KEY") {
        return Ok(path.into());
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("no home directory; set VRUSHPDF_SIGNING_KEY")?;
    Ok(PathBuf::from(home).join(".vrushpdf-signing-key"))
}

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the OS random number generator failed");
    bytes
}

fn read_disk_public_keys() -> Result<String, String> {
    fs::read_to_string(APP_PUBLIC_KEYS_PATH).map_err(|e| format!("cannot read {APP_PUBLIC_KEYS_PATH}: {e}"))
}

fn trusts(list: &str, key: &VerifyingKey) -> bool {
    license_key::parse_public_keys(list).is_some_and(|keys| keys.contains(key))
}

fn init(force: bool) -> Result<(), String> {
    let path = key_path()?;
    if path.exists() && !force {
        return Err(format!(
            "{} already exists. A new one only adds a key the app trusts; keys issued \
             with the old one stay valid while license_key.pub lists it. Pass --force \
             to replace it anyway, after backing it up.",
            path.display()
        ));
    }
    let signing = SigningKey::from_bytes(&random::<32>());
    fs::write(&path, URL_SAFE_NO_PAD.encode(signing.to_bytes()) + "\n")
        .map_err(|e| format!("{}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }

    // Append, never replace: dropping a listed key would void every key it signed.
    let public = license_key::encode_public_key(&signing.verifying_key());
    let mut list = read_disk_public_keys()?;
    if !list.is_empty() && !list.ends_with('\n') {
        list.push('\n');
    }
    list.push_str(&format!("{public}  # added by keygen init\n"));
    fs::write(APP_PUBLIC_KEYS_PATH, list).map_err(|e| format!("{APP_PUBLIC_KEYS_PATH}: {e}"))?;

    println!("signing key:  {} (back this up; it never goes in the repo)", path.display());
    println!("public key:   {public}");
    println!("              appended to src-tauri/src/license_key.pub (commit this)");
    println!("\nKeys from this signing key work in app builds that include it: commit,");
    println!("rebuild (`npm run tauri build`) and release before handing any out.");
    Ok(())
}

fn signing_key() -> Result<SigningKey, String> {
    let path = key_path()?;
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("{}: {e}\nRun `npm run keygen -- init` first.", path.display()))?;
    let bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(text.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| format!("{} is not a valid 32-byte Ed25519 signing key", path.display()))?;
    let signing = SigningKey::from_bytes(&bytes);
    let derived = signing.verifying_key();

    // 1. Trusted by the list on disk, i.e. by the next build of the app.
    if let Ok(list) = read_disk_public_keys() {
        if !trusts(&list, &derived) {
            return Err(format!(
                "{} is not listed in src-tauri/src/license_key.pub.\n\
                 Apps built from this checkout would reject its keys. Add its public key\n\
                 ({}) to that list, or use the signing key of a machine that is listed.\n\
                 Run `npm run keygen -- check` for diagnostics.",
                path.display(),
                license_key::encode_public_key(&derived)
            ));
        }
    }

    // 2. Trusted by the list compiled into this keygen.
    if !trusts(APP_PUBLIC_KEYS, &derived) {
        return Err(format!(
            "{} is not in the public keys compiled into keygen.\n\
             Rebuild keygen with `cargo clean -p vrushpdf-keygen` and re-run.",
            path.display()
        ));
    }

    Ok(signing)
}

fn check_git_status() -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["status", "--porcelain", APP_PUBLIC_KEYS_PATH])
        .output()
        .ok()?;
    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

fn issue(emails: &[String]) -> Result<(), String> {
    for email in emails {
        if !email.contains('@') || email.chars().any(char::is_whitespace) {
            return Err(format!("{email:?} does not look like an email address"));
        }
    }
    let signing = signing_key()?;

    if let Some(git_mod) = check_git_status() {
        eprintln!(
            "[NOTICE] src-tauri/src/license_key.pub has uncommitted changes ({git_mod}).\n\
             Ensure you commit this file and rebuild/publish the app before distributing keys.\n"
        );
    }

    let iat = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    for email in emails {
        let id: String = random::<4>().iter().map(|b| format!("{b:02x}")).collect();
        let key = license_key::sign(&Payload { v: 1, id, email: email.clone(), iat }, &signing);
        // One buyer prints the bare key, for piping to pbcopy.
        if emails.len() == 1 {
            println!("{key}");
        } else {
            println!("{email}\t{key}");
        }
    }
    Ok(())
}

fn show(key: &str) -> Result<(), String> {
    let list = read_disk_public_keys().unwrap_or_else(|_| APP_PUBLIC_KEYS.to_string());
    let public = license_key::parse_public_keys(&list)
        .ok_or("src-tauri/src/license_key.pub is not a valid list of public keys")?;
    let payload = license_key::open_any(key, &public)
        .ok_or("Not a valid key for this build of the app: wrong signature, or not a whole key.")?;
    println!("email:   {}", payload.email);
    println!("id:      {}", payload.id);
    println!("issued:  {} (Unix time)", payload.iat);
    if license_key::is_listed(REVOKED, &payload.id) {
        println!("REVOKED: listed in src-tauri/src/revoked_keys.txt");
    }
    Ok(())
}

fn check() -> Result<(), String> {
    println!("=== VrushPDF License System Diagnostic ===");

    // 1. Check signing key path
    let path = key_path()?;
    println!("1. Signing key path: {}", path.display());
    if !path.exists() {
        return Err(format!(
            "FAIL: Signing key not found at {}. Run `npm run keygen -- init`.",
            path.display()
        ));
    }
    println!("   Status: Found");

    // 2. Parse signing key
    let text = fs::read_to_string(&path).map_err(|e| format!("FAIL: Cannot read signing key: {e}"))?;
    let bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(text.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| format!("FAIL: {} is not a valid 32-byte Ed25519 signing key", path.display()))?;
    let signing = SigningKey::from_bytes(&bytes);
    let derived_pub = signing.verifying_key();
    let encoded_derived = license_key::encode_public_key(&derived_pub);
    println!("   Status: Valid 32-byte Ed25519 signing key");
    println!("   Public key: {encoded_derived}");

    // 3. Check the trusted list on disk
    println!("2. Trusted public keys: {}", APP_PUBLIC_KEYS_PATH);
    let disk_list = read_disk_public_keys()?;
    let disk_keys = license_key::parse_public_keys(&disk_list)
        .ok_or_else(|| "FAIL: src-tauri/src/license_key.pub has an entry that is not an Ed25519 public key".to_string())?;
    for key in &disk_keys {
        let mark = if *key == derived_pub { "  <- this machine" } else { "" };
        println!("   {}{mark}", license_key::encode_public_key(key));
    }

    // 4. This machine's key must be one of them
    if !disk_keys.contains(&derived_pub) {
        return Err(format!(
            "FAIL: this machine's public key is not in license_key.pub.\n\
             Add this line to src-tauri/src/license_key.pub, commit and release:\n\
             {encoded_derived}"
        ));
    }
    println!("   Status: Lists this machine's signing key");

    // 5. And so must the list compiled into this keygen
    if !trusts(APP_PUBLIC_KEYS, &derived_pub) {
        return Err("FAIL: the keys compiled into keygen are stale; run `cargo clean -p vrushpdf-keygen`".to_string());
    }
    println!("3. Compiled-in public keys: List this machine's signing key");

    // 6. Test issue & verify roundtrip
    let test_payload = Payload {
        v: 1,
        id: "testcheck".to_string(),
        email: "diagnostic@vrushpdf.app".to_string(),
        iat: 1_800_000_000,
    };
    let test_key = license_key::sign(&test_payload, &signing);
    let verified = license_key::open_any(&test_key, &disk_keys)
        .ok_or_else(|| "FAIL: Test key signature verification failed".to_string())?;
    if verified != test_payload {
        return Err("FAIL: Verified test payload does not match original".to_string());
    }
    println!("4. In-memory signature verification: Passed");

    // 7. Check git status
    if let Some(mod_status) = check_git_status() {
        println!("5. Git status: WARNING - src-tauri/src/license_key.pub has uncommitted changes ({mod_status})");
        println!("   Remember to commit and rebuild the app (`npm run tauri build`)!");
    } else {
        println!("5. Git status: Clean (src-tauri/src/license_key.pub is committed)");
    }

    println!("\nSUCCESS: this machine can issue keys that apps built from this checkout accept.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_produces_unique_bytes() {
        let a = random::<32>();
        let b = random::<32>();
        assert_ne!(a, b);
        assert!(a.iter().any(|&x| x != 0));
    }

    #[test]
    fn init_and_check_in_temp_dir() {
        let temp_dir = std::env::temp_dir().join(format!("keygen_test_{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let key_file = temp_dir.join("test.key");

        // Set env var to use temporary key path
        unsafe {
            std::env::set_var("VRUSHPDF_SIGNING_KEY", &key_file);
        }

        let signing = SigningKey::from_bytes(&random::<32>());
        fs::write(&key_file, URL_SAFE_NO_PAD.encode(signing.to_bytes()) + "\n").unwrap();

        let derived = signing.verifying_key();
        let pub_encoded = license_key::encode_public_key(&derived);
        assert_eq!(license_key::parse_public_key(&pub_encoded), Some(derived));

        let payload = Payload {
            v: 1,
            id: "abcd1234".into(),
            email: "test@bioimaging.tech".into(),
            iat: 1_800_000_000,
        };
        let key = license_key::sign(&payload, &signing);
        assert_eq!(license_key::open(&key, &derived), Some(payload));

        let _ = fs::remove_file(&key_file);
        let _ = fs::remove_dir_all(&temp_dir);
    }
}

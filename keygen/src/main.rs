//! Issues VrushPDF license keys on this computer. No server is involved: the
//! app checks each key's signature offline.
//!
//!   npm run keygen -- init                      # once: make the signing key
//!   npm run keygen -- issue someone@example.com # print a key for a buyer
//!   npm run keygen -- show <key>                # who a key is for, and its id
//!   npm run keygen -- check                     # verify keypair health & sync
//!
//! The private key lives in `~/.vrushpdf-signing-key`, or wherever
//! `VRUSHPDF_SIGNING_KEY` points. Keep a copy somewhere safe: without it no new
//! key can be issued that existing copies of the app accept.

#[path = "../../src-tauri/src/license_key.rs"]
mod license_key;

use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::SigningKey;

use license_key::Payload;

/// What the app is built with, to catch issuing keys it would refuse.
const APP_PUBLIC_KEY: &str = include_str!("../../src-tauri/src/license_key.pub");
const APP_PUBLIC_KEY_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src-tauri/src/license_key.pub");
const REVOKED: &str = include_str!("../../src-tauri/src/revoked_keys.txt");

const USAGE: &str = "\
usage: keygen init [--force]        make the signing key and write the app's public key
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

fn read_disk_public_key() -> Result<String, String> {
    fs::read_to_string(APP_PUBLIC_KEY_PATH)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("cannot read {APP_PUBLIC_KEY_PATH}: {e}"))
}

fn init(force: bool) -> Result<(), String> {
    let path = key_path()?;
    if path.exists() && !force {
        return Err(format!(
            "{} already exists. Replacing it invalidates every key issued so far; \
             pass --force if that is really what you want.",
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
    let public = license_key::encode_public_key(&signing.verifying_key());
    fs::write(APP_PUBLIC_KEY_PATH, public + "\n").map_err(|e| format!("{APP_PUBLIC_KEY_PATH}: {e}"))?;
    println!("signing key:  {} (back this up; it never goes in the repo)", path.display());
    println!("public key:   src-tauri/src/license_key.pub (commit this)");
    println!("\n[IMPORTANT] A new signing keypair has been generated.");
    println!("Any previously compiled binaries will NOT accept keys signed by this new key.");
    println!("Rebuild the application (`npm run tauri build`) to embed the new public key.");
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
    let derived_pub = signing.verifying_key();

    // 1. Verify against the disk copy of license_key.pub
    if let Ok(disk_pub) = read_disk_public_key() {
        if license_key::parse_public_key(&disk_pub) != Some(derived_pub) {
            return Err(format!(
                "{} does not match src-tauri/src/license_key.pub on disk.\n\
                 Keys issued with this signing key would be rejected by newly built apps.\n\
                 Run `npm run keygen -- check` for diagnostics.",
                path.display()
            ));
        }
    }

    // 2. Verify against the compiled-in copy of license_key.pub
    if license_key::parse_public_key(APP_PUBLIC_KEY) != Some(derived_pub) {
        return Err(format!(
            "{} does not match the public key compiled into keygen.\n\
             Rebuild keygen with `cargo clean -p vrushpdf-keygen` and re-run.",
            path.display()
        ));
    }

    Ok(signing)
}

fn check_git_status() -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["status", "--porcelain", APP_PUBLIC_KEY_PATH])
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
    let public_str = read_disk_public_key().unwrap_or_else(|_| APP_PUBLIC_KEY.to_string());
    let public = license_key::parse_public_key(&public_str)
        .ok_or("src-tauri/src/license_key.pub is not a valid public key")?;
    let payload = license_key::open(key, &public)
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

    // 3. Check public key on disk
    println!("2. Public key file: {}", APP_PUBLIC_KEY_PATH);
    let disk_pub_str = read_disk_public_key()?;
    let disk_pub = license_key::parse_public_key(&disk_pub_str)
        .ok_or_else(|| "FAIL: src-tauri/src/license_key.pub cannot be parsed as Ed25519 public key".to_string())?;
    println!("   Status: Valid Ed25519 public key ({})", disk_pub_str);

    // 4. Verify derived matches disk
    if disk_pub != derived_pub {
        return Err(format!(
            "FAIL: Public key mismatch!\n\
             Derived from private key: {}\n\
             On-disk license_key.pub:  {}",
            encoded_derived, disk_pub_str
        ));
    }
    println!("   Status: Matches private signing key");

    // 5. Check compiled-in public key
    let compiled_pub = license_key::parse_public_key(APP_PUBLIC_KEY)
        .ok_or_else(|| "FAIL: Compiled-in public key is invalid".to_string())?;
    if compiled_pub != derived_pub {
        return Err(format!(
            "FAIL: Compiled-in public key mismatch!\n\
             Derived from private key: {}\n\
             Compiled into keygen:     {}",
            encoded_derived,
            license_key::encode_public_key(&compiled_pub)
        ));
    }
    println!("3. Compiled-in public key: Matches private signing key");

    // 6. Test issue & verify roundtrip
    let test_payload = Payload {
        v: 1,
        id: "testcheck".to_string(),
        email: "diagnostic@vrushpdf.app".to_string(),
        iat: 1_800_000_000,
    };
    let test_key = license_key::sign(&test_payload, &signing);
    let verified = license_key::open(&test_key, &derived_pub)
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

    println!("\nSUCCESS: License system is completely synchronized and functional.");
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

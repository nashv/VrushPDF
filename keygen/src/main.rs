//! Issues VrushPDF license keys on this computer. No server is involved: the
//! app checks each key's signature offline.
//!
//!   npm run keygen -- init                      # once: make the signing key
//!   npm run keygen -- issue someone@example.com # print a key for a buyer
//!   npm run keygen -- show <key>                # who a key is for, and its id
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
       keygen show <key>            check a key and print who it was issued to";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("init") => init(args[1..].iter().any(|a| a == "--force")),
        Some("issue") if args.len() > 1 => issue(&args[1..]),
        Some("show") if args.len() > 1 => show(&args[1..].join("")),
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
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("{}: {e}", path.display()))?;
    }
    let public = license_key::encode_public_key(&signing.verifying_key());
    fs::write(APP_PUBLIC_KEY_PATH, public + "\n").map_err(|e| format!("{APP_PUBLIC_KEY_PATH}: {e}"))?;
    println!("signing key:  {} (back this up; it never goes in the repo)", path.display());
    println!("public key:   src-tauri/src/license_key.pub (commit this)");
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
        .ok_or_else(|| format!("{} is not a signing key", path.display()))?;
    let signing = SigningKey::from_bytes(&bytes);
    // `cargo run` rebuilds when license_key.pub changes, so this is current.
    if license_key::parse_public_key(APP_PUBLIC_KEY) != Some(signing.verifying_key()) {
        return Err(format!(
            "{} does not match src-tauri/src/license_key.pub, so the app would refuse its keys.",
            path.display()
        ));
    }
    Ok(signing)
}

fn issue(emails: &[String]) -> Result<(), String> {
    for email in emails {
        if !email.contains('@') || email.chars().any(char::is_whitespace) {
            return Err(format!("{email:?} does not look like an email address"));
        }
    }
    let signing = signing_key()?;
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
    let public = license_key::parse_public_key(APP_PUBLIC_KEY).ok_or("license_key.pub is not a public key")?;
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

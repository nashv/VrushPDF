//! Command-line front end to the keygen library (`lib.rs`); `keygen-gui` is the
//! windowed one. No server is involved: the app checks each key's signature
//! offline.
//!
//!   npm run keygen -- init                        # once per machine: make a signing key
//!   npm run keygen -- issue someone@example.com   # print a key for a buyer, and record it
//!   npm run keygen -- show <key>                  # who a key is for, its id, whether revoked
//!   npm run keygen -- list                        # every recorded key
//!   npm run keygen -- revoke <id|key> [reason]    # refuse a key from the next release on
//!   npm run keygen -- restore <id>                # undo a revocation
//!   npm run keygen -- check                       # verify this machine can issue keys

use std::process::ExitCode;

use vrushpdf_keygen::{self as keygen, date, Ledger, Paths};

const USAGE: &str = "\
usage: keygen init [--force]                make this machine's signing key and trust its public key
       keygen issue <email>... [--note T]   print a license key for each buyer, and record it
       keygen show <key>                    check a key and print who it was issued to
       keygen list                          list every recorded key
       keygen revoke <id|key> [reason]      add a key to the revocation list
       keygen restore <id>                  take a key off the revocation list
       keygen check                         verify this machine can issue keys the app accepts";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = Paths::standard().and_then(|paths| run(&paths, &args));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

fn run(paths: &Paths, args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("init") => init(paths, args[1..].iter().any(|a| a == "--force")),
        Some("issue") if args.len() > 1 => issue(paths, &args[1..]),
        Some("show") if args.len() > 1 => show(paths, &args[1..].join("")),
        Some("list") => list(paths),
        Some("revoke") if args.len() > 1 => revoke(paths, &args[1], &args[2..].join(" ")),
        Some("restore") if args.len() > 1 => {
            keygen::restore(paths, &args[1])?;
            println!("{} is no longer revoked (from the next release on).", args[1]);
            Ok(())
        }
        Some("check") | Some("verify") => check(paths),
        _ => Err(USAGE.to_string()),
    }
}

fn init(paths: &Paths, force: bool) -> Result<(), String> {
    let public = keygen::init(paths, force)?;
    println!("signing key:  {} (back this up; it never goes in the repo)", paths.signing_key.display());
    println!("public key:   {public}");
    println!("              appended to src-tauri/src/license_key.pub (commit this)");
    println!("\nKeys from this signing key work in app builds that include it: commit,");
    println!("rebuild (`npm run tauri build`) and release before handing any out.");
    Ok(())
}

fn issue(paths: &Paths, args: &[String]) -> Result<(), String> {
    let mut emails = Vec::new();
    let mut note = String::new();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        if arg == "--note" {
            note = rest.next().cloned().ok_or("--note needs a value")?;
        } else {
            emails.push(arg.clone());
        }
    }
    if let Some(bad) = emails.iter().find(|e| !keygen::valid_email(e)) {
        return Err(format!("{bad:?} does not look like an email address"));
    }
    for email in &emails {
        let issued = keygen::issue(paths, email, &note)?;
        // One buyer prints the bare key, for piping to pbcopy.
        if emails.len() == 1 {
            println!("{}", issued.key);
        } else {
            println!("{}\t{}", issued.email, issued.key);
        }
    }
    Ok(())
}

fn show(paths: &Paths, key: &str) -> Result<(), String> {
    let seen = keygen::inspect(paths, key)?;
    println!("email:   {}", seen.payload.email);
    println!("id:      {}", seen.payload.id);
    println!("issued:  {} (Unix time {})", date(seen.payload.iat), seen.payload.iat);
    println!("signer:  {}", seen.signer);
    if let Some(note) = seen.recorded.as_ref().map(|r| &r.note).filter(|n| !n.is_empty()) {
        println!("note:    {note}");
    }
    if seen.recorded.is_none() {
        println!("ledger:  not recorded (issued before the ledger, or on another machine)");
    }
    if seen.revoked {
        println!("REVOKED: listed in src-tauri/src/revoked_keys.txt");
    }
    Ok(())
}

fn list(paths: &Paths) -> Result<(), String> {
    let ledger = Ledger::load(paths)?;
    if ledger.keys.is_empty() {
        println!("No keys recorded yet.");
    }
    for k in &ledger.keys {
        let status = match &k.revoked {
            Some(r) => format!("REVOKED {}{}", date(r.at), if r.reason.is_empty() { String::new() } else { format!(" ({})", r.reason) }),
            None => "valid".into(),
        };
        let note = if k.note.is_empty() { String::new() } else { format!("  [{}]", k.note) };
        println!("{}  {}  {:<36} {status}{note}", date(k.issued_at), k.id, k.email);
    }
    Ok(())
}

fn revoke(paths: &Paths, target: &str, reason: &str) -> Result<(), String> {
    let id = keygen::id_of(paths, target).ok_or("give a key id (8 hex digits) or a whole valid key")?;
    keygen::revoke(paths, &id, reason)?;
    println!("Revoked {id}. Commit src-tauri/src/revoked_keys.txt and keygen/issued-keys.json;");
    println!("the key stops working in the next release.");
    Ok(())
}

fn check(paths: &Paths) -> Result<(), String> {
    println!("=== VrushPDF license system ===");
    let checks = keygen::diagnose(paths);
    for c in &checks {
        println!("{} {:<24} {}", if c.ok { "ok  " } else { "FAIL" }, c.label, c.detail);
    }
    if checks.iter().all(|c| c.ok) {
        println!("\nThis machine can issue keys that apps built from this checkout accept.");
        Ok(())
    } else {
        Err("\nFix the failing check above before issuing keys.".into())
    }
}

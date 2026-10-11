//! Issuing, checking and revoking VrushPDF license keys, offline. Shared by
//! the `keygen` command line and the `keygen-gui` app, so both behave the
//! same way.
//!
//! The private key lives in `~/.vrushpdf-signing-key`, or wherever
//! `VRUSHPDF_SIGNING_KEY` points. Each machine that issues keys has its own;
//! the app trusts every public key listed in `src-tauri/src/license_key.pub`.
//! `init` only ever appends to that list, so making a new signing key can never
//! invalidate keys already sold. A new key works in the next release built
//! with it.
//!
//! Every issued key is recorded in `keygen/issued-keys.json` (the ledger),
//! which lives in the private repo so both machines see all keys. Revoking a
//! key adds its id to `src-tauri/src/revoked_keys.txt`; the app refuses it from
//! the next release on.

#[path = "../../src-tauri/src/license_key.rs"]
pub mod license_key;

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

pub use license_key::Payload;

/// What this build of the tools trusts, to catch issuing keys the app would refuse.
pub const COMPILED_PUBLIC_KEYS: &str = include_str!("../../src-tauri/src/license_key.pub");

const REPO_PUBLIC_KEYS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src-tauri/src/license_key.pub");
const REPO_REVOKED: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src-tauri/src/revoked_keys.txt");
const REPO_LEDGER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/issued-keys.json");

/// The files the tools read and write. Tests point these at a temp dir.
#[derive(Debug, Clone)]
pub struct Paths {
    pub signing_key: PathBuf,
    pub public_keys: PathBuf,
    pub revoked: PathBuf,
    pub ledger: PathBuf,
}

impl Paths {
    /// The real locations: the signing key in the home folder, the rest in the repo.
    pub fn standard() -> Result<Self, String> {
        let signing_key = match std::env::var_os("VRUSHPDF_SIGNING_KEY") {
            Some(path) => path.into(),
            None => {
                let home = std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .ok_or("no home directory; set VRUSHPDF_SIGNING_KEY")?;
                PathBuf::from(home).join(".vrushpdf-signing-key")
            }
        };
        Ok(Self {
            signing_key,
            public_keys: REPO_PUBLIC_KEYS.into(),
            revoked: REPO_REVOKED.into(),
            ledger: REPO_LEDGER.into(),
        })
    }

    /// Whether these are the repo's own files, which the tools are built with.
    pub fn is_repo(&self) -> bool {
        self.public_keys == PathBuf::from(REPO_PUBLIC_KEYS)
    }
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// `YYYY-MM-DD` for a Unix time, without pulling in a date crate.
pub fn date(unix: u64) -> String {
    // Howard Hinnant's days-to-civil algorithm.
    let days = (unix / 86_400) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the OS random number generator failed");
    bytes
}

fn read(path: &PathBuf) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))
}

fn write(path: &PathBuf, text: &str) -> Result<(), String> {
    fs::write(path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Short form of a public key, for showing which machine signed something.
pub fn short_key(key: &VerifyingKey) -> String {
    license_key::encode_public_key(key)[..8].to_string()
}

// ------------------------------------------------------------------ keys

/// The signing key on this machine, parsed but not yet checked against the list.
pub fn read_signing_key(paths: &Paths) -> Result<SigningKey, String> {
    let text = read(&paths.signing_key).map_err(|e| format!("{e}\nMake one with `init`."))?;
    let bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(text.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| format!("{} is not a valid 32-byte Ed25519 signing key", paths.signing_key.display()))?;
    Ok(SigningKey::from_bytes(&bytes))
}

/// The public keys the app trusts, from the repo's list.
pub fn trusted_keys(paths: &Paths) -> Result<Vec<VerifyingKey>, String> {
    license_key::parse_public_keys(&read(&paths.public_keys)?)
        .ok_or_else(|| format!("{} has an entry that is not an Ed25519 public key", paths.public_keys.display()))
}

/// The signing key, refused unless the app would accept what it signs.
pub fn signing_key(paths: &Paths) -> Result<SigningKey, String> {
    let signing = read_signing_key(paths)?;
    let public = signing.verifying_key();
    if !trusted_keys(paths)?.contains(&public) {
        return Err(format!(
            "This machine's signing key is not listed in license_key.pub, so apps built from \
             this checkout would reject its keys. Add its public key ({}) to that list, or use \
             the signing key of a machine that is listed.",
            license_key::encode_public_key(&public)
        ));
    }
    Ok(signing)
}

/// Make this machine's signing key and trust its public key. Returns the public key.
pub fn init(paths: &Paths, force: bool) -> Result<String, String> {
    if paths.signing_key.exists() && !force {
        return Err(format!(
            "{} already exists. A new one only adds a key the app trusts; keys issued with the \
             old one stay valid while license_key.pub lists it. Back it up and pass --force to \
             replace it anyway.",
            paths.signing_key.display()
        ));
    }
    let signing = SigningKey::from_bytes(&random::<32>());
    write(&paths.signing_key, &(URL_SAFE_NO_PAD.encode(signing.to_bytes()) + "\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&paths.signing_key, fs::Permissions::from_mode(0o600));
    }
    // Append, never replace: dropping a listed key would void every key it signed.
    let public = license_key::encode_public_key(&signing.verifying_key());
    let mut list = read(&paths.public_keys)?;
    if !list.is_empty() && !list.ends_with('\n') {
        list.push('\n');
    }
    list.push_str(&format!("{public}  # added by keygen init {}\n", date(now())));
    write(&paths.public_keys, &list)?;
    Ok(public)
}

// ---------------------------------------------------------------- ledger

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revocation {
    /// Unix time it was revoked.
    pub at: u64,
    pub reason: String,
}

/// One issued key, as recorded in the ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Issued {
    pub id: String,
    pub email: String,
    /// Unix time it was issued.
    pub issued_at: u64,
    /// The whole key, so it can be sent again.
    pub key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    /// First characters of the signing machine's public key.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub signer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked: Option<Revocation>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Ledger {
    pub keys: Vec<Issued>,
}

impl Ledger {
    /// The ledger on disk; none yet is an empty one.
    pub fn load(paths: &Paths) -> Result<Self, String> {
        if !paths.ledger.exists() {
            return Ok(Self::default());
        }
        serde_json::from_str(&read(&paths.ledger)?)
            .map_err(|e| format!("{} is not a valid ledger: {e}", paths.ledger.display()))
    }

    pub fn save(&mut self, paths: &Paths) -> Result<(), String> {
        self.keys.sort_by(|a, b| a.issued_at.cmp(&b.issued_at).then(a.id.cmp(&b.id)));
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        write(&paths.ledger, &(text + "\n"))
    }

    pub fn find(&self, id: &str) -> Option<&Issued> {
        self.keys.iter().find(|k| k.id == id)
    }
}

// ----------------------------------------------------------------- issue

pub fn valid_email(email: &str) -> bool {
    let email = email.trim();
    let Some((user, domain)) = email.split_once('@') else { return false };
    !user.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
        && !email.chars().any(char::is_whitespace)
}

/// Sign a key for `email` and record it in the ledger.
pub fn issue(paths: &Paths, email: &str, note: &str) -> Result<Issued, String> {
    let email = email.trim();
    if !valid_email(email) {
        return Err(format!("{email:?} does not look like an email address"));
    }
    let signing = signing_key(paths)?;
    let mut ledger = Ledger::load(paths)?;
    // Ids are 4 random bytes; draw again on the rare collision.
    let id = loop {
        let id: String = random::<4>().iter().map(|b| format!("{b:02x}")).collect();
        if ledger.find(&id).is_none() {
            break id;
        }
    };
    let issued_at = now();
    let key = license_key::sign(&Payload { v: 1, id: id.clone(), email: email.to_string(), iat: issued_at }, &signing);
    let issued = Issued {
        id,
        email: email.to_string(),
        issued_at,
        key,
        note: note.trim().to_string(),
        signer: short_key(&signing.verifying_key()),
        revoked: None,
    };
    ledger.keys.push(issued.clone());
    ledger.save(paths)?;
    Ok(issued)
}

// ----------------------------------------------------------------- check

/// What a pasted key turns out to be.
#[derive(Debug, Clone)]
pub struct Inspection {
    pub payload: Payload,
    /// Which trusted key signed it.
    pub signer: String,
    pub revoked: bool,
    pub recorded: Option<Issued>,
}

/// Check a key against the trusted keys, the revocation list and the ledger.
pub fn inspect(paths: &Paths, key: &str) -> Result<Inspection, String> {
    let trusted = trusted_keys(paths)?;
    let signer = trusted
        .iter()
        .find(|k| license_key::open(key, k).is_some())
        .ok_or("Not a valid key for this app: wrong signature, or not a whole key.")?;
    let payload = license_key::open(key, signer).expect("checked above");
    Ok(Inspection {
        signer: short_key(signer),
        revoked: is_revoked(paths, &payload.id),
        recorded: Ledger::load(paths)?.find(&payload.id).cloned(),
        payload,
    })
}

// ---------------------------------------------------------------- revoke

/// Whether `id` is on the revocation list in the repo.
pub fn is_revoked(paths: &Paths, id: &str) -> bool {
    read(&paths.revoked).is_ok_and(|list| license_key::is_listed(&list, id))
}

/// The key id in `input`: a whole valid key, or an 8-hex-digit id.
pub fn id_of(paths: &Paths, input: &str) -> Option<String> {
    let input = input.trim();
    if input.len() == 8 && input.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(input.to_ascii_lowercase());
    }
    inspect(paths, input).ok().map(|i| i.payload.id)
}

/// Add `id` to the revocation list, with who it was for and why, and mark it in the ledger.
pub fn revoke(paths: &Paths, id: &str, reason: &str) -> Result<(), String> {
    let id = id.trim().to_ascii_lowercase();
    if id.is_empty() {
        return Err("no key id given".into());
    }
    let mut ledger = Ledger::load(paths)?;
    let reason = reason.trim();
    if !is_revoked(paths, &id) {
        let email = ledger.find(&id).map(|k| k.email.clone()).unwrap_or_default();
        let comment = [email.as_str(), reason, &date(now())].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" — ");
        let mut list = read(&paths.revoked)?;
        if !list.is_empty() && !list.ends_with('\n') {
            list.push('\n');
        }
        list.push_str(&format!("{id}  # {comment}\n"));
        write(&paths.revoked, &list)?;
    }
    if let Some(entry) = ledger.keys.iter_mut().find(|k| k.id == id) {
        entry.revoked = Some(Revocation { at: now(), reason: reason.to_string() });
        ledger.save(paths)?;
    }
    Ok(())
}

/// Take `id` off the revocation list again, e.g. after a revocation by mistake.
pub fn restore(paths: &Paths, id: &str) -> Result<(), String> {
    let id = id.trim().to_ascii_lowercase();
    let list = read(&paths.revoked)?;
    let kept: Vec<&str> = list
        .lines()
        .filter(|line| line.split('#').next().unwrap_or("").trim() != id)
        .collect();
    let mut text = kept.join("\n");
    text.push('\n');
    write(&paths.revoked, &text)?;
    let mut ledger = Ledger::load(paths)?;
    if let Some(entry) = ledger.keys.iter_mut().find(|k| k.id == id) {
        entry.revoked = None;
        ledger.save(paths)?;
    }
    Ok(())
}

// ------------------------------------------------------------- diagnose

/// One line of the health check.
#[derive(Debug, Clone)]
pub struct Check {
    pub label: String,
    pub ok: bool,
    pub detail: String,
}

/// Can this machine issue keys the app accepts? Stops at the first failure
/// that makes the rest meaningless.
pub fn diagnose(paths: &Paths) -> Vec<Check> {
    let mut out = Vec::new();
    let mut push = |label: &str, ok: bool, detail: String| out.push(Check { label: label.into(), ok, detail });

    let signing = match read_signing_key(paths) {
        Ok(k) => {
            push("Signing key", true, format!("{} ({})", paths.signing_key.display(), short_key(&k.verifying_key())));
            k
        }
        Err(e) => {
            push("Signing key", false, e);
            return out;
        }
    };
    let public = signing.verifying_key();
    match trusted_keys(paths) {
        Ok(keys) if keys.contains(&public) => {
            push("Trusted by the app", true, format!("listed in license_key.pub among {} key(s)", keys.len()))
        }
        Ok(_) => push(
            "Trusted by the app",
            false,
            format!("add {} to license_key.pub, then release", license_key::encode_public_key(&public)),
        ),
        Err(e) => push("Trusted by the app", false, e),
    }
    // Only the repo's list is compiled in; elsewhere (tests) there's nothing to compare.
    if paths.is_repo() {
        let compiled = license_key::parse_public_keys(COMPILED_PUBLIC_KEYS).is_some_and(|k| k.contains(&public));
        push(
            "Built into these tools",
            compiled,
            if compiled { "matches the list".into() } else { "stale; rebuild the keygen".into() },
        );
    }
    let test = Payload { v: 1, id: "selftest".into(), email: "diagnostic@vrushpdf.app".into(), iat: 1_800_000_000 };
    let round_trip = license_key::open(&license_key::sign(&test, &signing), &public) == Some(test);
    push("Sign and verify", round_trip, if round_trip { "a test key checks out".into() } else { "a test key failed to verify".into() });
    match Ledger::load(paths) {
        Ok(ledger) => {
            let revoked = ledger.keys.iter().filter(|k| k.revoked.is_some()).count();
            push("Ledger", true, format!("{} key(s), {revoked} revoked", ledger.keys.len()));
        }
        Err(e) => push("Ledger", false, e),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway set of files with a trusted signing key.
    fn sandbox(name: &str) -> Paths {
        let dir = std::env::temp_dir().join(format!("keygen-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let paths = Paths {
            signing_key: dir.join("signing-key"),
            public_keys: dir.join("license_key.pub"),
            revoked: dir.join("revoked_keys.txt"),
            ledger: dir.join("issued-keys.json"),
        };
        fs::write(&paths.public_keys, "# trusted\n").unwrap();
        fs::write(&paths.revoked, "# revoked\n").unwrap();
        init(&paths, false).unwrap();
        paths
    }

    #[test]
    fn issued_keys_verify_and_are_recorded() {
        let paths = sandbox("issue");
        let issued = issue(&paths, " buyer@example.com ", "invoice 42").unwrap();
        let seen = inspect(&paths, &issued.key).unwrap();
        assert_eq!(seen.payload.email, "buyer@example.com");
        assert!(!seen.revoked);
        assert_eq!(seen.recorded.as_ref().map(|r| r.note.as_str()), Some("invoice 42"));
        assert_eq!(Ledger::load(&paths).unwrap().keys, vec![issued]);
    }

    #[test]
    fn revoking_lists_the_id_and_restoring_unlists_it() {
        let paths = sandbox("revoke");
        let issued = issue(&paths, "buyer@example.com", "").unwrap();
        revoke(&paths, &issued.id, "refund").unwrap();
        assert!(is_revoked(&paths, &issued.id));
        assert!(inspect(&paths, &issued.key).unwrap().revoked);
        let list = fs::read_to_string(&paths.revoked).unwrap();
        assert!(list.contains("buyer@example.com — refund"), "{list}");
        assert_eq!(Ledger::load(&paths).unwrap().keys[0].revoked.as_ref().unwrap().reason, "refund");

        // Revoking twice doesn't list it twice.
        revoke(&paths, &issued.id, "again").unwrap();
        assert_eq!(fs::read_to_string(&paths.revoked).unwrap().matches(&issued.id).count(), 1);

        restore(&paths, &issued.id).unwrap();
        assert!(!is_revoked(&paths, &issued.id));
        assert!(Ledger::load(&paths).unwrap().keys[0].revoked.is_none());
        assert!(fs::read_to_string(&paths.revoked).unwrap().starts_with("# revoked"));
    }

    #[test]
    fn keys_from_untrusted_machines_are_refused() {
        let paths = sandbox("untrusted");
        fs::write(&paths.public_keys, format!("{}\n", license_key::encode_public_key(&SigningKey::from_bytes(&[9; 32]).verifying_key()))).unwrap();
        assert!(issue(&paths, "a@b.co", "").unwrap_err().contains("not listed"));
        assert!(!diagnose(&paths)[1].ok);
    }

    #[test]
    fn ids_come_from_keys_or_hex() {
        let paths = sandbox("ids");
        let issued = issue(&paths, "a@b.co", "").unwrap();
        assert_eq!(id_of(&paths, &issued.key), Some(issued.id.clone()));
        assert_eq!(id_of(&paths, "DEADBEEF"), Some("deadbeef".into()));
        assert_eq!(id_of(&paths, "nonsense"), None);
    }

    #[test]
    fn emails_and_dates() {
        assert!(valid_email("reinders@ifado.de"));
        for bad in ["", "a@b", "@b.co", "a b@c.de", "a@.de", "a@de."] {
            assert!(!valid_email(bad), "{bad}");
        }
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(1_791_718_580), "2026-10-11");
    }
}

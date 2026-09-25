//! License keys and the 14-day trial, entirely offline.
//!
//! A license key is signed by the keygen (`keygen/`) and carries the buyer's
//! email; see `license_key.rs` for the format. The app checks the signature
//! against the public half compiled in from `license_key.pub`, every time it
//! asks, so editing `license.json` by hand gets nowhere. Nothing here touches
//! the network. A key that has to stop working (a refund, a leak) goes in
//! `revoked_keys.txt` and stops working in the next release.
//!
//! The trial starts on first launch and is kept in `license.json`, along with
//! the latest time seen, so winding the clock back cannot stretch it.
//!
//! None of this survives someone patching the binary, and it is not meant to:
//! it keeps honest people honest, and the email in the key makes sharing it
//! personal.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};

use crate::license_key;
use crate::settings;

const LICENSE_FILE: &str = "license.json";
const TRIAL_DAYS: u64 = 14;
const DAY: u64 = 86_400;

/// The Paddle hosted checkout. Set `VRUSHPDF_BUY_URL` at build time to change it.
pub const BUY_URL: &str = match option_env!("VRUSHPDF_BUY_URL") {
    Some(url) => url,
    None => "https://vrushpdf.app/buy",
};

/// The keygen's public key. Written by `npm run keygen -- init`.
const PUBLIC_KEY: &str = include_str!("license_key.pub");
const REVOKED: &str = include_str!("revoked_keys.txt");

fn verifying_key() -> VerifyingKey {
    license_key::parse_public_key(PUBLIC_KEY).expect("license_key.pub is not an Ed25519 public key")
}

// -------------------------------------------------------------------- storage

/// `license.json`, next to `settings.json`. Fields from older versions (leases,
/// machine ids) are ignored.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Stored {
    /// The whole key, whitespace removed, once one has been entered here.
    key: Option<String>,
    /// When the trial began.
    local_trial_start: Option<u64>,
    /// Latest wall-clock time seen, so winding the clock back cannot stretch
    /// the trial.
    last_seen: u64,
}

/// Serialises every read-modify-write of the file.
static LOCK: Mutex<()> = Mutex::new(());

fn license_path() -> Option<PathBuf> {
    Some(settings::config_dir()?.join(LICENSE_FILE))
}

fn load() -> Stored {
    license_path()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn store(stored: &Stored) -> Result<(), String> {
    let path = license_path().ok_or("no config directory")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
    // Written aside and renamed, so a crash mid-write cannot lose a license.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Load, change, save, under the lock.
fn update<T>(f: impl FnOnce(&mut Stored) -> T) -> T {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut stored = load();
    let before = serde_json::to_value(&stored).ok();
    let out = f(&mut stored);
    if serde_json::to_value(&stored).ok() != before {
        if let Err(err) = store(&stored) {
            eprintln!("license: could not save: {err}");
        }
    }
    out
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// --------------------------------------------------------------------- status

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Licensed,
    Trial,
    Expired,
    Revoked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: State,
    /// Whole days left in the trial, rounded up; only while on trial.
    pub days_left: Option<u64>,
    pub email: Option<String>,
    /// The key's short id, for display and support.
    pub key_id: Option<String>,
    pub buy_url: &'static str,
}

impl Status {
    pub fn can_edit(&self) -> bool {
        matches!(self.state, State::Licensed | State::Trial)
    }
}

/// The license state implied by `stored` at time `now`. Pure, for the tests.
fn evaluate(stored: &Stored, now: u64, key: &VerifyingKey, revoked: &str) -> Status {
    let now = now.max(stored.last_seen);
    let status = |state, days_left| Status { state, days_left, email: None, key_id: None, buy_url: BUY_URL };

    if let Some(payload) = stored.key.as_deref().and_then(|k| license_key::open(k, key)) {
        let state = if license_key::is_listed(revoked, &payload.id) { State::Revoked } else { State::Licensed };
        return Status { email: Some(payload.email), key_id: Some(payload.id), ..status(state, None) };
    }

    // Never started; `status()` starts it before asking.
    let exp = stored.local_trial_start.unwrap_or(now) + TRIAL_DAYS * DAY;
    if now < exp {
        status(State::Trial, Some((exp - now).div_ceil(DAY)))
    } else {
        status(State::Expired, None)
    }
}

/// The current license state. Starts the trial clock on first call.
pub fn status() -> Status {
    update(|stored| {
        let t = now();
        stored.local_trial_start.get_or_insert(t);
        // Throttled to an hour, so every status call is not a disk write.
        if t > stored.last_seen + 3600 {
            stored.last_seen = t;
        }
        evaluate(stored, t, &verifying_key(), REVOKED)
    })
}

/// Checked by the commands that write to disk; the UI gates too, but this is
/// the one that holds.
pub fn can_edit() -> bool {
    status().can_edit()
}

/// Checks `input` and keeps it. Nothing leaves the machine.
pub fn activate(input: &str) -> Result<Status, String> {
    let payload = license_key::open(input, &verifying_key()).ok_or(
        "That isn't a valid VrushPDF license key. Copy the whole key from your purchase email; it starts with VRSH.",
    )?;
    if license_key::is_listed(REVOKED, &payload.id) {
        return Err("This license key has been revoked, usually after a refund.".into());
    }
    update(|stored| stored.key = Some(license_key::canonical(input)));
    Ok(status())
}

/// Forgets the key here. The trial does not restart.
pub fn remove() -> Status {
    update(|stored| stored.key = None);
    status()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use license_key::Payload;

    const T0: u64 = 1_800_000_000;

    fn signer() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn key_for(email: &str) -> String {
        let payload = Payload { v: 1, id: "3f9a0c2e".into(), email: email.into(), iat: T0 };
        license_key::sign(&payload, &signer())
    }

    fn eval(stored: &Stored, now: u64) -> Status {
        evaluate(stored, now, &signer().verifying_key(), "")
    }

    #[test]
    fn a_valid_key_licenses() {
        let stored = Stored {
            key: Some(key_for("a@b.c")),
            local_trial_start: Some(T0 - 30 * DAY),
            ..Default::default()
        };
        let status = eval(&stored, T0);
        assert_eq!(status.state, State::Licensed);
        assert_eq!(status.email.as_deref(), Some("a@b.c"));
        assert_eq!(status.key_id.as_deref(), Some("3f9a0c2e"));
        assert!(status.can_edit());
    }

    #[test]
    fn a_key_from_another_signer_does_not() {
        let other = Payload { v: 1, id: "x".into(), email: "a@b.c".into(), iat: T0 };
        let stored = Stored {
            key: Some(license_key::sign(&other, &SigningKey::from_bytes(&[9u8; 32]))),
            local_trial_start: Some(T0 - 30 * DAY),
            ..Default::default()
        };
        assert_eq!(eval(&stored, T0).state, State::Expired);
    }

    #[test]
    fn a_listed_key_is_revoked() {
        let stored = Stored { key: Some(key_for("a@b.c")), ..Default::default() };
        let status = evaluate(&stored, T0, &signer().verifying_key(), "# refunds\n3f9a0c2e\n");
        assert_eq!(status.state, State::Revoked);
        assert!(!status.can_edit());
    }

    #[test]
    fn the_trial_counts_down_then_expires() {
        let stored = Stored { local_trial_start: Some(T0), ..Default::default() };
        assert_eq!(eval(&stored, T0).days_left, Some(14));
        assert_eq!(eval(&stored, T0 + 13 * DAY + 1).days_left, Some(1));
        assert_eq!(eval(&stored, T0 + 14 * DAY).state, State::Expired);
        assert!(!eval(&stored, T0 + 14 * DAY).can_edit());
    }

    #[test]
    fn winding_the_clock_back_does_not_extend_the_trial() {
        let stored = Stored {
            local_trial_start: Some(T0),
            last_seen: T0 + 20 * DAY,
            ..Default::default()
        };
        assert_eq!(eval(&stored, T0 + DAY).state, State::Expired);
    }

    #[test]
    fn an_old_license_file_still_reads() {
        // Written by 0.2's server-based licensing.
        let old = r#"{"key":"VRSH-7M3QX-R9TB2-KD4WH-N8PCC","lease":"x.y","trialLease":null,
            "localTrialStart":1800000000,"lastChecked":0,"lastSeen":1800000000,"revoked":false}"#;
        let stored: Stored = serde_json::from_str(old).unwrap();
        assert_eq!(stored.local_trial_start, Some(T0));
        // The old key format is not a license any more.
        assert_eq!(eval(&stored, T0 + DAY).state, State::Trial);
    }

    #[test]
    fn the_shipped_public_key_parses() {
        let _ = verifying_key();
    }

    /// A key from the real keygen, against the real `license_key.pub` and a
    /// real `license.json`. Run it with a throwaway HOME:
    ///
    ///   HOME=$(mktemp -d) VRUSHPDF_TEST_KEY="$(npm run -s keygen -- issue test@example.com)" \
    ///   cargo test keygen_keys -- --ignored
    #[test]
    #[ignore = "writes license.json; run with a temporary HOME and a keygen key"]
    fn keygen_keys_activate_and_remove() {
        let key = std::env::var("VRUSHPDF_TEST_KEY").expect("set VRUSHPDF_TEST_KEY");
        assert!(
            std::env::var("HOME").unwrap_or_default().contains("tmp"),
            "run with a temporary HOME"
        );
        assert_eq!(status().state, State::Trial);

        let licensed = activate(&key).expect("the keygen's key was refused");
        assert_eq!(licensed.state, State::Licensed);
        assert_eq!(licensed.email.as_deref(), Some("test@example.com"));
        assert!(can_edit());

        let err = activate(&key[..key.len() - 4]).unwrap_err();
        assert!(err.contains("isn't a valid"), "unexpected error: {err}");
        // A refused key must not cost the license already held.
        assert_eq!(status().state, State::Licensed);

        assert_eq!(remove().state, State::Trial);
    }
}

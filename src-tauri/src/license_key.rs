//! The license key format. Compiled into both the app (`license.rs`) and the
//! keygen (`keygen/`, by `#[path]`), so the two cannot disagree about it.
//!
//! A key is `VRSH.<payload>.<signature>`: the payload is base64url JSON naming
//! who bought it, and the signature is Ed25519 over that base64url text (so no
//! JSON canonicalisation is needed). Only the keygen holds the private key; the
//! app checks keys offline against the public half in `license_key.pub`.
//!
//! Keys are long, so they are pasted, not typed. Whitespace anywhere is
//! ignored, because email clients like to wrap them.

// The app only opens keys and the keygen mostly signs them.
#![allow(dead_code)]

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

pub const PREFIX: &str = "VRSH";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Payload {
    pub v: u32,
    /// Short random id, for support and for `revoked_keys.txt`.
    pub id: String,
    pub email: String,
    /// When it was issued, in Unix seconds.
    pub iat: u64,
}

/// The key text for `payload`, signed with `key`.
pub fn sign(payload: &Payload, key: &SigningKey) -> String {
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_string(payload).expect("payload serialises"));
    let sig = key.sign(body.as_bytes());
    format!("{PREFIX}.{body}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
}

/// `input` without whitespace: the form a key is stored and compared in.
pub fn canonical(input: &str) -> String {
    input.chars().filter(|c| !c.is_whitespace()).collect()
}

/// The payload of `input` if it is a key signed by `key`, else None.
pub fn open(input: &str, key: &VerifyingKey) -> Option<Payload> {
    let text = canonical(input);
    let mut parts = text.split('.');
    let (prefix, body, sig) = (parts.next()?, parts.next()?, parts.next()?);
    if prefix != PREFIX || parts.next().is_some() {
        return None;
    }
    let sig = Signature::from_slice(&URL_SAFE_NO_PAD.decode(sig).ok()?).ok()?;
    key.verify_strict(body.as_bytes(), &sig).ok()?;
    let payload: Payload = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).ok()?).ok()?;
    (payload.v == 1).then_some(payload)
}

/// The Ed25519 public key in `license_key.pub` form: base64url, 32 bytes.
pub fn parse_public_key(text: &str) -> Option<VerifyingKey> {
    let bytes: [u8; 32] = URL_SAFE_NO_PAD.decode(text.trim()).ok()?.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

pub fn encode_public_key(key: &VerifyingKey) -> String {
    URL_SAFE_NO_PAD.encode(key.to_bytes())
}

/// Whether `id` is listed in a `revoked_keys.txt`-style list: one id per line,
/// `#` starts a comment.
pub fn is_listed(list: &str, id: &str) -> bool {
    list.lines()
        .map(|line| line.split('#').next().unwrap_or("").trim())
        .any(|entry| !entry.is_empty() && entry == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signer() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn payload() -> Payload {
        Payload { v: 1, id: "3f9a0c2e".into(), email: "a@b.c".into(), iat: 1_800_000_000 }
    }

    #[test]
    fn round_trips_even_when_wrapped() {
        let key = sign(&payload(), &signer());
        assert!(key.starts_with("VRSH."));
        assert_eq!(open(&key, &signer().verifying_key()), Some(payload()));
        let wrapped = format!("  {}\n{} \r\n", &key[..60], &key[60..]);
        assert_eq!(open(&wrapped, &signer().verifying_key()), Some(payload()));
    }

    #[test]
    fn refuses_another_signer_tampering_and_garbage() {
        let key = sign(&payload(), &signer());
        let other = SigningKey::from_bytes(&[9u8; 32]).verifying_key();
        assert_eq!(open(&key, &other), None);

        let (_, sig) = key.rsplit_once('.').unwrap();
        let forged = Payload { email: "someone@else.com".into(), ..payload() };
        let forged_body = URL_SAFE_NO_PAD.encode(serde_json::to_string(&forged).unwrap());
        assert_eq!(open(&format!("VRSH.{forged_body}.{sig}"), &signer().verifying_key()), None);

        for bad in ["", "VRSH", "VRSH.a.b", "garbage", &key[1..], &format!("{key}.x")] {
            assert_eq!(open(bad, &signer().verifying_key()), None, "{bad}");
        }
    }

    #[test]
    fn public_keys_round_trip() {
        let public = signer().verifying_key();
        assert_eq!(parse_public_key(&encode_public_key(&public)), Some(public));
        assert_eq!(parse_public_key("not a key"), None);
    }

    #[test]
    fn the_revocation_list_ignores_comments() {
        let list = "# refunds\n3f9a0c2e  # 2026-10-01\n\n  deadbeef\n";
        assert!(is_listed(list, "3f9a0c2e"));
        assert!(is_listed(list, "deadbeef"));
        assert!(!is_listed(list, "refunds"));
        assert!(!is_listed(list, ""));
    }
}

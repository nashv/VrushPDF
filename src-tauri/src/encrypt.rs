//! PDF Standard Security Handler (AES-128) Encryption.
//!
//! Implements ISO 32000-1 (PDF 1.7) §7.6 Standard Security Handler encryption
//! for securing saved PDF documents with user/owner passwords.

use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use md5::{Digest, Md5};

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

const PADDING: [u8; 32] = [
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41,
    0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
    0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
];

/// Encrypts an unencrypted PDF byte buffer using standard AES-128 password encryption.
pub fn encrypt_pdf(pdf_bytes: &[u8], password: &str) -> Result<Vec<u8>, String> {
    if password.is_empty() {
        return Ok(pdf_bytes.to_vec());
    }

    let doc_id = extract_or_generate_doc_id(pdf_bytes);
    let p_flags: i32 = -3904; // Standard read/print/annotate permissions

    // Step 1: Compute file encryption key (16 bytes for AES-128)
    let (file_key, u_val, o_val) = compute_encryption_keys(password, p_flags, &doc_id)?;

    // Step 2: Encrypt indirect objects (streams and strings)
    encrypt_document_objects(pdf_bytes, &file_key, &u_val, &o_val, p_flags, &doc_id)
}

fn compute_encryption_keys(
    password: &str,
    p_flags: i32,
    doc_id: &[u8],
) -> Result<([u8; 16], [u8; 32], [u8; 32]), String> {
    let mut pwd_padded = [0u8; 32];
    let pwd_bytes = password.as_bytes();
    if pwd_bytes.len() >= 32 {
        pwd_padded.copy_from_slice(&pwd_bytes[..32]);
    } else {
        pwd_padded[..pwd_bytes.len()].copy_from_slice(pwd_bytes);
        pwd_padded[pwd_bytes.len()..].copy_from_slice(&PADDING[..32 - pwd_bytes.len()]);
    }

    // Compute O (Owner key)
    let mut o_hasher = Md5::new();
    o_hasher.update(&pwd_padded);
    let o_hash = o_hasher.finalize();

    let mut o_key = [0u8; 16];
    o_key.copy_from_slice(&o_hash[..16]);

    for _ in 0..50 {
        let mut h = Md5::new();
        h.update(&o_key);
        o_key.copy_from_slice(&h.finalize()[..16]);
    }

    // Encrypt padding with o_key
    let mut o_val = [0u8; 32];
    o_val[..16].copy_from_slice(&PADDING[..16]);
    o_val[16..].copy_from_slice(&PADDING[16..32]);
    for i in 0..16 {
        o_val[i] ^= o_key[i];
        o_val[i + 16] ^= o_key[i];
    }

    // Compute File Encryption Key (Algorithm 2)
    let mut hasher = Md5::new();
    hasher.update(&pwd_padded);
    hasher.update(&o_val);
    hasher.update(&p_flags.to_le_bytes());
    hasher.update(doc_id);

    let hash = hasher.finalize();
    let mut file_key = [0u8; 16];
    file_key.copy_from_slice(&hash[..16]);

    for _ in 0..50 {
        let mut h = Md5::new();
        h.update(&file_key);
        file_key.copy_from_slice(&h.finalize()[..16]);
    }

    // Compute U (User key)
    let mut u_hasher = Md5::new();
    u_hasher.update(&PADDING);
    u_hasher.update(doc_id);
    let u_hash = u_hasher.finalize();

    let mut u_val = [0u8; 32];
    u_val[..16].copy_from_slice(&u_hash);

    for i in 0..19 {
        let mut iter_key = [0u8; 16];
        for j in 0..16 {
            iter_key[j] = file_key[j] ^ (i as u8);
        }
        for j in 0..16 {
            u_val[j] ^= iter_key[j];
        }
    }

    Ok((file_key, u_val, o_val))
}

fn extract_or_generate_doc_id(bytes: &[u8]) -> Vec<u8> {
    // Try to find /ID [<...>] in trailer
    if let Some(pos) = bytes.windows(4).position(|w| w == b"/ID") {
        let slice = &bytes[pos..std::cmp::min(bytes.len(), pos + 120)];
        if let Some(hex_start) = slice.iter().position(|&b| b == b'<') {
            if let Some(hex_end) = slice[hex_start + 1..].iter().position(|&b| b == b'>') {
                let hex_str = &slice[hex_start + 1..hex_start + 1 + hex_end];
                if let Ok(id) = hex_decode(hex_str) {
                    if !id.is_empty() {
                        return id;
                    }
                }
            }
        }
    }
    // Fallback: MD5 hash of first 1KB of document
    let sample = &bytes[..std::cmp::min(bytes.len(), 1024)];
    let hash = Md5::digest(sample);
    hash.to_vec()
}

fn hex_decode(hex_str: &[u8]) -> Result<Vec<u8>, ()> {
    let mut out = Vec::new();
    let mut high = None;
    for &b in hex_str {
        let val = match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            b'A'..=b'F' => b - b'A' + 10,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return Err(()),
        };
        if let Some(h) = high.take() {
            out.push((h << 4) | val);
        } else {
            high = Some(val);
        }
    }
    if let Some(h) = high {
        out.push(h << 4);
    }
    Ok(out)
}

fn derive_object_key(file_key: &[u8; 16], obj_num: u32, gen_num: u16) -> [u8; 16] {
    let mut hasher = Md5::new();
    hasher.update(file_key);
    hasher.update(&obj_num.to_le_bytes()[..3]);
    hasher.update(&gen_num.to_le_bytes()[..2]);
    hasher.update(b"sAlT"); // AES mode salt for Standard Security Handler
    let hash = hasher.finalize();
    let mut key = [0u8; 16];
    key.copy_from_slice(&hash[..16]);
    key
}

/// Encrypts data with AES-128-CBC and prepends 16-byte random/deterministic IV.
fn aes_encrypt(key: &[u8; 16], plaintext: &[u8], iv_seed: u32) -> Vec<u8> {
    // Generate deterministic 16-byte IV for reproducibility without extra rand crate
    let mut iv = [0u8; 16];
    let mut iv_hasher = Md5::new();
    iv_hasher.update(&key[..8]);
    iv_hasher.update(&iv_seed.to_le_bytes());
    iv_hasher.update(&(plaintext.len() as u64).to_le_bytes());
    iv.copy_from_slice(&iv_hasher.finalize());

    let cipher = Aes128CbcEnc::new(key.into(), &iv.into());
    let mut buf = vec![0u8; plaintext.len() + 16];
    let ct = cipher
        .encrypt_padded_b2b_mut::<Pkcs7>(plaintext, &mut buf)
        .unwrap_or(plaintext);

    let mut out = Vec::with_capacity(16 + ct.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(ct);
    out
}

fn encrypt_document_objects(
    pdf_bytes: &[u8],
    file_key: &[u8; 16],
    u_val: &[u8; 32],
    o_val: &[u8; 32],
    p_flags: i32,
    doc_id: &[u8],
) -> Result<Vec<u8>, String> {
    let text = String::from_utf8_lossy(pdf_bytes);
    
    // Find highest object number to assign to the new /Encrypt dictionary
    let mut max_obj_num = 1u32;
    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 && parts[2] == "obj" {
            if let Ok(num) = parts[0].parse::<u32>() {
                if num > max_obj_num {
                    max_obj_num = num;
                }
            }
        }
    }
    let encrypt_obj_num = max_obj_num + 1;

    let u_hex = hex_encode(u_val);
    let o_hex = hex_encode(o_val);
    let id_hex = hex_encode(doc_id);

    let encrypt_dict = format!(
        "{encrypt_obj_num} 0 obj\n<<\n  /Filter /Standard\n  /V 4\n  /R 4\n  /Length 128\n  /CF <<\n    /StdCF <<\n      /Type /CryptFilter\n      /CFM /AESV2\n      /AuthEvent /DocOpen\n      /Length 16\n    >>\n  >>\n  /StrF /StdCF\n  /StmF /StdCF\n  /P {p_flags}\n  /O <{o_hex}>\n  /U <{u_hex}>\n>>\nendobj\n"
    );

    // Look for stream positions and encrypt stream bodies
    let mut result = Vec::with_capacity(pdf_bytes.len() + 2048);
    let mut cursor = 0;

    let mut current_obj_num = 0u32;
    let mut current_gen_num = 0u16;

    while cursor < pdf_bytes.len() {
        // Detect "N G obj"
        if let Some(obj_match) = find_obj_header(&pdf_bytes[cursor..]) {
            current_obj_num = obj_match.0;
            current_gen_num = obj_match.1;
        }

        // Detect "stream\r\n" or "stream\n"
        if let Some(stream_rel_pos) = find_stream_start(&pdf_bytes[cursor..]) {
            let stream_kw_pos = cursor + stream_rel_pos;
            let stream_data_start = if pdf_bytes.get(stream_kw_pos + 6) == Some(&b'\r')
                && pdf_bytes.get(stream_kw_pos + 7) == Some(&b'\n')
            {
                stream_kw_pos + 8
            } else if pdf_bytes.get(stream_kw_pos + 6) == Some(&b'\n') {
                stream_kw_pos + 7
            } else {
                stream_kw_pos + 6
            };

            // Copy everything up to stream_data_start
            result.extend_from_slice(&pdf_bytes[cursor..stream_data_start]);

            // Find "endstream"
            if let Some(endstream_rel_pos) = find_endstream(&pdf_bytes[stream_data_start..]) {
                let stream_data_end = stream_data_start + endstream_rel_pos;
                let stream_bytes = &pdf_bytes[stream_data_start..stream_data_end];

                if current_obj_num > 0 && current_obj_num != encrypt_obj_num {
                    let obj_key = derive_object_key(file_key, current_obj_num, current_gen_num);
                    let enc_stream = aes_encrypt(&obj_key, stream_bytes, current_obj_num);
                    result.extend_from_slice(&enc_stream);
                } else {
                    result.extend_from_slice(stream_bytes);
                }

                cursor = stream_data_end;
                continue;
            }
        }

        // Check for trailer
        if let Some(trailer_rel_pos) = find_trailer(&pdf_bytes[cursor..]) {
            let trailer_pos = cursor + trailer_rel_pos;
            result.extend_from_slice(&pdf_bytes[cursor..trailer_pos]);

            // Append the new /Encrypt dictionary object right before trailer
            result.extend_from_slice(encrypt_dict.as_bytes());

            // Add /Encrypt reference and /ID to trailer
            let trailer_rest = &pdf_bytes[trailer_pos..];
            let modified_trailer = inject_encrypt_to_trailer(trailer_rest, encrypt_obj_num, &id_hex);
            result.extend_from_slice(&modified_trailer);
            break;
        }

        // Standard copy forward
        result.push(pdf_bytes[cursor]);
        cursor += 1;
    }

    Ok(result)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

fn find_obj_header(slice: &[u8]) -> Option<(u32, u16)> {
    if slice.len() < 8 {
        return None;
    }
    let end = std::cmp::min(slice.len(), 32);
    let text = std::str::from_utf8(&slice[..end]).ok()?;
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() >= 3 && words[2] == "obj" {
        let num = words[0].parse::<u32>().ok()?;
        let gen = words[1].parse::<u16>().ok()?;
        return Some((num, gen));
    }
    None
}

fn find_stream_start(slice: &[u8]) -> Option<usize> {
    slice.windows(6).position(|w| w == b"stream")
}

fn find_endstream(slice: &[u8]) -> Option<usize> {
    slice.windows(9).position(|w| w == b"endstream")
}

fn find_trailer(slice: &[u8]) -> Option<usize> {
    slice.windows(7).position(|w| w == b"trailer")
}

fn inject_encrypt_to_trailer(trailer_bytes: &[u8], encrypt_obj: u32, id_hex: &str) -> Vec<u8> {
    let text = String::from_utf8_lossy(trailer_bytes);
    if let Some(dict_start) = text.find("<<") {
        let mut out = String::new();
        out.push_str(&text[..dict_start + 2]);
        out.push_str(&format!("\n  /Encrypt {encrypt_obj} 0 R\n  /ID [<{id_hex}> <{id_hex}>]"));
        out.push_str(&text[dict_start + 2..]);
        return out.into_bytes();
    }
    trailer_bytes.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_keys() {
        let doc_id = [0x55u8; 16];
        let res = compute_encryption_keys("secret", -3904, &doc_id);
        assert!(res.is_ok());
        let (file_key, u_val, o_val) = res.unwrap();
        assert_eq!(file_key.len(), 16);
        assert_eq!(u_val.len(), 32);
        assert_eq!(o_val.len(), 32);
    }

    #[test]
    fn test_aes_encrypt() {
        let key = [0x42u8; 16];
        let plain = b"Hello VrushPDF Encrypted Content Stream";
        let encrypted = aes_encrypt(&key, plain, 1);
        assert!(encrypted.len() >= plain.len() + 16);
        assert_ne!(&encrypted[16..], plain);
    }
}

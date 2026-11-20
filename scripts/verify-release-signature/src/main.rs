use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::{env, error::Error, fs};

fn main() -> Result<(), Box<dyn Error>> {
    let [_, public_key, package, signature]: [String; 4] =
        env::args().collect::<Vec<_>>().try_into().map_err(|_| {
            "Usage: verify-release-signature <base64 public key> <package> <signature file>"
        })?;
    let key = PublicKey::decode(&String::from_utf8(STANDARD.decode(public_key)?)?)?;
    let signature = fs::read_to_string(signature)?;
    let signature = Signature::decode(&String::from_utf8(STANDARD.decode(signature.trim())?)?)?;
    key.verify(&fs::read(package)?, &signature, true)?;
    Ok(())
}

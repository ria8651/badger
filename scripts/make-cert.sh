#!/bin/bash
# Creates the one self-signed code-signing certificate Badger.app is signed with, locally and in CI. Run it once.
#
# Why sign at all, unnotarised: macOS keeps what you've allowed an app, like reaching ~/Documents, against its
# signature. Signed ad-hoc, that's the binary's hash, so every build asks again; signed with this, it's the
# certificate, so a grant survives updates. Gatekeeper still wants "Open Anyway" the first time, as it does for
# anything Apple hasn't notarised.
#
# THE .p12 IS BADGER'S SIGNING IDENTITY. Back it up: a new certificate means everyone's grants stop applying.
# Adapted from ria8651/disk-scanner's make-cert.sh.
set -euo pipefail

IDENTITY="${BADGER_SIGN_IDENTITY:-Badger}"
P12="${1:-$IDENTITY.p12}"
# PKCS#12 can't have an empty password (`security import` won't read it), so this is fixed and published, not a
# secret: the workflow has it too. The key in the file is what to keep safe.
P12_PASSWORD=badger

if security find-certificate -c "$IDENTITY" >/dev/null 2>&1; then
  echo "A certificate named \"$IDENTITY\" is already in your keychain. Refusing to make a second: two with one name" >&2
  echo "sign differently depending on which the keychain returns. Delete it in Keychain Access to start over." >&2
  exit 1
fi
if [[ -e "$P12" ]]; then
  echo "$P12 already exists; move it aside first." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# codesign needs the codeSigning usage, not a trusted certificate.
cat > "$TMP/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTITY
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF

echo "==> making the certificate (20 years: an expired one can't sign, and a new one voids grants)"
openssl req -x509 -newkey rsa:2048 -nodes -days 7300 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cert.cnf" 2>/dev/null

# OpenSSL 3's default encryption is one Apple's Security framework can't read; it then says "MAC verification
# failed (wrong password?)", which it isn't. These older algorithms it reads.
echo "==> exporting $P12"
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$IDENTITY" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -out "$P12" -passout "pass:$P12_PASSWORD"
chmod 600 "$P12"

echo "==> importing it into your login keychain"
# macOS still asks once whether codesign may use the key the first time it does; choose Always Allow.
security import "$P12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security

cat <<EOF

Made "$IDENTITY", valid until $(openssl x509 -in "$TMP/cert.pem" -noout -enddate | cut -d= -f2).
\`pnpm app:build\` signs with it from now on.

For releases, add it as the repository secret SIGNING_CERT_P12 (Settings → Secrets and variables → Actions):
  openssl base64 -A -in "$P12" | pbcopy        then paste

!! Back up $P12 somewhere safe, like a password manager, and keep it out of the repo.
EOF

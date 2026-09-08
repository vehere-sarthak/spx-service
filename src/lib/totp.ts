import * as crypto from "crypto";
import { getTotpIssuer } from "./app-config";

/** RFC 6238 TOTP (SHA-1, 30s, 6 digits) — no external deps. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

export function totpUri(secret: string, account: string, issuer?: string) {
  const iss = issuer || getTotpIssuer();
  const label = encodeURIComponent(`${iss}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(iss)}&algorithm=SHA1&digits=6&period=30`;
}

/** Browser-reachable QR image URL for authenticator enrollment (same UX as vehere-ui qrCodeUrl). */
export function totpQrImageUrl(otpauth: string, size = 200): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(otpauth)}`;
}

export function verifyTotp(token: string, secret: string, window = 1): boolean {
  const clean = String(token || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    if (hotp(secret, counter + w) === clean) return true;
  }
  return false;
}

export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => crypto.randomBytes(4).toString("hex"));
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(String(code).trim().toLowerCase()).digest("hex");
}

export function storeRecoveryHashes(codes: string[]): string {
  return JSON.stringify(codes.map(hashRecoveryCode));
}

/** Returns remaining hashes JSON if code matched, or null. */
export function consumeRecoveryCode(storedJson: string | null | undefined, code: string): string | null {
  if (!storedJson || !code) return null;
  let hashes: string[];
  try {
    hashes = JSON.parse(storedJson);
    if (!Array.isArray(hashes)) return null;
  } catch {
    return null;
  }
  const h = hashRecoveryCode(code);
  const idx = hashes.indexOf(h);
  if (idx < 0) return null;
  hashes.splice(idx, 1);
  return JSON.stringify(hashes);
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

function base32Encode(buf: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = input.replace(/=+$/, "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

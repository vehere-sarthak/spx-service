import * as crypto from "crypto";
import * as https from "https";
import * as http from "http";
import { sql } from "./mysql";

export const SPX_PORT = 19201;

const ENCRYPTION_KEY_HEX =
  process.env.SPX_ENCRYPTION_KEY ||
  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";

const WIRE_SECRET = process.env.SPX_WIRE_SECRET || "spx_wire_secret_key_vui_2026";

function getKey(): Buffer {
  return Buffer.from(ENCRYPTION_KEY_HEX.slice(0, 64), "hex");
}

export function encryptPassword(plaintext: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptPassword(stored: string): string {
  const [ivHex, encHex] = String(stored || "").split(":");
  if (!ivHex || !encHex) throw new Error("Invalid encrypted password format");
  const iv = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", getKey(), iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/** Accept plain password or CryptoJS.AES wire ciphertext from vehere-ui. */
export function decryptWirePassword(wirePassword?: string): string {
  if (!wirePassword) return "";
  // CryptoJS OpenSSL-compatible: "Salted__" + salt + ciphertext, base64
  try {
    const raw = Buffer.from(wirePassword, "base64");
    if (raw.length > 16 && raw.subarray(0, 8).toString("utf8") === "Salted__") {
      const salt = raw.subarray(8, 16);
      const ciphertext = raw.subarray(16);
      const { key, iv } = evpBytesToKey(WIRE_SECRET, salt, 32, 16);
      const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      if (plain) return plain;
    }
  } catch {
    /* fall through */
  }
  return wirePassword;
}

function evpBytesToKey(password: string, salt: Buffer, keyLen: number, ivLen: number) {
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < keyLen + ivLen) {
    block = crypto
      .createHash("md5")
      .update(Buffer.concat([block, Buffer.from(password, "utf8"), salt]))
      .digest();
    derived = Buffer.concat([derived, block]);
  }
  return {
    key: derived.subarray(0, keyLen),
    iv: derived.subarray(keyLen, keyLen + ivLen),
  };
}

function buildTimestampToken(passkeyB64: string, ts: number): string {
  const normalized = passkeyB64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const keyBytes = Buffer.from(padded, "base64");
  const iv = crypto.randomBytes(12);
  const plaintext = Buffer.from(String(ts), "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, encrypted, tag]);
  return packed
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function buildAuthHeaders(passkeyB64: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "X-SX-TS": String(ts),
    "X-SX-TS-TOKEN": buildTimestampToken(passkeyB64, ts),
  };
}

export function proxyToSpx(
  ip: string,
  urlPath: string,
  method: string,
  body?: any,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body && Object.keys(body).length ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname: ip,
      port: SPX_PORT,
      path: urlPath,
      method,
      rejectUnauthorized: false,
      timeout: 15000,
      headers: {
        Accept: "application/json",
        ...(bodyStr
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }
          : {}),
        ...(extraHeaders || {}),
      },
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        let data: any;
        try {
          data = JSON.parse(raw);
        } catch {
          data = { detail: raw, text: raw };
        }
        resolve({ status: res.statusCode || 200, data });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timed out ${ip}:${SPX_PORT}${urlPath}`));
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export async function getAppliance(id: number) {
  const rows = await sql<any>(
    `SELECT id, name, ip_address, username, password, created_by, created_on, last_modified_by, last_modified_on
     FROM spx_management WHERE id=? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

export async function getPasskey(record: {
  ip_address: string;
  username: string;
  password: string;
}): Promise<string | null> {
  try {
    const plainPassword = decryptPassword(record.password);
    const result = await proxyToSpx(record.ip_address, "/api/auth/login", "POST", {
      username: record.username,
      password: plainPassword,
    });
    return (result.data?.passkey as string) || null;
  } catch {
    return null;
  }
}

export async function withApplianceAuth(id: number) {
  const record = await getAppliance(id);
  if (!record) return null;
  const passkey = await getPasskey(record);
  const authHeaders = passkey ? buildAuthHeaders(passkey) : {};
  return { record, authHeaders };
}

export async function testEsHttpConnection(opts: {
  host: string;
  port: number;
  user: string;
  password: string;
  scheme?: string;
  verify_certs?: boolean;
}): Promise<{ ok: boolean; message: string; cluster_uuid?: string; cluster_name?: string; version?: string }> {
  return new Promise((resolve) => {
    const scheme = (opts.scheme || "https").toLowerCase() === "http" ? "http" : "https";
    const mod = scheme === "http" ? http : https;
    const auth = Buffer.from(`${opts.user}:${opts.password}`).toString("base64");
    const req = mod.request(
      {
        hostname: opts.host,
        port: opts.port,
        path: "/",
        method: "GET",
        timeout: 5000,
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
        ...(scheme === "https" ? { rejectUnauthorized: Boolean(opts.verify_certs) } : {}),
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          const status = res.statusCode || 0;
          if (status === 401 || status === 403) {
            return resolve({ ok: false, message: "Invalid username or password." });
          }
          if (status >= 200 && status < 300) {
            try {
              const data = JSON.parse(raw || "{}");
              if (!(data.cluster_uuid || data.cluster_name || data.version?.number)) {
                return resolve({ ok: false, message: "Not Elasticsearch/OpenSearch." });
              }
              return resolve({
                ok: true,
                message: `Connected to ${data.cluster_name || data.name || "cluster"}${
                  data.version?.number ? ` v${data.version.number}` : ""
                }.`,
                cluster_uuid: data.cluster_uuid,
                cluster_name: data.cluster_name,
                version: data.version?.number,
              });
            } catch {
              return resolve({ ok: false, message: "Invalid Elasticsearch response." });
            }
          }
          resolve({ ok: false, message: `HTTP ${status}.` });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, message: `Timed out (${opts.host}:${opts.port}).` });
    });
    req.on("error", () => resolve({ ok: false, message: `Unreachable (${opts.host}:${opts.port}).` }));
    req.end();
  });
}

import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT = "v1";

const PiiEnvSchema = z.object({
  PHONE_HASH_PEPPER: z.string().min(32, "PHONE_HASH_PEPPER must be at least 32 characters"),
  PHONE_ENCRYPTION_KEY: z.string().refine((key) => Buffer.from(key, "base64").length === KEY_BYTES, {
    error: "PHONE_ENCRYPTION_KEY must be 32 bytes, base64-encoded",
  }),
});

export type PiiSecrets = { pepper: string; encryptionKey: Buffer };

export function loadPiiSecrets(env: Record<string, string | undefined> = process.env): PiiSecrets {
  const parsed = PiiEnvSchema.parse(env);
  return {
    pepper: parsed.PHONE_HASH_PEPPER,
    encryptionKey: Buffer.from(parsed.PHONE_ENCRYPTION_KEY, "base64"),
  };
}

/** Strips the channel prefix, so a number hashes the same however it arrived. */
export function normalizePhone(phone: string): string {
  return phone.replace(/^whatsapp:/, "").replace(/[^\d+]/g, "");
}

/** Keyed, because phone numbers are few enough to reverse a plain hash by trying them all. */
export function hashPhone(phone: string, pepper: string): string {
  return createHmac("sha256", pepper).update(normalizePhone(phone)).digest("hex");
}

export function encryptPhone(phone: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(normalizePhone(phone), "utf8"), cipher.final()]);
  return [FORMAT, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptPhone(stored: string, key: Buffer): string {
  const [format, iv, tag, ciphertext] = stored.split(":");
  if (format !== FORMAT || !iv || !tag || !ciphertext) throw new Error("Unrecognised encrypted phone format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

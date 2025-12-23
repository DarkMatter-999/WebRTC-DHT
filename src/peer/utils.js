import crypto from "crypto";

export function createNodeId() {
  return crypto.createHash("sha256").update(crypto.randomBytes(32)).digest();
}

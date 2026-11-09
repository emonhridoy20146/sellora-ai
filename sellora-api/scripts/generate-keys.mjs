#!/usr/bin/env node
// Prints fresh secrets for .env: an Ed25519 JWT key pair, 32-byte data and backup encryption
// keys and the other random secrets.
// Usage: npm run keys:generate >> .env   (then edit duplicates by hand)
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64 = (s) => Buffer.from(s).toString('base64');
const kid = `k${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

console.log(`JWT_KEY_ID=${kid}`);
console.log(`JWT_PRIVATE_KEY=${b64(privateKey.export({ type: 'pkcs8', format: 'pem' }))}`);
console.log(`JWT_PUBLIC_KEY=${b64(publicKey.export({ type: 'spki', format: 'pem' }))}`);
console.log(`DATA_ENCRYPTION_KEYS=${kid}:${randomBytes(32).toString('base64')}`);
console.log(`DATA_ENCRYPTION_ACTIVE_KID=${kid}`);
console.log(`BACKUP_ENCRYPTION_KEYS=b${kid}:${randomBytes(32).toString('base64')}`);
console.log(`BACKUP_ENCRYPTION_ACTIVE_KID=b${kid}`);
console.log(`WEBCHAT_TOKEN_SECRET=${randomBytes(32).toString('hex')}`);
console.log(`STORAGE_SIGNING_SECRET=${randomBytes(32).toString('hex')}`);
console.log(`METRICS_TOKEN=${randomBytes(24).toString('hex')}`);
console.log(`STOREFRONT_API_KEY=${randomBytes(32).toString('hex')}`);
console.log(`FRAUD_NETWORK_SECRET=${randomBytes(32).toString('hex')}`);
console.log(`META_WEBHOOK_VERIFY_TOKEN=${randomBytes(24).toString('hex')}`);

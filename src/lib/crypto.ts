/**
 * Senfoni Crypto Utilities
 * Uses Web Crypto API for client-side E2EE.
 */

const ITERATIONS = 100000;
const KEY_LENGTH = 256;
const ALGO = 'AES-GCM';

/**
 * Derives a cryptographic key from a password and salt.
 */
export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: ALGO, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a message using a derived key.
 */
export async function encryptMessage(message: string, key: CryptoKey): Promise<{ ciphertext: string; iv: string; salt: string }> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  
  // Re-derive key if needed or use provided key
  // For simplicity here, we assume the key is already derived.
  
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    enc.encode(message)
  );

  return {
    ciphertext: b64Encode(encrypted),
    iv: b64Encode(iv),
    salt: b64Encode(salt), // This salt would be used for derivation if we didn't pass the key
  };
}

/**
 * Decrypts a message using a derived key.
 */
export async function decryptMessage(ciphertext: string, iv: string, key: CryptoKey): Promise<string> {
  const dec = new TextDecoder();
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGO, iv: b64Decode(iv) },
    key,
    b64Decode(ciphertext)
  );

  return dec.decode(decrypted);
}

/**
 * Encrypts binary file data using a derived CryptoKey.
 * Returns base64-encoded ciphertext and IV.
 */
export async function encryptFile(data: ArrayBuffer, key: CryptoKey): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    data
  );
  return {
    ciphertext: b64Encode(encrypted),
    iv: b64Encode(iv),
  };
}

/**
 * Decrypts base64-encoded encrypted file data using a derived CryptoKey.
 * Returns the original ArrayBuffer.
 */
export async function decryptFile(ciphertext: string, iv: string, key: CryptoKey): Promise<ArrayBuffer> {
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGO, iv: b64Decode(iv) },
    key,
    b64Decode(ciphertext)
  );
  return decrypted;
}

// Helper functions for base64 encoding/decoding
export function b64Encode(buffer: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

export function b64Decode(str: string): Uint8Array {
  return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)));
}

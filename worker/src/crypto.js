function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Secret root key must be base64 encoded.");
  }
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Secret root key must be valid base64.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function additionalData({ purpose, ownerId, keyVersion }) {
  if (!purpose || !ownerId) {
    throw new Error("Secret purpose and owner are required.");
  }
  return JSON.stringify(["telegram-checkin-secret", keyVersion, purpose, ownerId]);
}

export function rootKeyForVersion(env, keyVersion) {
  const versioned = env?.[`SECRET_ROOT_KEY_V${keyVersion}`];
  return versioned || env?.SECRET_ROOT_KEY || null;
}

async function importRootKey(rootKeyBase64, cryptoImpl) {
  const raw = base64ToBytes(rootKeyBase64);
  if (raw.byteLength !== 32) {
    throw new Error("Secret root key must decode to a 32-byte AES-256 key.");
  }
  return cryptoImpl.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function binaryBytes(value, field) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new TypeError(`${field} must be binary data.`);
}

export async function encryptSecret(rootKeyBase64, plaintext, options, cryptoImpl = globalThis.crypto) {
  if (typeof plaintext !== "string") {
    throw new TypeError("Secret plaintext must be a string.");
  }
  const keyVersion = options.keyVersion ?? 1;
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new TypeError("Secret key version must be a positive integer.");
  }
  const aad = additionalData({ ...options, keyVersion });
  const nonce = cryptoImpl.getRandomValues(new Uint8Array(12));
  const key = await importRootKey(rootKeyBase64, cryptoImpl);
  const ciphertext = await cryptoImpl.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode(aad),
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(plaintext),
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    nonce: bytesToBase64(nonce),
    aad,
    key_version: keyVersion,
    algorithm: "AES-256-GCM",
  };
}

export async function decryptSecret(rootKeyBase64, encrypted, options, cryptoImpl = globalThis.crypto) {
  if (!encrypted || encrypted.algorithm !== "AES-256-GCM") {
    throw new Error("Unsupported secret encryption algorithm.");
  }
  const keyVersion = encrypted.key_version;
  const aad = additionalData({ ...options, keyVersion });
  if (encrypted.aad !== aad) {
    throw new Error("Secret associated data does not match its owner and purpose.");
  }
  const nonce = base64ToBytes(encrypted.nonce);
  if (nonce.byteLength !== 12) {
    throw new Error("Secret nonce must be 12 bytes.");
  }
  const ciphertext = base64ToBytes(encrypted.ciphertext);
  const key = await importRootKey(rootKeyBase64, cryptoImpl);
  const plaintext = await cryptoImpl.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode(aad),
      tagLength: 128,
    },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

export async function encryptBytes(rootKeyBase64, plaintext, options, cryptoImpl = globalThis.crypto) {
  const bytes = binaryBytes(plaintext, "Binary plaintext");
  const keyVersion = options.keyVersion ?? 1;
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new TypeError("Secret key version must be a positive integer.");
  }
  const aad = additionalData({ ...options, keyVersion });
  const nonce = cryptoImpl.getRandomValues(new Uint8Array(12));
  const key = await importRootKey(rootKeyBase64, cryptoImpl);
  const ciphertext = await cryptoImpl.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode(aad),
      tagLength: 128,
    },
    key,
    bytes,
  );
  return {
    ciphertext,
    nonce: nonce.buffer.slice(nonce.byteOffset, nonce.byteOffset + nonce.byteLength),
    aad,
    key_version: keyVersion,
    algorithm: "AES-256-GCM",
  };
}

export async function decryptBytes(rootKeyBase64, encrypted, options, cryptoImpl = globalThis.crypto) {
  if (!encrypted || encrypted.algorithm !== "AES-256-GCM") {
    throw new Error("Unsupported secret encryption algorithm.");
  }
  const keyVersion = encrypted.key_version;
  const aad = additionalData({ ...options, keyVersion });
  if (encrypted.aad !== aad) {
    throw new Error("Secret associated data does not match its owner and purpose.");
  }
  const nonce = binaryBytes(encrypted.nonce, "Binary nonce");
  if (nonce.byteLength !== 12) throw new Error("Secret nonce must be 12 bytes.");
  const ciphertext = binaryBytes(encrypted.ciphertext, "Binary ciphertext");
  const key = await importRootKey(rootKeyBase64, cryptoImpl);
  return new Uint8Array(await cryptoImpl.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode(aad),
      tagLength: 128,
    },
    key,
    ciphertext,
  ));
}

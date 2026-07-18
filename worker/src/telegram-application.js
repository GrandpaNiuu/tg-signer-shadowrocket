export const TELEGRAM_APPLICATION_OWNER_ID = "telegram_application";

export async function resolveTelegramApplicationCredentialRefs(repository, account = {}) {
  const accountId = account.account_id || account.id;
  if (accountId && account.api_id_secret_id && account.api_hash_secret_id) {
    return {
      source: "account",
      ownerId: accountId,
      apiIdSecretId: account.api_id_secret_id,
      apiHashSecretId: account.api_hash_secret_id,
    };
  }

  const [apiId, apiHash] = await Promise.all([
    repository.getSecretByOwnerPurpose("setting", TELEGRAM_APPLICATION_OWNER_ID, "api_id"),
    repository.getSecretByOwnerPurpose("setting", TELEGRAM_APPLICATION_OWNER_ID, "api_hash"),
  ]);
  if (apiId && apiHash) {
    return {
      source: "global",
      ownerId: TELEGRAM_APPLICATION_OWNER_ID,
      apiIdSecretId: apiId.id,
      apiHashSecretId: apiHash.id,
    };
  }

  if (typeof repository.getLegacyTelegramApplicationSecretRefs !== "function") return null;
  const legacy = await repository.getLegacyTelegramApplicationSecretRefs();
  if (!legacy) return null;
  return {
    source: "legacy_account",
    ownerId: legacy.account_id,
    apiIdSecretId: legacy.api_id_secret_id,
    apiHashSecretId: legacy.api_hash_secret_id,
  };
}

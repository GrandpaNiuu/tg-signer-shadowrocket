import process from "node:process";
import { pathToFileURL } from "node:url";

const REQUIRED_COUNT_FIELDS = Object.freeze([
  "account_count",
  "connected_account_count",
  "connected_session_account_count",
  "task_count",
  "successful_run_count",
]);

export function findEvidence(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEvidence(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (REQUIRED_COUNT_FIELDS.every((field) => Object.hasOwn(value, field))) return value;
  for (const child of Object.values(value)) {
    const found = findEvidence(child);
    if (found) return found;
  }
  return null;
}

function inventoryCount(evidence, field) {
  const value = Number(evidence[field]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`D1 takeover audit returned an invalid ${field}.`);
  }
  return value;
}

export function validateTakeoverEvidence(payload) {
  const evidence = findEvidence(payload);
  if (!evidence) throw new Error("D1 takeover audit did not return a complete inventory row.");

  const counts = Object.fromEntries(
    REQUIRED_COUNT_FIELDS.map((field) => [field, inventoryCount(evidence, field)]),
  );

  if (counts.account_count < 1 || counts.connected_account_count < 1) {
    throw new Error("D1 takeover blocked: no connected migrated Telegram account.");
  }
  if (counts.connected_session_account_count !== counts.connected_account_count) {
    throw new Error("D1 takeover blocked: a connected account has no encrypted Session record.");
  }
  if (counts.task_count < 1 || counts.successful_run_count < 1) {
    throw new Error("D1 takeover blocked: no migrated task with a successful D1 Runner canary.");
  }

  return counts;
}

async function readStandardInput() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) throw new Error("D1 takeover audit received no JSON input.");
  try {
    return JSON.parse(input);
  } catch {
    throw new Error("D1 takeover audit received invalid JSON.");
  }
}

export async function main() {
  const counts = validateTakeoverEvidence(await readStandardInput());
  console.log(JSON.stringify({ ok: true, ...counts }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "D1 takeover audit failed.");
    process.exitCode = 1;
  });
}

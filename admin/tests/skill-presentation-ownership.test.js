import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { __test } from "../src/skill-guidance.js";

const sourceUrl = new URL("../src/skill-guidance.js", import.meta.url);

const expandedSkills = ["bot_flow", "send_media", "chat_snapshot"];

test("active expanded Skills have a single DOM presentation owner", async () => {
  for (const skill of expandedSkills) {
    assert.equal(__test.EXTERNALLY_PRESENTED_SKILLS.has(skill), true);
  }

  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /EXTERNALLY_PRESENTED_SKILLS\.has\(option\.value\)\) continue/);
  assert.match(source, /!key \|\| EXTERNALLY_PRESENTED_SKILLS\.has\(key\)\) continue/);
});

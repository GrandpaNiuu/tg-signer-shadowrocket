const documentRef = globalThis.document;

const FORM_SELECTOR = "#task-form";
const ACCOUNT_SELECTOR = "#task-account";
const SKILL_SELECTOR = "#task-skill";
const LEGACY_TARGET_SELECTOR = "#task-bot";
const EXPANDED_TARGET_SELECTOR = '[data-skill-field="target"]';
const LEGACY_PICKER_SELECTOR = '[data-dialog-picker="#task-bot"]';

function dispatchValue(input, value) {
  if (!input) return;
  const next = String(value || "");
  if (input.value === next) return;
  input.value = next;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function currentExpandedTarget(form) {
  return form?.querySelector(EXPANDED_TARGET_SELECTOR) || null;
}

function bindMirrors(form, legacyTarget, expandedTarget) {
  if (legacyTarget.dataset.sendMediaMirrorBound !== "true") {
    legacyTarget.dataset.sendMediaMirrorBound = "true";
    legacyTarget.addEventListener("input", () => {
      const current = currentExpandedTarget(form);
      if (current) dispatchValue(current, legacyTarget.value);
    });
    legacyTarget.addEventListener("change", () => {
      const current = currentExpandedTarget(form);
      if (current) dispatchValue(current, legacyTarget.value);
    });
  }

  if (expandedTarget.dataset.sendMediaMirrorBound !== "true") {
    expandedTarget.dataset.sendMediaMirrorBound = "true";
    expandedTarget.addEventListener("input", () => dispatchValue(legacyTarget, expandedTarget.value));
    expandedTarget.addEventListener("change", () => dispatchValue(legacyTarget, expandedTarget.value));
  }
}

function mountSendMediaPicker() {
  const form = documentRef?.querySelector(FORM_SELECTOR);
  if (!form) return;

  const account = form.querySelector(ACCOUNT_SELECTOR);
  const skill = form.querySelector(SKILL_SELECTOR);
  const legacyTarget = form.querySelector(LEGACY_TARGET_SELECTOR);
  const picker = form.querySelector(LEGACY_PICKER_SELECTOR);
  if (!account || !skill || !legacyTarget || !picker) return;

  const legacyField = legacyTarget.closest(".field") || legacyTarget.parentElement;
  const expandedTarget = currentExpandedTarget(form);
  const sendMediaActive = skill.value === "send_media" && expandedTarget;

  if (!sendMediaActive) {
    if (legacyField && picker.parentElement !== legacyField) legacyField.append(picker);
    return;
  }

  const expandedField = expandedTarget.closest(".field") || expandedTarget.parentElement;
  if (!expandedField) return;

  bindMirrors(form, legacyTarget, expandedTarget);

  const expandedValue = String(expandedTarget.value || "").trim();
  const legacyValue = String(legacyTarget.value || "").trim();
  if (expandedValue && expandedValue !== legacyValue) dispatchValue(legacyTarget, expandedValue);
  else if (!expandedValue && legacyValue) dispatchValue(expandedTarget, legacyValue);

  expandedTarget.type = "hidden";
  expandedTarget.removeAttribute("placeholder");
  picker.dataset.sendMediaMounted = "true";
  if (picker.parentElement !== expandedField) expandedField.append(picker);
}

function scheduleMount() {
  queueMicrotask(mountSendMediaPicker);
}

if (documentRef) {
  mountSendMediaPicker();
  documentRef.addEventListener("change", (event) => {
    if (event.target?.matches?.(`${SKILL_SELECTOR}, ${ACCOUNT_SELECTOR}`)) scheduleMount();
  });
  const observer = new MutationObserver(scheduleMount);
  observer.observe(documentRef.body, { childList: true, subtree: true });
}

export const __test = {
  ACCOUNT_SELECTOR,
  EXPANDED_TARGET_SELECTOR,
  FORM_SELECTOR,
  LEGACY_PICKER_SELECTOR,
  LEGACY_TARGET_SELECTOR,
  SKILL_SELECTOR,
};

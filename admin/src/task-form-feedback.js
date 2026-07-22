const FIELD_LABELS = Object.freeze({
  name: "任务名称",
  account_id: "Telegram 账号",
  skill_key: "任务类型",
  bot: "接收方",
  command: "发送内容",
  tg_signer_import: "按钮签到配置",
  cron: "执行时间",
  timezone: "时区",
  retry: "重试次数",
  timeout_seconds: "超时时间",
  thread_id: "话题 ID",
  delete_after_seconds: "自动删除时间",
});

export function taskValidationSummary(errors = {}) {
  const fields = Object.keys(errors);
  const labels = fields.map((field) => FIELD_LABELS[field] || field);
  return {
    title: "任务还不能保存",
    firstField: fields[0] || "",
    message: labels.length ? `${labels.join("、")}需要检查。` : "请检查任务配置。",
  };
}

export const __test = { FIELD_LABELS };

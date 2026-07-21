from runner.skills.account_audit import AccountAuditSkill
from runner.skills.bot_flow import BotFlowSkill
from runner.skills.chat_snapshot import ChatSnapshotSkill
from runner.skills.registry import SkillRegistry
from runner.skills.send_media import SendMediaSkill
from runner.skills.send_text import SendTextSkill
from runner.skills.tg_signer import TgSignerSkill


def build_registry() -> SkillRegistry:
    registry = SkillRegistry()
    registry.register(SendTextSkill())
    registry.register(TgSignerSkill())
    registry.register(BotFlowSkill())
    registry.register(SendMediaSkill())
    registry.register(ChatSnapshotSkill())
    registry.register(AccountAuditSkill())
    return registry


__all__ = ["SkillRegistry", "build_registry"]

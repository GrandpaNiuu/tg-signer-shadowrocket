from runner.skills.registry import SkillRegistry
from runner.skills.send_text import SendTextSkill
from runner.skills.tg_signer import TgSignerSkill


def build_registry() -> SkillRegistry:
    registry = SkillRegistry()
    registry.register(SendTextSkill())
    registry.register(TgSignerSkill())
    return registry


__all__ = ["SkillRegistry", "build_registry"]

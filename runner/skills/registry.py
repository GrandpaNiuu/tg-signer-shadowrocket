from __future__ import annotations

from runner.skills.base import Skill


class SkillRegistry:
    def __init__(self) -> None:
        self._skills: dict[str, Skill] = {}

    def register(self, skill: Skill) -> None:
        if not skill.name or skill.name in self._skills:
            raise ValueError(f"duplicate or empty skill name: {skill.name!r}")
        self._skills[skill.name] = skill

    def get(self, name: str) -> Skill:
        try:
            return self._skills[name]
        except KeyError as exc:
            raise KeyError(f"skill is not registered: {name}") from exc

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._skills))

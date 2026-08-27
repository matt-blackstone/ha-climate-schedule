"""Persistent storage and schedule execution for Climate Schedule."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime
import logging
import math
from typing import Any

from homeassistant.components.climate.const import (
    ATTR_HVAC_MODE,
    DOMAIN as CLIMATE_DOMAIN,
    SERVICE_SET_HVAC_MODE,
    SERVICE_SET_TEMPERATURE,
)
from homeassistant.const import ATTR_TEMPERATURE
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    DAYS,
    EVENT_UPDATED,
    KNOWN_HVAC_MODES,
    SEASON_IDS,
    SEASONS,
    STORAGE_KEY,
    STORAGE_VERSION,
)

DEFAULT_GRADIENT_END = "#ef4444"

_LOGGER = logging.getLogger(__name__)


class ScheduleValidationError(ValueError):
    """Raised when a schedule document is not safe to store or execute."""


class RevisionConflictError(ValueError):
    """Raised when a client attempts to overwrite a newer document."""


def empty_week() -> dict[str, list[dict[str, Any]]]:
    """Return a new empty seven-day schedule."""
    return {day: [] for day in DAYS}


def default_document() -> dict[str, Any]:
    """Return an empty versioned schedule document."""
    return {
        "revision": 0,
        "active_season": SEASON_IDS[0],
        "seasons": [dict(season) for season in SEASONS],
        "gradient_end": DEFAULT_GRADIENT_END,
        "entities": {},
    }


def _gradient_end(value: Any) -> str:
    """Validate a six-digit CSS color used for the schedule gradient."""
    if (
        not isinstance(value, str)
        or len(value) != 7
        or value[0] != "#"
        or any(character not in "0123456789abcdefABCDEF" for character in value[1:])
    ):
        raise ScheduleValidationError("Gradient color must be a six-digit hex color")
    return value.lower()


def _clock_minutes(value: Any, *, end: bool = False) -> int:
    """Validate an HH:MM value and return minutes after midnight."""
    if not isinstance(value, str) or len(value) != 5 or value[2] != ":":
        raise ScheduleValidationError(f"Invalid time: {value!r}")
    try:
        hour = int(value[:2])
        minute = int(value[3:])
    except ValueError as err:
        raise ScheduleValidationError(f"Invalid time: {value!r}") from err

    if end and hour == 24 and minute == 0:
        return 1440
    if not 0 <= hour <= 23 or not 0 <= minute <= 59 or minute % 15:
        raise ScheduleValidationError(
            f"Time {value!r} must use 15-minute increments"
        )
    return hour * 60 + minute


def _temperature(value: Any) -> float | int:
    """Return a bounded finite target temperature."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ScheduleValidationError("Temperature must be numeric")
    number = float(value)
    if not math.isfinite(number) or not -100 <= number <= 300:
        raise ScheduleValidationError("Temperature is outside the safe range")
    return int(number) if number.is_integer() else round(number, 2)


def normalise_document(raw: Any) -> dict[str, Any]:
    """Validate and canonicalise a client-provided schedule document."""
    if not isinstance(raw, dict):
        raise ScheduleValidationError("Schedule must be an object")

    active_season = raw.get("active_season", SEASON_IDS[0])
    if active_season not in SEASON_IDS:
        raise ScheduleValidationError(f"Unknown season: {active_season!r}")

    gradient_end = _gradient_end(
        raw.get("gradient_end", DEFAULT_GRADIENT_END)
    )
    raw_entities = raw.get("entities", {})
    if not isinstance(raw_entities, dict):
        raise ScheduleValidationError("entities must be an object")

    entities: dict[str, Any] = {}
    for entity_id, entity_data in raw_entities.items():
        if (
            not isinstance(entity_id, str)
            or not entity_id.startswith(f"{CLIMATE_DOMAIN}.")
            or not isinstance(entity_data, dict)
        ):
            raise ScheduleValidationError(
                f"Invalid climate entity schedule: {entity_id!r}"
            )

        raw_seasons = entity_data.get("seasons", {})
        if not isinstance(raw_seasons, dict):
            raise ScheduleValidationError(
                f"{entity_id}: seasons must be an object"
            )

        entity_seasons: dict[str, Any] = {}
        for season_id in SEASON_IDS:
            raw_week = raw_seasons.get(season_id, {})
            if not isinstance(raw_week, dict):
                raise ScheduleValidationError(
                    f"{entity_id}/{season_id}: week must be an object"
                )

            week = empty_week()
            for day in DAYS:
                raw_blocks = raw_week.get(day, [])
                if not isinstance(raw_blocks, list):
                    raise ScheduleValidationError(
                        f"{entity_id}/{season_id}/{day}: periods must be a list"
                    )

                periods: list[dict[str, Any]] = []
                for raw_block in raw_blocks:
                    if not isinstance(raw_block, dict):
                        raise ScheduleValidationError(
                            f"{entity_id}/{season_id}/{day}: invalid period"
                        )
                    start = raw_block.get("start")
                    end = raw_block.get("end")
                    start_minutes = _clock_minutes(start)
                    end_minutes = _clock_minutes(end, end=True)
                    if end_minutes <= start_minutes:
                        raise ScheduleValidationError(
                            f"{entity_id}/{season_id}/{day}: end must follow start"
                        )

                    mode = raw_block.get("mode")
                    if mode not in KNOWN_HVAC_MODES:
                        raise ScheduleValidationError(
                            f"{entity_id}/{season_id}/{day}: unknown HVAC mode {mode!r}"
                        )
                    periods.append(
                        {
                            "start": start,
                            "end": end,
                            "temperature": _temperature(
                                raw_block.get("temperature")
                            ),
                            "mode": mode,
                        }
                    )

                periods.sort(key=lambda period: _clock_minutes(period["start"]))
                previous_end = 0
                for period in periods:
                    period_start = _clock_minutes(period["start"])
                    if period_start < previous_end:
                        raise ScheduleValidationError(
                            f"{entity_id}/{season_id}/{day}: periods overlap"
                        )
                    previous_end = _clock_minutes(period["end"], end=True)
                week[day] = periods

            entity_seasons[season_id] = week

        entities[entity_id] = {"seasons": entity_seasons}

    return {
        "revision": 0,
        "active_season": active_season,
        "seasons": [dict(season) for season in SEASONS],
        "gradient_end": gradient_end,
        "entities": entities,
    }


class ClimateScheduleManager:
    """Own persistent schedule data and apply active periods."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store[dict[str, Any]] = Store(
            hass,
            STORAGE_VERSION,
            STORAGE_KEY,
            atomic_writes=True,
        )
        self._document = default_document()
        self._lock = asyncio.Lock()
        self._cancel_timer: Any = None
        self._last_applied: dict[str, tuple[Any, ...]] = {}

    @property
    def active_season(self) -> str:
        """Return the active season without copying the schedule document."""
        return self._document["active_season"]

    @property
    def snapshot(self) -> dict[str, Any]:
        """Return an isolated document safe to send to a frontend client."""
        return deepcopy(self._document)

    async def async_initialize(self) -> None:
        """Load storage and start the minute-boundary runner."""
        stored = await self._store.async_load()
        if stored is not None:
            try:
                document = normalise_document(stored)
                document["revision"] = max(0, int(stored.get("revision", 0)))
                self._document = document
            except (ScheduleValidationError, TypeError, ValueError):
                _LOGGER.exception(
                    "Stored Climate Schedule data is invalid; starting empty"
                )

        self._cancel_timer = async_track_time_change(
            self.hass,
            self._async_minute_tick,
            second=0,
        )
        await self.async_apply()

    async def async_stop(self) -> None:
        """Stop schedule execution."""
        if self._cancel_timer is not None:
            self._cancel_timer()
            self._cancel_timer = None

    async def async_save(
        self, raw: Any, expected_revision: int
    ) -> dict[str, Any]:
        """Validate, revision-check, persist, and apply a schedule document."""
        async with self._lock:
            if expected_revision != self._document["revision"]:
                raise RevisionConflictError(
                    "The schedule changed in another browser; reload and retry"
                )
            document = normalise_document(raw)
            document["revision"] = self._document["revision"] + 1
            await self._store.async_save(document)
            self._document = document

        self.hass.bus.async_fire(
            EVENT_UPDATED, {"revision": document["revision"]}
        )
        await self.async_apply()
        return self.snapshot

    async def async_set_active_season(self, season_id: str) -> dict[str, Any]:
        """Persist a new active season and immediately enforce it."""
        if season_id not in SEASON_IDS:
            raise ScheduleValidationError(f"Unknown season: {season_id!r}")

        async with self._lock:
            if season_id == self._document["active_season"]:
                return self.snapshot
            document = deepcopy(self._document)
            document["active_season"] = season_id
            document["revision"] += 1
            await self._store.async_save(document)
            self._document = document

        self.hass.bus.async_fire(
            EVENT_UPDATED, {"revision": document["revision"]}
        )
        await self.async_apply(force=True)
        return self.snapshot

    async def _async_minute_tick(self, now: datetime) -> None:
        """Apply any period that has just become active."""
        await self.async_apply(now=now)

    async def async_apply(
        self, *, now: datetime | None = None, force: bool = False
    ) -> None:
        """Apply every entity's currently active period once."""
        local_now = dt_util.as_local(now or dt_util.now())
        day = DAYS[local_now.weekday()]
        minute = local_now.hour * 60 + local_now.minute
        season_id = self._document["active_season"]

        for entity_id, entity_data in self._document["entities"].items():
            periods = entity_data["seasons"][season_id][day]
            active = next(
                (
                    period
                    for period in periods
                    if _clock_minutes(period["start"])
                    <= minute
                    < _clock_minutes(period["end"], end=True)
                ),
                None,
            )
            if active is None:
                self._last_applied.pop(entity_id, None)
                continue

            signature = (
                season_id,
                day,
                active["start"],
                active["end"],
                active["mode"],
                active["temperature"],
            )
            if not force and self._last_applied.get(entity_id) == signature:
                continue

            state = self.hass.states.get(entity_id)
            if state is None or state.state in {"unknown", "unavailable"}:
                _LOGGER.debug("Climate entity %s is not available", entity_id)
                continue

            supported = state.attributes.get("hvac_modes", [])
            mode = active["mode"]
            if supported and mode not in supported:
                _LOGGER.warning(
                    "Skipping unsupported HVAC mode %s for %s",
                    mode,
                    entity_id,
                )
                self._last_applied[entity_id] = signature
                continue

            try:
                if state.state != mode:
                    await self.hass.services.async_call(
                        CLIMATE_DOMAIN,
                        SERVICE_SET_HVAC_MODE,
                        {"entity_id": entity_id, ATTR_HVAC_MODE: mode},
                        blocking=True,
                    )

                if mode != "off":
                    await self.hass.services.async_call(
                        CLIMATE_DOMAIN,
                        SERVICE_SET_TEMPERATURE,
                        {
                            "entity_id": entity_id,
                            ATTR_TEMPERATURE: active["temperature"],
                        },
                        blocking=True,
                    )
            except HomeAssistantError:
                _LOGGER.exception(
                    "Could not apply Climate Schedule period to %s",
                    entity_id,
                )
                continue

            self._last_applied[entity_id] = signature
            _LOGGER.debug(
                "Applied %s %s at %s to %s",
                mode,
                active["temperature"],
                active["start"],
                entity_id,
            )

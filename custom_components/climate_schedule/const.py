"""Constants for the Climate Schedule integration."""

from __future__ import annotations

DOMAIN = "climate_schedule"

STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1

SERVICE_SET_ACTIVE_SEASON = "set_active_season"
SERVICE_APPLY_NOW = "apply_now"

EVENT_UPDATED = f"{DOMAIN}_updated"

DAYS = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)

SEASONS = (
    {
        "id": "winter",
        "name": "Winter",
        "icon": "❄️",
        "default_mode": "heat",
    },
    {
        "id": "summer",
        "name": "Summer",
        "icon": "☀️",
        "default_mode": "cool",
    },
    {
        "id": "shoulder",
        "name": "Spring / Fall",
        "icon": "🍃",
        "default_mode": "auto",
    },
)

SEASON_IDS = tuple(season["id"] for season in SEASONS)

KNOWN_HVAC_MODES = (
    "off",
    "heat",
    "cool",
    "auto",
    "heat_cool",
    "dry",
    "fan_only",
)

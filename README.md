# Platform Tasks — Home Assistant integration

Native HA `todo` integration for the [Platform](https://github.com/) tasks
service. Each platform project becomes a `todo.platform_<project>` entity.
A `sensor.platform_tasks_upcoming` feed drives countdown-style cards.

## Install via HACS

1. HACS → ⋮ → Custom Repositories → add this repo URL, category **Integration**
2. HACS → search **Platform Tasks** → Download
3. Restart Home Assistant
4. Settings → Devices & Services → **+ Add Integration** → Platform Tasks
5. Enter your gateway URL and a `pat_*` personal access token

## Configuration

The integration prompts for two values at install time:

| Field | Example |
|-------|---------|
| Gateway URL | `https://your-gateway.example.com` |
| Personal access token | `pat_...` minted at `/api/auth/api-tokens` |

## What it creates

- One `todo.platform_<project>` entity per project (CRUD wired)
- One `sensor.platform_tasks_upcoming` with `attributes.tasks` for the next 7 days

## Removing

Settings → Devices & Services → Platform Tasks → Delete.
The personal access token can be revoked separately at the gateway.

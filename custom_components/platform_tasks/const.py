"""Constants for the Platform Tasks integration."""
from __future__ import annotations

DOMAIN = "platform_tasks"

CONF_BASE_URL = "base_url"
CONF_TOKEN = "token"

DEFAULT_BASE_URL = "https://platform.example.com"
DEFAULT_SCAN_INTERVAL_SECONDS = 60
UPCOMING_WINDOW_DAYS = 7

# API paths under {base_url}/api/tasks
PATH_PROJECTS = "/api/tasks/projects"
PATH_SMART_ALL = "/api/tasks/smart/all"
PATH_SMART_NEXT7 = "/api/tasks/smart/next7"
PATH_TASKS = "/api/tasks/tasks"  # POST = create
PATH_TASK = "/api/tasks/tasks/{id}"  # PATCH / DELETE
PATH_TASK_COMPLETE = "/api/tasks/tasks/{id}/complete"

# Auth check during config_flow
PATH_AUTH_ME = "/api/auth/me"

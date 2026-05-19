"""Natural-language quick-add parser.

Mirrors the web's `frontend-v2/src/lib/components/tasks/quickAddParser.ts`
contract — same chip syntax (`~Project @user #tag !1-4`) and same recurrence
phrases — and extends it with two natural-language fallbacks the web doesn't
support today:

  * ``"... to <Project>"`` resolves to a project hint when no ``~Project``
    token is present and the trailing capitalized phrase matches a known
    project name (case-insensitive, prefix-allowed).
  * ``"... <Username>"`` resolves to an assignee when no ``@user`` token is
    present and the trailing word matches a known user (display name OR
    login, case-insensitive).

The parser intentionally has zero third-party deps so it ships inside the
HACS bundle as-is — chrono-node bundles aren't tractable on Python and
`dateparser` would push the integration past a clean install.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
import re
from typing import Any


@dataclass
class Parsed:
    title: str
    due_at: datetime | None = None
    is_all_day: bool = True
    priority: int = 0
    tags: list[str] = field(default_factory=list)
    project_hint: str | None = None
    project_id: str | None = None
    assignee_username: str | None = None
    assignee_user_id: str | None = None
    repeat_flag: str | None = None

    def to_payload(self) -> dict[str, Any]:
        body: dict[str, Any] = {"title": self.title}
        if self.project_id:
            body["projectId"] = self.project_id
        if self.priority:
            body["priority"] = self.priority
        if self.due_at is not None:
            body["dueDate"] = self.due_at.isoformat()
            body["isAllDay"] = self.is_all_day
        if self.repeat_flag:
            body["repeatFlag"] = self.repeat_flag
        if self.tags:
            body["tags"] = self.tags
        if self.assignee_user_id:
            body["assigneeUserId"] = self.assignee_user_id
        return body


# ── Token regexes ─────────────────────────────────────────────────────────

_PRIORITY_RE = re.compile(r"(?:^|\s)!([1-4])(?=\s|$)")
_TAG_RE = re.compile(r"(?:^|\s)#([A-Za-z0-9_-]+)")
# `~Multi Word` runs until the next chip marker or end of string.
_PROJECT_RE = re.compile(r"(?:^|\s)~([A-Za-z0-9_][A-Za-z0-9_\- ]*?)(?=\s[!#@]|$)")
_ASSIGNEE_RE = re.compile(r"(?:^|\s)@([A-Za-z0-9_.-]+)")

_DAYS = {
    "monday": 0, "mon": 0,
    "tuesday": 1, "tue": 1, "tues": 1,
    "wednesday": 2, "wed": 2,
    "thursday": 3, "thu": 3, "thur": 3, "thurs": 3,
    "friday": 4, "fri": 4,
    "saturday": 5, "sat": 5,
    "sunday": 6, "sun": 6,
}
_DAY_TO_RRULE = {
    0: "MO", 1: "TU", 2: "WE", 3: "TH", 4: "FR", 5: "SA", 6: "SU",
}

# Order matters: try the most specific patterns first.
_RECURRENCE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.I),
     "RRULE:FREQ=WEEKLY;BYDAY={byday}"),
    (re.compile(r"\bevery\s+day\b", re.I), "RRULE:FREQ=DAILY"),
    (re.compile(r"\bdaily\b", re.I), "RRULE:FREQ=DAILY"),
    (re.compile(r"\bevery\s+week\b", re.I), "RRULE:FREQ=WEEKLY"),
    (re.compile(r"\bweekly\b", re.I), "RRULE:FREQ=WEEKLY"),
    (re.compile(r"\bevery\s+month\b", re.I), "RRULE:FREQ=MONTHLY"),
    (re.compile(r"\bmonthly\b", re.I), "RRULE:FREQ=MONTHLY"),
    (re.compile(r"\bevery\s+year\b", re.I), "RRULE:FREQ=YEARLY"),
    (re.compile(r"\byearly\b", re.I), "RRULE:FREQ=YEARLY"),
    (re.compile(r"\bannually\b", re.I), "RRULE:FREQ=YEARLY"),
]

# Date phrase regexes. Each returns (matched_text, resolved_date) when fed
# into a `now`.
_DATE_PATTERNS = [
    # "tomorrow", "tmrw"
    re.compile(r"\btomorrow\b|\btmrw\b", re.I),
    # "today", "tonight"
    re.compile(r"\btoday\b|\btonight\b", re.I),
    # "now"
    re.compile(r"\bnow\b", re.I),
    # "next week"
    re.compile(r"\bnext\s+week\b", re.I),
    # "next monday", "this monday"
    re.compile(r"\b(?:next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b", re.I),
    # "in N {minute|hour|day|week}s?"
    re.compile(r"\bin\s+(\d+)\s+(minute|min|hour|hr|day|week|wk)s?\b", re.I),
    # bare weekday name → next occurrence (incl. today if not yet past)
    re.compile(r"\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.I),
    # "MM/DD" or "MM/DD/YYYY"
    re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b"),
]

# Time phrase: "at 2pm", "at 2:30pm", "2pm", "2:30pm", "14:30"
_TIME_RE = re.compile(
    r"\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(?:at\s+)?(\d{1,2}):(\d{2})\b",
    re.I,
)


def _resolve_date(match_text: str, m: re.Match[str], now: datetime) -> date | None:
    """Map a regex hit to an actual date relative to `now`."""
    text = match_text.lower()
    if "tomorrow" in text or "tmrw" in text:
        return (now + timedelta(days=1)).date()
    if "today" in text or "tonight" in text or text.strip() == "now":
        return now.date()
    if text.startswith("next week"):
        return (now + timedelta(days=7)).date()
    if text.startswith(("next ", "this ")):
        # next/this <weekday>
        day_word = m.group(1).lower()
        target = _DAYS.get(day_word)
        if target is None:
            return None
        delta = (target - now.weekday()) % 7
        if text.startswith("next ") and delta == 0:
            delta = 7
        if text.startswith("this ") and delta == 0:
            # "this monday" when today is Monday → today.
            delta = 0
        return (now + timedelta(days=delta or 0)).date()
    in_m = re.match(r"in\s+(\d+)\s+(minute|min|hour|hr|day|week|wk)s?", text)
    if in_m:
        n = int(in_m.group(1))
        unit = in_m.group(2)
        if unit.startswith("min"):
            return None  # handled as time, not date
        if unit.startswith(("hour", "hr")):
            return None
        if unit.startswith(("day",)):
            return (now + timedelta(days=n)).date()
        if unit.startswith(("week", "wk")):
            return (now + timedelta(days=7 * n)).date()
    slash = re.match(r"(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?$", text)
    if slash:
        try:
            mm = int(slash.group(1))
            dd = int(slash.group(2))
            yyyy_part = slash.group(3)
            if yyyy_part:
                yy = int(yyyy_part)
                if yy < 100:
                    yy += 2000
            else:
                yy = now.year
                # If the date already passed this year, roll to next year.
                tentative = date(yy, mm, dd)
                if tentative < now.date():
                    yy += 1
            return date(yy, mm, dd)
        except ValueError:
            return None
    # bare weekday
    day_word = text.strip()
    if day_word in _DAYS:
        target = _DAYS[day_word]
        delta = (target - now.weekday()) % 7
        if delta == 0:
            delta = 7  # don't collapse a bare weekday to today — feels wrong
        return (now + timedelta(days=delta)).date()
    return None


def _resolve_time(text: str) -> tuple[time, str] | None:
    """Parse a time phrase out of `text`. Returns (time, matched_substring)."""
    m = _TIME_RE.search(text)
    if not m:
        return None
    if m.group(3):  # am/pm variant
        h = int(m.group(1))
        mm = int(m.group(2) or 0)
        ampm = m.group(3).lower()
        if ampm == "pm" and h < 12:
            h += 12
        if ampm == "am" and h == 12:
            h = 0
    else:  # 24h variant
        h = int(m.group(4))
        mm = int(m.group(5))
    if not (0 <= h <= 23 and 0 <= mm <= 59):
        return None
    return time(h, mm), m.group(0)


def _extract_in_duration(text: str, now: datetime) -> tuple[datetime, str] | None:
    """`in 30 minutes` / `in 2 hours` → absolute datetime + matched text."""
    m = re.search(r"\bin\s+(\d+)\s+(minute|min|hour|hr)s?\b", text, re.I)
    if not m:
        return None
    n = int(m.group(1))
    unit = m.group(2).lower()
    if unit.startswith("min"):
        return now + timedelta(minutes=n), m.group(0)
    return now + timedelta(hours=n), m.group(0)


def _strip(text: str, span: str) -> str:
    """Remove a substring, collapse whitespace."""
    return re.sub(r"\s+", " ", text.replace(span, " ", 1)).strip()


def _match_project(hint: str, projects: list[dict[str, Any]]) -> str | None:
    """Case-insensitive exact-then-prefix match against project names."""
    if not hint or not projects:
        return None
    needle = hint.strip().lower()
    for p in projects:
        if (p.get("name") or "").lower() == needle:
            return p["id"]
    # Prefix fallback only if exactly one project starts with the hint —
    # ambiguous prefixes never get resolved silently.
    candidates = [p for p in projects if (p.get("name") or "").lower().startswith(needle)]
    if len(candidates) == 1:
        return candidates[0]["id"]
    return None


def _match_user(hint: str, users: list[dict[str, Any]]) -> str | None:
    if not hint or not users:
        return None
    needle = hint.strip().lower()
    for u in users:
        if (u.get("username") or "").lower() == needle:
            return u["id"]
        if (u.get("displayName") or "").lower() == needle:
            return u["id"]
    return None


def parse_quick_add(
    raw: str,
    projects: list[dict[str, Any]] | None = None,
    users: list[dict[str, Any]] | None = None,
    now: datetime | None = None,
    default_project_id: str | None = None,
) -> Parsed:
    """Parse a natural-language task input.

    `projects` and `users` are used to resolve ``~Project`` / ``@user`` chips
    to ids, and to power the "to ProjectName" / trailing-name heuristics.
    Without them, hints stay unresolved and the platform falls back to the
    authenticated user's personal project.
    """
    projects = projects or []
    users = users or []
    if now is None:
        now = datetime.now().astimezone()
    elif now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc).astimezone()

    work = raw.strip()
    if not work:
        return Parsed(title="")

    parsed = Parsed(title="")
    tz = now.tzinfo or timezone.utc

    # ── Priority ──
    pri_m = _PRIORITY_RE.search(work)
    if pri_m:
        parsed.priority = int(pri_m.group(1))
        work = _strip(work, pri_m.group(0))

    # ── Tags ──
    while True:
        m = _TAG_RE.search(work)
        if not m:
            break
        tag = m.group(1)
        if tag not in parsed.tags:
            parsed.tags.append(tag)
        work = _strip(work, m.group(0))

    # ── Project (~chip) ──
    proj_m = _PROJECT_RE.search(work)
    if proj_m:
        parsed.project_hint = proj_m.group(1).strip()
        parsed.project_id = _match_project(parsed.project_hint, projects)
        work = _strip(work, proj_m.group(0))

    # ── Assignee (@chip) ──
    asn_m = _ASSIGNEE_RE.search(work)
    if asn_m:
        parsed.assignee_username = asn_m.group(1)
        parsed.assignee_user_id = _match_user(parsed.assignee_username, users)
        work = _strip(work, asn_m.group(0))

    # ── Recurrence ──
    for pat, rrule_tpl in _RECURRENCE_PATTERNS:
        m = pat.search(work)
        if m:
            if "{byday}" in rrule_tpl:
                day = m.group(1).lower()
                # Map short → long if needed.
                idx = _DAYS.get(day)
                if idx is None:
                    continue
                parsed.repeat_flag = rrule_tpl.format(byday=_DAY_TO_RRULE[idx])
            else:
                parsed.repeat_flag = rrule_tpl
            work = _strip(work, m.group(0))
            break

    # ── Date ──
    matched_date: date | None = None
    for pat in _DATE_PATTERNS:
        m = pat.search(work)
        if not m:
            continue
        d = _resolve_date(m.group(0), m, now)
        if d is None:
            continue
        matched_date = d
        work = _strip(work, m.group(0))
        break

    # ── Time ──
    matched_time: time | None = None
    t_hit = _resolve_time(work)
    if t_hit is not None:
        matched_time, t_span = t_hit
        work = _strip(work, t_span)

    # "in 30 minutes" / "in 2 hours" supersedes a date+time pair.
    rel_hit = _extract_in_duration(work, now)
    if rel_hit is not None:
        parsed.due_at = rel_hit[0]
        parsed.is_all_day = False
        work = _strip(work, rel_hit[1])
    elif matched_date is not None or matched_time is not None:
        d = matched_date or now.date()
        if matched_time is not None:
            parsed.due_at = datetime.combine(d, matched_time, tzinfo=tz)
            parsed.is_all_day = False
        else:
            parsed.due_at = datetime.combine(d, time(0, 0), tzinfo=tz)
            parsed.is_all_day = True

    # ── "to <known-project>" trailing heuristic (only if ~ wasn't used) ──
    if parsed.project_id is None and projects:
        # Match longest trailing project name first.
        names_sorted = sorted(
            (p for p in projects if p.get("name")),
            key=lambda p: -len(p["name"]),
        )
        lowered = work.lower()
        for p in names_sorted:
            name = p["name"].strip()
            if not name:
                continue
            needle = f" to {name.lower()}"
            if lowered.endswith(needle):
                parsed.project_hint = name
                parsed.project_id = p["id"]
                # Strip the " to <Name>" suffix from the title.
                work = work[: -len(needle)].rstrip()
                break

    # ── Trailing known-username as assignee (only if @ wasn't used) ──
    if parsed.assignee_user_id is None and users:
        # Try the last word, then the last two words (display names can be
        # 2-word strings like "Madiha S").
        tokens = work.split()
        for take in (2, 1):
            if len(tokens) < take + 1:  # need at least take+1 words so a
                continue                # bare "Madiha" task still keeps a title
            tail = " ".join(tokens[-take:])
            uid = _match_user(tail, users)
            if uid:
                parsed.assignee_user_id = uid
                parsed.assignee_username = tail
                work = " ".join(tokens[:-take])
                break

    # Apply default project last.
    if parsed.project_id is None and default_project_id:
        parsed.project_id = default_project_id

    parsed.title = re.sub(r"\s+", " ", work).strip()
    return parsed

"""The activity report (Administrator): an Excel workbook of what everyone did in a week, a month or any period.

    Summary       the period and its totals
    Users         one row per user: status, days active, sign-ins, actions, wrong passwords, and the work itself
                  (annotation, inspection / acceptance, dataset cleaning - workload.stats for the period)
    Daily         actions per user per day
    Activity log  every line of the log in the period
"""
import calendar
import datetime as dt
import io

from sqlalchemy import select

from ..core import db
from ..core.db import Activity, User
from ..core.storage import now
from . import workload
from .activity import LABELS
from .roles import ROLES

SIGN = ("login", "login.failed", "logout")


def period(kind, day=None, since="", until=""):
    """("week" | "month" | "custom", "YYYY-MM-DD" in the period) -> (since, until, title). A week is Monday - Sunday."""
    d = _date(day) or dt.date.today()
    if kind == "week":
        a = d - dt.timedelta(days=d.weekday())
        b = a + dt.timedelta(days=6)
        return a.isoformat(), b.isoformat(), f"Week {a.isocalendar()[1]}, {a:%d %b %Y} - {b:%d %b %Y}"
    if kind == "month":
        a, b = d.replace(day=1), d.replace(day=calendar.monthrange(d.year, d.month)[1])
        return a.isoformat(), b.isoformat(), f"{a:%B %Y}"
    a, b = _date(since), _date(until)
    if not a or not b:
        raise ValueError("Choose the first and the last day of the report")
    if a > b:
        a, b = b, a
    if (b - a).days > 366:
        raise ValueError("A report covers at most one year")
    return a.isoformat(), b.isoformat(), f"{a:%d %b %Y} - {b:%d %b %Y}"


def _date(v):
    try:
        return dt.date.fromisoformat((v or "")[:10]) if v else None
    except ValueError:
        raise ValueError(f"Not a date: {v!r} (use YYYY-MM-DD)")


def build(since, until, title):
    """The workbook as bytes."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    with db.transaction() as s:
        users = {u.username: u for u in s.scalars(select(User))}
        log = list(s.scalars(select(Activity).where(Activity.at >= since, Activity.at <= until + " 99")
                             .order_by(Activity.at, Activity.id)))
    work = {r["username"]: r for r in workload.stats(since, until)["users"]}
    days = [(dt.date.fromisoformat(since) + dt.timedelta(days=k)).isoformat()
            for k in range((dt.date.fromisoformat(until) - dt.date.fromisoformat(since)).days + 1)]

    per = {}   # username -> counts in the period
    for a in log:
        p = per.setdefault(a.username, {"actions": 0, "logins": 0, "failed": 0, "days": {}, "first": a.at, "last": a.at})
        n = a.count or 1
        p["last"] = a.at
        if a.action == "login":
            p["logins"] += n
        elif a.action == "login.failed":
            p["failed"] += n
        elif a.action != "logout":
            p["actions"] += n
            p["days"][a.at[:10]] = p["days"].get(a.at[:10], 0) + n
    order = lambda name: (list(ROLES).index(users[name].role) if name in users and users[name].role in ROLES else 99, name)
    names = sorted(set(users) | set(per) | set(work), key=order)

    wb = Workbook()
    head_font, head_fill = Font(bold=True, color="FFFFFF"), PatternFill("solid", fgColor="1D4ED8")
    idle_fill = PatternFill("solid", fgColor="FEF3C7")

    def table(ws, header, rows, widths=None):
        ws.append(header)
        for c in ws[ws.max_row]:
            c.font, c.fill, c.alignment = head_font, head_fill, Alignment(vertical="center", wrap_text=True)
        start = ws.max_row
        for r in rows:
            ws.append(r)
        ws.freeze_panes = ws.cell(row=start + 1, column=1)
        ws.auto_filter.ref = f"A{start}:{get_column_letter(len(header))}{max(ws.max_row, start)}"
        for k, h in enumerate(header, 1):
            ws.column_dimensions[get_column_letter(k)].width = (widths or {}).get(h, max(10, min(40, len(str(h)) + 4)))

    def status(u):
        return ("Deleted" if not u else "Deactivated" if not u.active else "Never signed in" if not u.last_login
                else "Default password" if u.must_change else "Active")

    def role(name):
        u = users.get(name)
        return ROLES.get(u.role, (u.role,))[0] if u else ""

    hours = lambda secs: round((secs or 0) / 3600, 2)

    # ---- Users ----
    ws = wb.active
    ws.title = "Users"
    rows = []
    for name in names:
        u, p, w = users.get(name), per.get(name) or {}, work.get(name) or {}
        an, rv, cl = w.get("annotation") or {}, w.get("review") or {}, w.get("cleaning") or {}
        rows.append([name, u.name if u else name, role(name), status(u), len(p.get("days") or {}), p.get("logins", 0),
                     p.get("actions", 0), p.get("failed", 0), p.get("first", ""), p.get("last", ""),
                     an.get("done", 0), hours(an.get("done_seconds")), an.get("accepted", 0), hours(an.get("accepted_seconds")),
                     an.get("returned", 0), an.get("in_progress", 0), rv.get("inspected", 0), rv.get("accepted", 0),
                     rv.get("returned", 0), cl.get("accepted", 0), cl.get("rejected", 0), hours(cl.get("accepted_seconds"))])
    table(ws, ["Username", "Full Name", "Role", "Account", "Days active", "Sign-ins", "Actions", "Wrong passwords",
               "First activity", "Last activity", "Packages annotated", "Hours annotated", "Packages accepted",
               "Accepted hours", "Times returned", "Packages in progress", "Inspections passed", "Acceptances given",
               "Returns given", "Dataset clips accepted", "Dataset clips rejected", "Clip hours accepted"], rows,
          {"Username": 16, "Full Name": 26, "Role": 18, "Account": 18, "First activity": 20, "Last activity": 20})
    for r in ws.iter_rows(min_row=2):
        if r[4].value == 0 and r[3].value == "Active":   # an active account that did nothing in the period
            for c in r:
                c.fill = idle_fill

    # ---- Daily ----
    ws = wb.create_sheet("Daily")
    table(ws, ["Username", "Full Name", "Role", *days, "Total"],
          [[n, users[n].name if n in users else n, role(n), *[(per.get(n) or {}).get("days", {}).get(d, 0) for d in days],
            (per.get(n) or {}).get("actions", 0)] for n in names],
          {"Username": 16, "Full Name": 26, "Role": 18, **{d: 11 for d in days}})

    # ---- Activity log ----
    ws = wb.create_sheet("Activity log")
    table(ws, ["Time", "Username", "Full Name", "Role", "Action", "Details", "Result", "Times", "IP"],
          [[a.at, a.username, users[a.username].name if a.username in users else "", ROLES.get(a.role, (a.role,))[0],
            LABELS.get(a.action, a.action), a.detail, "OK" if a.ok else "Refused", a.count or 1, a.ip] for a in log],
          {"Time": 20, "Username": 16, "Full Name": 24, "Role": 18, "Action": 30, "Details": 60, "IP": 16})

    # ---- Summary (first sheet) ----
    ws = wb.create_sheet("Summary", 0)
    active = [u for u in users.values() if u.active]
    t = lambda group, key: sum(((work.get(n) or {}).get(group) or {}).get(key, 0) for n in names)
    lines = [
        ("Activity report", title), ("Period", f"{since} to {until} ({len(days)} days)"), ("Made", now()), (),
        ("Active accounts", len(active)),
        ("Worked in the period", sum(1 for u in active if (per.get(u.username) or {}).get("actions"))),
        ("Did nothing in the period", sum(1 for u in active if not (per.get(u.username) or {}).get("actions"))),
        ("Sign-ins", sum(p["logins"] for p in per.values())), ("Wrong passwords", sum(p["failed"] for p in per.values())),
        ("Actions", sum(p["actions"] for p in per.values())), (),
        ("Packages annotated", t("annotation", "done")), ("Hours annotated", hours(t("annotation", "done_seconds"))),
        ("Packages accepted", t("annotation", "accepted")), ("Accepted hours", hours(t("annotation", "accepted_seconds"))),
        ("Times returned", t("annotation", "returned")),
        ("Dataset clips accepted", t("cleaning", "accepted")), ("Dataset clips rejected", t("cleaning", "rejected")),
        ("Clip hours accepted", hours(t("cleaning", "accepted_seconds"))), (),
        ("Sheets", "Users: one row per user (yellow = active account that did nothing) · Daily: actions per day · "
                   "Activity log: every line"),
    ]
    for line in lines:
        ws.append(list(line))
    ws["A1"].font, ws["B1"].font = Font(bold=True, size=14), Font(bold=True, size=14)
    for r in ws.iter_rows(min_row=2):
        r[0].font = Font(bold=True)
    ws.column_dimensions["A"].width, ws.column_dimensions["B"].width = 28, 60

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()

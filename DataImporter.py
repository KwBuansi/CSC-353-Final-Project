"""
Read every quiz CSV in the data folder, update MySQL, and refresh the heatmap JSON.

Setup:
  1. Set MYSQL_PASSWORD below (empty string if none).
  2. Run:  mysql -u root -p < grades_tool.sql
  3. Put one or more response exports in data/ as *.csv (only quiz response sheets).

Run:  python DataImporter.py

Each CSV must include these Form question titles (case-insensitive match OK):
  First Name, Last Name, Student ID, Semester, Year, Course, Section

Quiz scores: any other column whose cells mostly look like grades (0–100, %, or x/y)
is treated as one quiz. The column header text is used as the quiz name on the heatmap.
If the column is only named something generic like "Total points" or "Score", the quiz
name is taken from the CSV file name instead (e.g. data/Week3Quiz.csv -> "Week3Quiz").

MySQL: rows are loaded into the normalized tables (users/semesters/courses/sections/
students/enrollments/assignments/grades). The denormalized view `grade_rows` is defined
in `grades_tool.sql` and reflects whatever is in those tables after each import.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple
from urllib.parse import quote_plus

import pandas as pd
from sqlalchemy import create_engine, text

# --- Edit these if needed ---------------------------------------------------

MYSQL_USER = "root"
MYSQL_PASSWORD = "KB8335191832!?"  # set your password here, or "" for none
MYSQL_HOST = "localhost"
MYSQL_PORT = 3306
MYSQL_DATABASE = "FinalProject"

# Synthetic teacher row for sections.teacher_id (required by schema).
IMPORTER_TEACHER_NAME = "Grade Importer"
IMPORTER_TEACHER_EMAIL = "importer@grades.local"
IMPORTER_TEACHER_PASSWORD_PLACEHOLDER = "not-used-for-login"

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
JSON_PATH = DATA_DIR / "grades_snapshot.json"

# JSON rows for the heatmap (same shape as before).
JSON_ROW_KEYS = (
    "student_number",
    "student_name",
    "assignment_name",
    "grade_percent",
    "course_code",
    "course_name",
    "season",
    "year",
    "section_label",
)

# sections.id must encode A/B in the ones digit: ...1 => A, ...2 => B (see _section_pk;
# must match grade_rows view in grades_tool.sql).

# --- Required identity columns (Google Form question titles) ---------------

REQUIRED = {
    "first_name": "First Name",
    "last_name": "Last Name",
    "student_id": "Student ID",
    "semester": "Semester",
    "year": "Year",
    "course": "Course",
    "section": "Section",
}

# Columns that are never treated as quiz score columns (normalized, lowercased).
RESERVED_HEADER_LOWER = {
    "timestamp",
    "first name",
    "last name",
    "student id",
    "semester",
    "year",
    "course",
    "section",
    "email address",
    "email",
}

# Generic score headers → use the CSV file stem as the quiz name instead.
GENERIC_SCORE_HEADER = re.compile(
    r"^(total\s*points?|score|your\s*score|your\s*grade|points?\s*earned|grade)$",
    re.I,
)


def _norm_header(value: Any) -> str:
    return str("" if value is None else value).replace("\ufeff", "").strip()


def _cell(row: pd.Series, col: str) -> str:
    val = row[col]
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return ""
    return str(val).strip()


def _map_columns(columns: List[str]) -> Dict[str, str]:
    by_norm = {_norm_header(c): c for c in columns}
    out: Dict[str, str] = {}
    for key, title in REQUIRED.items():
        if title in by_norm:
            out[key] = by_norm[title]
            continue
        low = {k.lower(): v for k, v in by_norm.items()}
        if title.lower() in low:
            out[key] = low[title.lower()]
            continue
        raise SystemExit(f'Missing column "{title}" in CSV. Found: {list(columns)}')
    return out


def _parse_percent(raw: Any) -> float | None:
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return None
    t = str(raw).strip()
    if not t:
        return None
    m = re.match(r"^(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)$", t)
    if m:
        a, b = float(m.group(1)), float(m.group(2))
        return (a / b) * 100 if b > 0 else None
    m = re.match(r"^(\d+(?:\.\d+)?)\s*%$", t)
    if m:
        return float(m.group(1))
    try:
        x = float(t.replace(",", ""))
    except ValueError:
        return None
    return x if 0 <= x <= 100 else None


def _season(raw: str) -> str:
    s = raw.strip().lower()
    m = {"fall": "Fall", "spring": "Spring", "summer": "Summer"}
    if s not in m:
        raise ValueError(f"Semester must be Fall, Spring, or Summer (got {raw!r})")
    return m[s]


def _year(raw: str) -> int:
    y = int(float(raw.strip()))
    if y < 1990 or y > 2100:
        raise ValueError(f"Bad year: {raw!r}")
    return y


def _section(raw: str) -> str:
    s = raw.strip().upper()
    if s not in ("A", "B"):
        raise ValueError("Section must be A or B")
    return s


def _column_looks_like_scores(series: pd.Series) -> bool:
    """True if a solid fraction of non-empty cells parse as 0–100 style grades."""
    nonempty = 0
    good = 0
    for raw in series:
        if raw is None or (isinstance(raw, float) and pd.isna(raw)):
            continue
        if str(raw).strip() == "":
            continue
        nonempty += 1
        if _parse_percent(raw) is not None:
            good += 1
    if nonempty == 0:
        return False
    return good >= max(2, int(0.25 * nonempty))


def _quiz_name_for_column(column_header: str, file_stem: str) -> str:
    h = _norm_header(column_header)
    if GENERIC_SCORE_HEADER.match(h):
        return file_stem.strip() or "Quiz"
    return h if h else file_stem


def _discover_score_columns(df: pd.DataFrame, colmap: Dict[str, str]) -> List[str]:
    mapped: Set[str] = set(colmap.values())
    out: List[str] = []
    for c in df.columns:
        if c in mapped:
            continue
        if _norm_header(c).lower() in RESERVED_HEADER_LOWER:
            continue
        if _column_looks_like_scores(df[c]):
            out.append(c)
    return out


def _engine():
    user = quote_plus(MYSQL_USER)
    if MYSQL_PASSWORD:
        pw = quote_plus(MYSQL_PASSWORD)
        url = f"mysql+pymysql://{user}:{pw}@{MYSQL_HOST}:{MYSQL_PORT}/{MYSQL_DATABASE}"
    else:
        url = f"mysql+pymysql://{user}@{MYSQL_HOST}:{MYSQL_PORT}/{MYSQL_DATABASE}"
    return create_engine(url)


def _student_import_email(student_number: str) -> str:
    """Stable synthetic email so Student ID round-trips through the view."""
    local = re.sub(r"[^a-zA-Z0-9._+-]", "_", student_number.strip())[:100] or "unknown"
    return f"{local}@student.import"


def _section_pk(course_id: int, semester_id: int, section_label: str) -> int:
    """Deterministic sections.id; ones digit 1=A, 2=B for the view."""
    tail = 1 if section_label.upper() == "A" else 2
    return course_id * 1000 + semester_id * 10 + tail


def _dedupe_rows_for_db(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Last row wins for the same student / course offering / assignment (matches heatmap pivot)."""
    merged: Dict[Tuple[str, str, str, int, str, str], Dict[str, Any]] = {}
    for r in rows:
        key = (
            r["student_number"],
            r["course_code"],
            r["season"],
            int(r["year"]),
            r["section_label"],
            r["assignment_name"],
        )
        merged[key] = r
    return list(merged.values())


def _build_rows(file_stem: str, df: pd.DataFrame, col: Dict[str, str], score_cols: List[str]) -> List[Dict[str, Any]]:
    if not score_cols:
        return []

    rows: List[Dict[str, Any]] = []
    for score_col in score_cols:
        quiz_name = _quiz_name_for_column(score_col, file_stem)[:200]

        for _, row in df.iterrows():
            fn, ln = _cell(row, col["first_name"]), _cell(row, col["last_name"])
            sn = _cell(row, col["student_id"])
            course = _cell(row, col["course"])
            if not sn or not fn or not ln or not course:
                continue
            pct = _parse_percent(row[score_col])
            if pct is None:
                continue
            try:
                season = _season(_cell(row, col["semester"]))
                year = _year(_cell(row, col["year"]))
                section = _section(_cell(row, col["section"]))
            except ValueError:
                continue

            rows.append(
                {
                    "student_number": sn,
                    "first_name": fn,
                    "last_name": ln,
                    "student_name": f"{fn} {ln}".strip(),
                    "assignment_name": quiz_name,
                    "grade_percent": round(float(pct), 2),
                    "course_code": course[:20],
                    "course_name": course[:150],
                    "season": season,
                    "year": year,
                    "section_label": section,
                }
            )
    return rows


def _ensure_teacher(conn: Any) -> int:
    conn.execute(
        text(
            """
            INSERT IGNORE INTO users (name, email, password)
            VALUES (:name, :email, :pw)
            """
        ),
        {
            "name": IMPORTER_TEACHER_NAME,
            "email": IMPORTER_TEACHER_EMAIL,
            "pw": IMPORTER_TEACHER_PASSWORD_PLACEHOLDER,
        },
    )
    rid = conn.execute(
        text("SELECT id FROM users WHERE email = :e LIMIT 1"),
        {"e": IMPORTER_TEACHER_EMAIL},
    ).scalar_one()
    return int(rid)


def _semester_id(conn: Any, season: str, year: int) -> int:
    conn.execute(
        text("INSERT IGNORE INTO semesters (season, year) VALUES (:s, :y)"),
        {"s": season, "y": year},
    )
    sid = conn.execute(
        text("SELECT id FROM semesters WHERE season = :s AND year = :y LIMIT 1"),
        {"s": season, "y": year},
    ).scalar_one()
    return int(sid)


def _course_id(conn: Any, code: str, name: str) -> int:
    row = conn.execute(
        text("SELECT id FROM courses WHERE code = :c LIMIT 1"),
        {"c": code},
    ).first()
    if row:
        cid = int(row[0])
        conn.execute(
            text("UPDATE courses SET name = :n WHERE id = :id"),
            {"n": name, "id": cid},
        )
        return cid
    conn.execute(
        text(
            """
            INSERT INTO courses (code, name, department)
            VALUES (:code, :name, NULL)
            """
        ),
        {"code": code, "name": name},
    )
    cid = conn.execute(
        text("SELECT id FROM courses WHERE code = :c LIMIT 1"),
        {"c": code},
    ).scalar_one()
    return int(cid)


def _student_id(conn: Any, first_name: str, last_name: str, student_number: str) -> int:
    em = _student_import_email(student_number)
    conn.execute(
        text(
            """
            INSERT INTO students (first_name, last_name, email)
            VALUES (:fn, :ln, :em)
            ON DUPLICATE KEY UPDATE
              first_name = VALUES(first_name),
              last_name = VALUES(last_name)
            """
        ),
        {"fn": first_name[:50], "ln": last_name[:50], "em": em},
    )
    rid = conn.execute(
        text("SELECT id FROM students WHERE email = :em LIMIT 1"),
        {"em": em},
    ).scalar_one()
    return int(rid)


def _assignment_id(conn: Any, section_id: int, name: str) -> int:
    row = conn.execute(
        text(
            "SELECT id FROM assignments WHERE section_id = :sid AND name = :n LIMIT 1"
        ),
        {"sid": section_id, "n": name[:150]},
    ).first()
    if row:
        return int(row[0])
    conn.execute(
        text(
            """
            INSERT INTO assignments (section_id, name)
            VALUES (:sid, :n)
            """
        ),
        {"sid": section_id, "n": name[:150]},
    )
    aid = conn.execute(
        text(
            "SELECT id FROM assignments WHERE section_id = :sid AND name = :n LIMIT 1"
        ),
        {"sid": section_id, "n": name[:150]},
    ).scalar_one()
    return int(aid)


def _sync_normalized_mysql(rows: List[Dict[str, Any]]) -> None:
    eng = _engine()
    with eng.begin() as conn:
        conn.execute(text("SET FOREIGN_KEY_CHECKS=0"))
        for tbl in (
            "grades",
            "enrollments",
            "assignments",
            "sections",
            "students",
            "courses",
            "semesters",
        ):
            conn.execute(text(f"TRUNCATE TABLE {tbl}"))
        conn.execute(text("SET FOREIGN_KEY_CHECKS=1"))

        teacher_id = _ensure_teacher(conn)

        for r in rows:
            cid = _course_id(conn, r["course_code"], r["course_name"])
            sem_id = _semester_id(conn, r["season"], int(r["year"]))
            sec_id = _section_pk(cid, sem_id, r["section_label"])
            conn.execute(
                text(
                    """
                    INSERT INTO sections (id, course_id, semester_id, teacher_id)
                    VALUES (:id, :cid, :semid, :tid)
                    ON DUPLICATE KEY UPDATE
                      course_id = VALUES(course_id),
                      semester_id = VALUES(semester_id),
                      teacher_id = VALUES(teacher_id)
                    """
                ),
                {
                    "id": sec_id,
                    "cid": cid,
                    "semid": sem_id,
                    "tid": teacher_id,
                },
            )

            sid = _student_id(conn, r["first_name"], r["last_name"], r["student_number"])
            conn.execute(
                text(
                    """
                    INSERT IGNORE INTO enrollments (student_id, section_id)
                    VALUES (:sid, :secid)
                    """
                ),
                {"sid": sid, "secid": sec_id},
            )

            aid = _assignment_id(conn, sec_id, r["assignment_name"])
            conn.execute(
                text(
                    """
                    INSERT INTO grades (student_id, assignment_id, grade_percent)
                    VALUES (:sid, :aid, :pct)
                    ON DUPLICATE KEY UPDATE grade_percent = VALUES(grade_percent)
                    """
                ),
                {"sid": sid, "aid": aid, "pct": r["grade_percent"]},
            )


def main() -> None:
    csv_paths = sorted(p for p in DATA_DIR.glob("*.csv") if p.is_file())
    if not csv_paths:
        raise SystemExit(
            f"No .csv files in {DATA_DIR}\n"
            "Add one or more Form response exports (download as CSV from Google Sheets)."
        )

    rows_raw: List[Dict[str, Any]] = []
    for path in csv_paths:
        df = pd.read_csv(path, dtype=str, encoding="utf-8-sig")
        df.columns = [_norm_header(c) for c in df.columns]
        try:
            col = _map_columns(list(df.columns))
        except SystemExit as e:
            raise SystemExit(f"{path.name}: {e.args[0] if e.args else e}") from e

        score_cols = _discover_score_columns(df, col)
        if not score_cols:
            continue

        chunk = _build_rows(path.stem, df, col, score_cols)
        rows_raw.extend(chunk)

    if not rows_raw:
        raise SystemExit("No valid grade rows from any CSV (check columns and score cells).")

    rows_for_json = _dedupe_rows_for_db(rows_raw)
    json_rows = [{k: r[k] for k in JSON_ROW_KEYS} for r in rows_for_json]

    JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "database": MYSQL_DATABASE,
        "rows": json_rows,
    }
    JSON_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    _sync_normalized_mysql(rows_for_json)


if __name__ == "__main__":
    main()

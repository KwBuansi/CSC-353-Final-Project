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
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Set
from urllib.parse import quote_plus

import pandas as pd
from sqlalchemy import create_engine, text
from sqlalchemy.types import DECIMAL, Integer, String

# --- Edit these if needed ---------------------------------------------------

MYSQL_USER = "root"
MYSQL_PASSWORD = ""  # set your password here, or "" for none
MYSQL_HOST = "localhost"
MYSQL_PORT = 3306
MYSQL_DATABASE = "FinalExam"

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
JSON_PATH = DATA_DIR / "grades_snapshot.json"

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
                    "student_name": f"{fn} {ln}".strip(),
                    "assignment_name": quiz_name,
                    "grade_percent": round(float(pct), 2),
                    "course_code": course,
                    "course_name": course,
                    "season": season,
                    "year": year,
                    "section_label": section,
                }
            )
    return rows


def main() -> None:
    csv_paths = sorted(p for p in DATA_DIR.glob("*.csv") if p.is_file())
    if not csv_paths:
        raise SystemExit(
            f"No .csv files in {DATA_DIR}\n"
            "Add one or more Form response exports (download as CSV from Google Sheets)."
        )

    rows_out: List[Dict[str, Any]] = []
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
        rows_out.extend(chunk)

    if not rows_out:
        raise SystemExit("No valid grade rows from any CSV (check columns and score cells).")

    JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "database": MYSQL_DATABASE,
        "rows": rows_out,
    }
    JSON_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    out_df = pd.DataFrame(rows_out)
    eng = _engine()
    with eng.begin() as conn:
        conn.execute(text("TRUNCATE TABLE grade_rows"))
    out_df.to_sql(
        "grade_rows",
        con=eng,
        if_exists="append",
        index=False,
        dtype={
            "student_number": String(64),
            "student_name": String(255),
            "assignment_name": String(200),
            "grade_percent": DECIMAL(5, 2),
            "course_code": String(64),
            "course_name": String(200),
            "season": String(20),
            "year": Integer(),
            "section_label": String(1),
        },
    )


if __name__ == "__main__":
    main()
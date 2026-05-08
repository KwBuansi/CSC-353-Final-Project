# CSC 353 Final — Quiz QR + grade heatmap

## Workflow

1. **Google Form** — Quiz mode. Required short-answer titles (case-insensitive match OK):  
   `First Name`, `Last Name`, `Student ID`, `Semester`, `Year`, `Course`, `Section`  
   Section is **A** or **B** only (single-section → **A**).

2. **Home page** — Create QR codes for the form link (optional for your process).

3. **CSV files** — Download each form’s responses as CSV from Google Sheets and save **one or more** files under **`data/`** with a **`.csv`** extension (for example `data/Week3Quiz.csv`, `data/Midterm.csv`).  
   - **Quiz name on the heatmap** = the **column header** for that quiz’s scores (e.g. `Polynomials Quiz`).  
   - If Google only gives a generic header like `Total points` or `Score`, the script uses the **CSV file name** (without `.csv`) as the quiz name—name the file accordingly (e.g. `Week3Quiz.csv`).

4. **MySQL** — Create / reset the simple schema:

   ```bash
   mysql -u root -p < grades_tool.sql
   ```

5. **Run the importer** — Edit `MYSQL_PASSWORD` (and host/user/db if needed) at the top of `DataImporter.py`, install deps, then run:

   ```bash
   pip install -r requirements.txt
   python DataImporter.py
   ```

   This reads **every `data/*.csv`**, writes **`data/grades_snapshot.json`** for the site, and **reloads** the normalized MySQL tables (the flat **`grade_rows`** view in `grades_tool.sql` reflects that data).

6. **View heatmap** — Use a local web server so the browser can load the JSON:

   ```bash
   python -m http.server 8080
   ```

   Open `http://localhost:8080/ViewGrades.html` and use the filters.

## Optional config

Override the JSON URL by defining `window.__VIEW_GRADES_CONFIG__.gradesJsonUrl` before `view-grades.js` (see `js/config.local.example.js`).

## Notes

- The browser does not talk to MySQL; it reads `data/grades_snapshot.json`.
- That JSON file is gitignored; run `DataImporter.py` again after you add or change CSVs.

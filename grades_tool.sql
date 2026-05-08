CREATE DATABASE IF NOT EXISTS FinalExam;
USE FinalExam;

-- One denormalized table: one row per student per quiz import (heatmap + simple SQL queries).

DROP VIEW IF EXISTS assignment_averages;
DROP VIEW IF EXISTS grade_detail;
DROP TABLE IF EXISTS grade_rows;

CREATE TABLE grade_rows (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_number VARCHAR(64) NOT NULL,
    student_name VARCHAR(255) NOT NULL,
    assignment_name VARCHAR(200) NOT NULL,
    grade_percent DECIMAL(5,2) NOT NULL,
    course_code VARCHAR(64) NOT NULL,
    course_name VARCHAR(200) NOT NULL,
    season VARCHAR(20) NOT NULL,
    year INT NOT NULL,
    section_label ENUM('A', 'B') NOT NULL,
    imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_grade_percent CHECK (grade_percent BETWEEN 0 AND 100)
);

CREATE VIEW grade_detail AS
SELECT
    student_number,
    student_name,
    assignment_name,
    grade_percent,
    course_code,
    course_name,
    season,
    year,
    section_label
FROM grade_rows;

CREATE VIEW assignment_averages AS
SELECT
    course_code,
    course_name,
    assignment_name,
    season,
    year,
    section_label,
    ROUND(AVG(grade_percent), 2) AS avg_grade,
    COUNT(*) AS num_grades
FROM grade_detail
GROUP BY course_code, course_name, assignment_name, season, year, section_label;

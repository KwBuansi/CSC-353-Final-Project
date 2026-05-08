CREATE DATABASE IF NOT EXISTS FinalProject;
USE FinalProject;

-- -------------------------------
-- Drop views
-- -------------------------------
DROP VIEW IF EXISTS assignment_averages;
DROP VIEW IF EXISTS grade_detail;
DROP VIEW IF EXISTS grade_rows;

-- -------------------------------
-- Drop tables
-- -------------------------------
DROP TABLE IF EXISTS grades;
DROP TABLE IF EXISTS enrollments;
DROP TABLE IF EXISTS assignments;
DROP TABLE IF EXISTS sections;
DROP TABLE IF EXISTS students;
DROP TABLE IF EXISTS courses;
DROP TABLE IF EXISTS semesters;



-- -------------------------------
-- Semesters
-- -------------------------------
CREATE TABLE semesters (
    id INT AUTO_INCREMENT PRIMARY KEY,
    season ENUM('Fall', 'Spring', 'Summer') NOT NULL,
    year YEAR NOT NULL,
    UNIQUE KEY uq_semester (season, year)
);

-- -------------------------------
-- Courses
-- -------------------------------
CREATE TABLE courses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(20) NOT NULL,          -- e.g. "CSC 353"
    name VARCHAR(150) NOT NULL,         -- e.g. "Database Systems"
    department VARCHAR(100)
);

-- -------------------------------
-- Sections
-- -------------------------------
CREATE TABLE sections (
    id INT PRIMARY KEY,
    course_id INT NOT NULL,
    semester_id INT NOT NULL,
    teacher_id INT NOT NULL,
    FOREIGN KEY (course_id) REFERENCES courses(id),
    FOREIGN KEY (semester_id) REFERENCES semesters(id),
    FOREIGN KEY (teacher_id) REFERENCES users(id)
);

-- -------------------------------
-- Students
-- -------------------------------
CREATE TABLE students (
    id INT AUTO_INCREMENT PRIMARY KEY,
    first_name VARCHAR(50) NOT NULL,
    last_name VARCHAR(50) NOT NULL,
    email VARCHAR(150) UNIQUE
);

-- -------------------------------
-- Enrollments
-- -------------------------------
CREATE TABLE enrollments (
    student_id INT NOT NULL,
    section_id INT NOT NULL,
    PRIMARY KEY(student_id, section_id),
    FOREIGN KEY (student_id) REFERENCES students(id),
    FOREIGN KEY (section_id) REFERENCES sections(id)
);

-- -------------------------------
-- Assignments
-- -------------------------------
CREATE TABLE assignments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    section_id INT NOT NULL,
    name VARCHAR(150) NOT NULL,         -- e.g. "Test 1", "HW 3"
    FOREIGN KEY (section_id) REFERENCES sections(id)
);

-- -------------------------------
-- Grades
-- -------------------------------
CREATE TABLE grades (
    student_id INT NOT NULL,
    assignment_id INT NOT NULL,
    grade_percent DECIMAL(5,2) CHECK (grade_percent BETWEEN 0 AND 100),
    PRIMARY KEY (student_id, assignment_id),
    FOREIGN KEY (student_id) REFERENCES students(id),
    FOREIGN KEY (assignment_id) REFERENCES assignments(id)
);



-- -------------------------------
-- View: grade_rows (flat shape for tools / DataImporter; matches normalized data)
-- Requires sections.id from the importer: ones digit 1 = section A, 2 = section B.
-- Student ID from forms is stored as the local part of email ...@student.import.
-- -------------------------------
CREATE VIEW grade_rows AS
SELECT
    SUBSTRING_INDEX(s.email, '@', 1) AS student_number,
    TRIM(CONCAT(s.first_name, ' ', s.last_name)) AS student_name,
    a.name AS assignment_name,
    g.grade_percent,
    c.code AS course_code,
    c.name AS course_name,
    sem.season,
    sem.year,
    CASE MOD(sec.id, 10)
        WHEN 1 THEN 'A'
        WHEN 2 THEN 'B'
        ELSE '?'
    END AS section_label
FROM grades g
JOIN students s       ON g.student_id = s.id
JOIN assignments a    ON g.assignment_id = a.id
JOIN sections sec     ON a.section_id = sec.id
JOIN courses c        ON sec.course_id = c.id
JOIN semesters sem    ON sec.semester_id = sem.id;

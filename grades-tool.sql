USE FinalProject;

DROP TABLE IF EXISTS grades;
DROP TABLE IF EXISTS enrollments;
DROP TABLE IF EXISTS assignments;
DROP TABLE IF EXISTS sections;
DROP TABLE IF EXISTS students;
DROP TABLE IF EXISTS courses;
DROP TABLE IF EXISTS semesters;
DROP TABLE IF EXISTS users;



CREATE TABLE users (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    email       VARCHAR(150) NOT NULL UNIQUE,
    password    VARCHAR(255) NOT NULL,       
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Academic semesters (e.g. Fall 2023, Spring 2024)
CREATE TABLE semesters (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    season      ENUM('Fall', 'Spring', 'Summer') NOT NULL,
    year        YEAR NOT NULL,
    UNIQUE KEY uq_semester (season, year)
);

-- Courses (e.g. CSC 353, MATH 201)
CREATE TABLE courses (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    code        VARCHAR(20)  NOT NULL,       -- e.g. "CSC 353"
    name        VARCHAR(150) NOT NULL,       -- e.g. "Database Systems"
    department  VARCHAR(100)
);

-- A specific offering of a course in a semester, taught by a teacher
CREATE TABLE sections (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    course_id   INT NOT NULL,
    semester_id INT NOT NULL,
    teacher_id  INT NOT NULL,
    FOREIGN KEY (course_id)   REFERENCES courses(id),
    FOREIGN KEY (semester_id) REFERENCES semesters(id),
    FOREIGN KEY (teacher_id)  REFERENCES users(id)
);

-- Students enrolled in the school
CREATE TABLE students (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    email       VARCHAR(150) UNIQUE,
    class_year  ENUM('Freshman', 'Sophomore', 'Junior', 'Senior'),
    major       VARCHAR(100),
);

-- Which students are in which course section
CREATE TABLE enrollments (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    student_id          INT NOT NULL,
    section_id   INT NOT NULL,
    UNIQUE KEY uq_enrollment (student_id, section_id),
    FOREIGN KEY (student_id)         REFERENCES students(id),
    FOREIGN KEY (section_id)  REFERENCES sections(id)
);

-- Assignments belonging to a course section
CREATE TABLE assignments (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    section_id   		INT NOT NULL,
    name                VARCHAR(150) NOT NULL,   -- e.g. "Test 1", "HW 3"
    type                ENUM('Test', 'Homework', 'Project', 'Quiz', 'Other') NOT NULL,
    FOREIGN KEY (section_id) REFERENCES sections(id)
);

-- Grades: one row per student per assignment
CREATE TABLE grades (
    student_id      INT NOT NULL,
    assignment_id   INT NOT NULL,
    grade_percent   DECIMAL(5,2) CHECK (grade_percent BETWEEN 0 AND 100),
    PRIMARY KEY (student_id, assignment_id),    -- one grade per student per assignment
    FOREIGN KEY (student_id)    REFERENCES students(id),
    FOREIGN KEY (assignment_id) REFERENCES assignments(id)
);
-- Useful view to see all grade information
CREATE VIEW grade_detail AS
SELECT
    g.id            AS grade_id,
    g.grade_percent,
    s.id            AS student_id,
    s.name          AS student_name,
    s.class_year,
    s.major,
    s.is_major,
    a.id            AS assignment_id,
    a.name          AS assignment_name,
    a.type          AS assignment_type,
    c.id            AS course_id,
    c.code          AS course_code,
    c.name          AS course_name,
    sem.season,
    sem.year
FROM grades g
JOIN students       s   ON g.student_id    = s.id
JOIN assignments    a   ON g.assignment_id = a.id
JOIN course_sections cs ON a.course_section_id = cs.id
JOIN courses        c   ON cs.course_id    = c.id
JOIN semesters      sem ON cs.semester_id  = sem.id;

-- View to look at assignment averages from specific years for grade inflation tracking 
CREATE VIEW assignment_averages AS
SELECT
    course_code,
    course_name,
    assignment_name,
    assignment_type,
    season,
    year,
    ROUND(AVG(grade_percent), 2) AS avg_grade,
    COUNT(*)                     AS num_grades
FROM grade_detail
GROUP BY course_code, course_name, assignment_name, assignment_type, season, year;

-- Get all grades for a section:
SELECT student_name, assignment_name, grade_percent FROM grade_detail WHERE course_code = 'CSC 353' AND season = 'Fall' AND year = 2024;

-- Get class average for an assignment (to spot areas of difficulty):
SELECT assignment_name, assignment_type, ROUND(AVG(grade_percent), 2) AS avg FROM grade_detail WHERE course_code = 'CSC 353' AND year = 2024 GROUP BY assignment_name, assignment_type;

-- Get average per student across assignments (to spot struggling students)
SELECT student_name, ROUND(AVG(grade_percent), 2) AS avg FROM grade_detail WHERE course_code = 'CSC 353' AND year = 2024 GROUP BY student_name ORDER BY avg ASC;

-- Get average in course across multiple years (to look at grade inflation):
SELECT year, season, ROUND(AVG(grade_percent), 2) AS avg FROM grade_detail WHERE course_code = 'CSC 353' GROUP BY year, season ORDER BY year, season;

-- Filter by assignment type:
SELECT student_name, assignment_name, grade_percent FROM grade_detail WHERE course_code = 'CSC 353' AND assignment_type = 'Test';


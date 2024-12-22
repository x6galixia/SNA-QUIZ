// Backend: Node.js/Express
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const app = express();
const port = 3000;

// PostgreSQL Pool Setup
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'education_db',
    password: '1234',
    port: 5432,
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'secret_key',
    resave: false,
    saveUninitialized: true,
}));

// View Engine
app.set('view engine', 'ejs');
app.set('views', './views');

// Routes
app.get('/', (req, res) => {
    res.render('login'); // Login page
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

    if (user.rows.length > 0 && bcrypt.compareSync(password, user.rows[0].password)) {
        req.session.userId = user.rows[0].id;
        req.session.role = user.rows[0].role;
        res.redirect(user.rows[0].role === 'teacher' ? '/teacher/dashboard' : '/student/dashboard');
    } else {
        res.send('Invalid credentials');
    }
});

app.get('/signup', (req, res) => {
    res.render('signup'); // Signup page
});

app.post('/signup', async (req, res) => {
    const { fullname, username, password, role, year_section } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 10);

    await pool.query('INSERT INTO users (fullname, username, password, role, year_section) VALUES ($1, $2, $3, $4, $5)',
        [fullname, username, hashedPassword, role, role === 'student' ? year_section : null]);

    res.redirect('/');
});

app.get('/teacher/dashboard', async (req, res) => {
    if (req.session.role !== 'teacher') return res.redirect('/');

    // Fetch all students
    const students = await pool.query('SELECT * FROM users WHERE role = $1', ['student']);

    // Fetch all quizzes that the teacher has created
    const quizzes = await pool.query('SELECT * FROM quizzes WHERE teacher_id = $1', [req.session.userId]);

    // Fetch the latest score for each student and quiz
    const quizScores = await Promise.all(quizzes.rows.map(async (quiz) => {
        const scores = await pool.query(
            `SELECT scores.student_id, scores.score, scores.attempt_number, users.fullname 
            FROM scores
            JOIN users ON users.id = scores.student_id
            WHERE scores.quiz_id = $1
            ORDER BY scores.attempt_number DESC`,
            [quiz.id]
        );

        // Group the scores by student and only include the latest attempt
        const latestScores = students.rows.map(student => {
            const studentScore = scores.rows.find(score => score.student_id === student.id);
            return {
                student: student,
                score: studentScore ? studentScore.score : null, // null if not attempted
                attempt_number: studentScore ? studentScore.attempt_number : null
            };
        });

        return { quiz, latestScores };
    }));

    // Render the teacher dashboard with the quiz data and student scores
    res.render('teacher_dashboard', { quizScores });
});

app.get('/student/dashboard', async (req, res) => {
    if (req.session.role !== 'student') return res.redirect('/');

    const quizzes = await pool.query('SELECT * FROM quizzes');
    const studentId = req.session.userId;

    // Get the list of quizzes the student has already attempted
    const attempts = await pool.query(
        'SELECT quiz_id, MAX(attempt_number) AS last_attempt FROM scores WHERE student_id = $1 GROUP BY quiz_id',
        [studentId]
    );

    // Convert attempts to a Set for easier lookup
    const attemptedQuizzes = new Set(attempts.rows.map(row => row.quiz_id));

    res.render('student_dashboard', { quizzes: quizzes.rows, attemptedQuizzes });
});


app.get('/teacher/add-quiz', (req, res) => {
    if (req.session.role !== 'teacher') return res.redirect('/');
    res.render('add_quiz'); // Add Quiz page
});

app.post('/teacher/add-quiz', async (req, res) => {
    const { title, questions } = req.body;
    const teacherId = req.session.userId;

    const quiz = await pool.query('INSERT INTO quizzes (title, teacher_id) VALUES ($1, $2) RETURNING id', [title, teacherId]);
    const quizId = quiz.rows[0].id;

    for (const question of questions) {
        const { question_text, option_a, option_b, option_c, option_d, correct_answer } = question;
        await pool.query(
            'INSERT INTO questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_answer) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [quizId, question_text, option_a, option_b, option_c, option_d, correct_answer]
        );
    }

    res.redirect('/teacher/dashboard');
});

// Route to view a specific quiz
app.get('/quiz/:id', async (req, res) => {
    const quizId = req.params.id;
    
    // Fetch quiz details and associated questions from the database
    const quiz = await pool.query('SELECT * FROM quizzes WHERE id = $1', [quizId]);
    if (quiz.rows.length === 0) {
        return res.status(404).send('Quiz not found');
    }

    const questions = await pool.query('SELECT * FROM questions WHERE quiz_id = $1', [quizId]);

    res.render('quiz', { quiz: quiz.rows[0], questions: questions.rows });
});


app.post('/quiz/:id/submit', async (req, res) => {
    const quizId = req.params.id;
    const userAnswers = req.body;

    // Fetch questions for the quiz
    const questions = await pool.query('SELECT * FROM questions WHERE quiz_id = $1', [quizId]);

    let score = 0;
    questions.rows.forEach((question, index) => {
        if (userAnswers[`question${index}`] === question.correct_answer) {
            score++;
        }
    });

    // Get the current highest attempt number for this student and quiz
    const result = await pool.query(
        'SELECT MAX(attempt_number) AS max_attempt FROM scores WHERE student_id = $1 AND quiz_id = $2',
        [req.session.userId, quizId]
    );
    const maxAttempt = result.rows[0].max_attempt || 0;  // Default to 0 if no previous attempts

    // Check if a score already exists for this student and quiz
    const existingScore = await pool.query(
        'SELECT * FROM scores WHERE student_id = $1 AND quiz_id = $2 AND attempt_number = $3',
        [req.session.userId, quizId, maxAttempt + 1]
    );

    if (existingScore.rows.length > 0) {
        // Update the score for the existing entry
        await pool.query(
            'UPDATE scores SET score = $1 WHERE student_id = $2 AND quiz_id = $3 AND attempt_number = $4',
            [score, req.session.userId, quizId, maxAttempt + 1]
        );
    } else {
        // Insert a new score with the next attempt number
        await pool.query(
            'INSERT INTO scores (student_id, quiz_id, score, attempt_number) VALUES ($1, $2, $3, $4)',
            [req.session.userId, quizId, score, maxAttempt + 1]
        );
    }

    res.send(`Your score is ${score} out of ${questions.rows.length}`);
});

app.post('/teacher/delete-quiz/:id', async (req, res) => {
    if (req.session.role !== 'teacher') return res.redirect('/');

    const quizId = req.params.id;

    try {
        // Start a transaction to ensure atomicity
        await pool.query('BEGIN');

        // Delete associated questions
        await pool.query('DELETE FROM questions WHERE quiz_id = $1', [quizId]);

        // Delete the quiz
        await pool.query('DELETE FROM quizzes WHERE id = $1 AND teacher_id = $2', [quizId, req.session.userId]);

        // Commit the transaction
        await pool.query('COMMIT');

        res.redirect('/teacher/dashboard');
    } catch (error) {
        // Roll back in case of any errors
        await pool.query('ROLLBACK');
        console.error('Error deleting quiz:', error);
        res.status(500).send('An error occurred while deleting the quiz.');
    }
});


app.get('/quiz/:id/retake', (req, res) => {
    const quizId = req.params.id;

    // Fetch the quiz and questions
    pool.query('SELECT * FROM quizzes WHERE id = $1', [quizId], (err, quizResult) => {
        if (err) throw err;

        pool.query('SELECT * FROM questions WHERE quiz_id = $1', [quizId], (err, questionResult) => {
            if (err) throw err;

            const quiz = quizResult.rows[0];
            const questions = questionResult.rows;

            // Render the quiz again for the student to retake
            res.render('quiz', { quiz, questions });
        });
    });
});



app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).send('Could not log out');
        }
        res.redirect('/'); // Redirect to the login page after logging out
    });
});


// Start Server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
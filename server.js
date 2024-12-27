const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = 3000;

// PostgreSQL Pool Setup
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'education_db',
    password: '//*//',
    port: 5433,
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
    session({
        secret: 'secret_key',
        resave: false,
        saveUninitialized: true,
    })
);

// View Engine
app.set('view engine', 'ejs');
app.set('views', './views');


app.use(express.static('public'));
app.use(express.static(path.join(__dirname, 'public')));
// Routes

// Login Page
app.get('/', (req, res) => {
    res.render('login');
});

// Login Logic
app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

        if (user.rows.length > 0) {
            const isValidPassword = await bcrypt.compare(password, user.rows[0].password);

            if (isValidPassword) {
                req.session.userId = user.rows[0].id;
                req.session.role = user.rows[0].role;
                return res.redirect(user.rows[0].role === 'teacher' ? '/teacher/dashboard' : '/student/dashboard');
            }
        }

        res.status(401).send('Invalid credentials');
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).send('An error occurred while logging in.');
    }
});

// Signup Page
app.get('/signup', (req, res) => {
    res.render('signup');
});

// Signup Logic
app.post('/signup', async (req, res) => {
    const { fullname, username, password, role, year_section } = req.body;

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        await pool.query(
            'INSERT INTO users (fullname, username, password, role, year_section) VALUES ($1, $2, $3, $4, $5)',
            [fullname, username, hashedPassword, role, role === 'student' ? year_section : null]
        );

        res.redirect('/');
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).send('An error occurred while signing up.');
    }
});

// Teacher Dashboard
app.get('/teacher/dashboard', async (req, res) => {
    if (req.session.role !== 'teacher') return res.redirect('/');

    try {
        const students = await pool.query('SELECT * FROM users WHERE role = $1', ['student']);
        const quizzes = await pool.query('SELECT * FROM quizzes WHERE teacher_id = $1', [req.session.userId]);

        const quizScores = await Promise.all(
            quizzes.rows.map(async (quiz) => {
                const scores = await pool.query(
                    `SELECT scores.student_id, scores.score, scores.attempt_number, users.fullname 
                     FROM scores
                     JOIN users ON users.id = scores.student_id
                     WHERE scores.quiz_id = $1
                     ORDER BY scores.attempt_number DESC`,
                    [quiz.id]
                );

                return { quiz, scores: scores.rows };
            })
        );

        res.render('teacher_dashboard', { quizScores, students: students.rows });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).send('An error occurred while loading the dashboard.');
    }
});

// Student Dashboard
app.get('/student/dashboard', async (req, res) => {
    if (req.session.role !== 'student') return res.redirect('/');

    try {
        const quizzes = await pool.query('SELECT * FROM quizzes');
        const studentId = req.session.userId;

        // Fetch the quizzes the student has already attempted
        const attempts = await pool.query(
            'SELECT quiz_id FROM scores WHERE student_id = $1 GROUP BY quiz_id',
            [studentId]
        );

        // Convert the results to a Set of attempted quiz IDs
        const attemptedQuizzes = new Set(attempts.rows.map(row => row.quiz_id));

        res.render('student_dashboard', {
            quizzes: quizzes.rows,
            attemptedQuizzes
        });
    } catch (error) {
        console.error('Student dashboard error:', error);
        res.status(500).send('An error occurred while loading the dashboard.');
    }
});


// Add Quiz Page
app.get('/teacher/add-quiz', (req, res) => {
    if (req.session.role !== 'teacher') return res.redirect('/');
    res.render('add_quiz');
});

// Add Quiz Logic
app.post('/teacher/add-quiz', async (req, res) => {
    const { title, questions } = req.body;

    try {
        const quiz = await pool.query('INSERT INTO quizzes (title, teacher_id) VALUES ($1, $2) RETURNING id', [
            title,
            req.session.userId,
        ]);
        const quizId = quiz.rows[0].id;

        for (const question of questions) {
            const { question_text, option_a, option_b, option_c, option_d, correct_answer } = question;
            await pool.query(
                'INSERT INTO questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_answer) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [quizId, question_text, option_a, option_b, option_c, option_d, correct_answer]
            );
        }

        res.redirect('/teacher/dashboard');
    } catch (error) {
        console.error('Add quiz error:', error);
        res.status(500).send('An error occurred while adding the quiz.');
    }
});

// Quiz Page
app.get('/quiz/:id', async (req, res) => {
    const quizId = req.params.id;

    try {
        const quiz = await pool.query('SELECT * FROM quizzes WHERE id = $1', [quizId]);
        const questions = await pool.query('SELECT * FROM questions WHERE quiz_id = $1', [quizId]);

        if (quiz.rows.length === 0) {
            return res.status(404).send('Quiz not found');
        }

        res.render('quiz', { quiz: quiz.rows[0], questions: questions.rows });
    } catch (error) {
        console.error('Quiz fetch error:', error);
        res.status(500).send('An error occurred while loading the quiz.');
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
            return res.status(500).send('An error occurred while logging out.');
        }
        res.redirect('/');
    });
});

// Start Server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

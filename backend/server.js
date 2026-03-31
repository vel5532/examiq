// ExamIQ — Production Backend Server
// Node.js + Express + MongoDB + Claude AI

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 5000;

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// ── Database Connection ───────────────────────────────────
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/examiq')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ── Mongoose Schemas ──────────────────────────────────────

// User
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true, minlength: 6 },
  role: { type: String, enum: ['student', 'admin'], default: 'student' },
  avatar: String,
  streak: { type: Number, default: 0 },
  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

// MCQ Question
const QuestionSchema = new mongoose.Schema({
  question: { type: String, required: true },
  options: { type: [String], required: true, validate: v => v.length === 4 },
  correct: { type: Number, required: true, min: 0, max: 3 },
  topic: { type: String, required: true },
  chapter: String,
  difficulty: { type: String, enum: ['Easy', 'Medium', 'Hard'], default: 'Medium' },
  explanation: String,
  concept: String,
  tags: [String],
});

// Book / MCQ Bank
const BookSchema = new mongoose.Schema({
  title: { type: String, required: true },
  subject: { type: String, required: true },
  year: String,
  source: { type: String, enum: ['PDF', 'DOCX', 'TXT', 'Manual'], default: 'PDF' },
  filename: String,
  totalMcqs: { type: Number, default: 0 },
  chapters: [String],
  questions: [QuestionSchema],
  status: { type: String, enum: ['processing', 'ready', 'error'], default: 'processing' },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
});

// Test / Exam
const TestSchema = new mongoose.Schema({
  name: { type: String, required: true },
  subject: String,
  year: String,
  duration: { type: Number, required: true }, // minutes
  difficulty: { type: String, enum: ['Easy', 'Medium', 'Hard', 'Mixed'], default: 'Medium' },
  questions: [QuestionSchema],
  totalAttempts: { type: Number, default: 0 },
  source: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isPublished: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

// Test Result
const ResultSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  testId: { type: mongoose.Schema.Types.ObjectId, ref: 'Test' },
  testName: String,
  score: Number,        // percentage
  correct: Number,
  wrong: Number,
  skipped: Number,
  accuracy: Number,     // correct / (correct + wrong) * 100
  timeTaken: Number,    // seconds
  totalQuestions: Number,
  answers: { type: Map, of: Number }, // { questionIndex: selectedOption }
  weakTopics: [{
    name: String,
    correct: Number,
    total: Number,
    accuracy: Number,
  }],
  date: { type: Date, default: Date.now },
});

const User    = mongoose.model('User', UserSchema);
const Book    = mongoose.model('Book', BookSchema);
const Test    = mongoose.model('Test', TestSchema);
const Result  = mongoose.model('Result', ResultSchema);

// ── File Upload (multer) ──────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error('Only PDF, DOCX, TXT allowed'));
  },
});

// ── Auth Middleware ───────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'examiq_secret_2024');
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
};

// ── Text Extraction ───────────────────────────────────────
async function extractText(filePath, ext) {
  try {
    if (ext === '.txt') {
      return fs.readFileSync(filePath, 'utf-8');
    }
    if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      return data.text;
    }
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }
  } catch (err) {
    console.error('Text extraction error:', err);
    return '';
  }
}

// ── AI MCQ Generation ─────────────────────────────────────
async function generateMCQsWithAI(text, subject, numMcqs, difficulty) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const chunkSize = 6000;
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize));

  const questionsPerChunk = Math.ceil(numMcqs / chunks.length);
  const allQuestions = [];

  for (const chunk of chunks.slice(0, 5)) { // Process up to 5 chunks
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `You are an expert MCQ generator for competitive exams (TNPSC/UPSC/SSC style).

Based on this text excerpt, generate ${questionsPerChunk} unique MCQ questions.
Subject: ${subject}
Difficulty: ${difficulty}

TEXT:
${chunk.slice(0, 4000)}

Return ONLY a valid JSON array. No markdown, no explanations, just JSON:
[
  {
    "topic": "Subject area",
    "chapter": "Chapter or section name",
    "difficulty": "Easy|Medium|Hard",
    "question": "Clear, specific question?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct": 0,
    "explanation": "Brief explanation of why this answer is correct.",
    "concept": "Key concept name"
  }
]

Rules:
- correct is 0-indexed (0=A, 1=B, 2=C, 3=D)
- All 4 options must be plausible and distinct
- Questions must be factual and specific
- Explanations should be educational and concise
- Mix difficulty levels if difficulty is "All"`
        }],
      });

      const raw = response.content[0].text.trim().replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(raw);
      allQuestions.push(...parsed.map((q, i) => ({ ...q, id: allQuestions.length + i + 1 })));
    } catch (err) {
      console.error('AI generation chunk error:', err.message);
    }
  }

  return allQuestions.slice(0, numMcqs);
}

// ══════════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════════

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    if (await User.findOne({ email })) return res.status(400).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email, password: hashed, role: role || 'student' });
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'examiq_secret_2024',
      { expiresIn: '30d' }
    );
    res.status(201).json({ token, user: { id: user._id, name, email, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Invalid credentials' });

    await User.findByIdAndUpdate(user._id, { lastActive: new Date() });
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'examiq_secret_2024',
      { expiresIn: '30d' }
    );
    res.json({ token, user: { id: user._id, name: user.name, email, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Me
app.get('/api/auth/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id).select('-password');
  res.json(user);
});

// ══════════════════════════════════════════════════════════
// BOOK / UPLOAD ROUTES (Admin)
// ══════════════════════════════════════════════════════════

// Upload file + generate MCQs
app.post('/api/books/upload', auth, adminOnly, upload.single('file'), async (req, res) => {
  const { title, subject, numMcqs = 100, difficulty = 'All', year } = req.body;

  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    const extractedText = await extractText(req.file.path, ext);

    // Create book record
    const book = await Book.create({
      title: title || req.file.originalname.replace(/\.[^.]+$/, ''),
      subject: subject || 'General Studies',
      year: year || new Date().getFullYear().toString(),
      source: ext.slice(1).toUpperCase(),
      filename: req.file.filename,
      status: 'processing',
      uploadedBy: req.user.id,
    });

    // Generate MCQs asynchronously
    (async () => {
      try {
        const questions = await generateMCQsWithAI(extractedText, subject, parseInt(numMcqs), difficulty);
        const chapters = [...new Set(questions.map(q => q.chapter))].filter(Boolean);
        await Book.findByIdAndUpdate(book._id, {
          questions,
          totalMcqs: questions.length,
          chapters,
          status: 'ready',
        });
        console.log(`✅ Generated ${questions.length} MCQs for "${book.title}"`);
      } catch (err) {
        await Book.findByIdAndUpdate(book._id, { status: 'error' });
        console.error('MCQ generation failed:', err.message);
      }
    })();

    // Clean up file
    fs.unlink(req.file.path, () => {});

    res.status(202).json({
      message: 'File uploaded. MCQ generation started.',
      bookId: book._id,
      estimatedTime: `${Math.ceil(parseInt(numMcqs) / 50)} minutes`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all books
app.get('/api/books', auth, async (req, res) => {
  const books = await Book.find({}).select('-questions').sort('-createdAt');
  res.json(books);
});

// Get single book with MCQs
app.get('/api/books/:id', auth, async (req, res) => {
  const book = await Book.findById(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  res.json(book);
});

// Delete book
app.delete('/api/books/:id', auth, adminOnly, async (req, res) => {
  await Book.findByIdAndDelete(req.params.id);
  res.json({ message: 'Book deleted' });
});

// Poll book status
app.get('/api/books/:id/status', auth, async (req, res) => {
  const book = await Book.findById(req.params.id).select('status totalMcqs title');
  if (!book) return res.status(404).json({ error: 'Not found' });
  res.json(book);
});

// ══════════════════════════════════════════════════════════
// MCQ ROUTES
// ══════════════════════════════════════════════════════════

// Get all MCQs (with filters)
app.get('/api/mcqs', auth, async (req, res) => {
  const { topic, difficulty, chapter, limit = 50, skip = 0, search } = req.query;
  const books = await Book.find({ status: 'ready' }).select('questions subject');
  let all = books.flatMap(b => b.questions || []);

  if (topic) all = all.filter(q => q.topic === topic);
  if (difficulty) all = all.filter(q => q.difficulty === difficulty);
  if (chapter) all = all.filter(q => q.chapter === chapter);
  if (search) all = all.filter(q => q.question.toLowerCase().includes(search.toLowerCase()));

  res.json({
    total: all.length,
    questions: all.slice(parseInt(skip), parseInt(skip) + parseInt(limit)),
  });
});

// ══════════════════════════════════════════════════════════
// TEST ROUTES
// ══════════════════════════════════════════════════════════

// Get all tests
app.get('/api/tests', auth, async (req, res) => {
  const tests = await Test.find({ isPublished: true }).select('-questions').sort('-createdAt');
  res.json(tests);
});

// Get test with questions
app.get('/api/tests/:id', auth, async (req, res) => {
  const test = await Test.findById(req.params.id);
  if (!test) return res.status(404).json({ error: 'Test not found' });
  await Test.findByIdAndUpdate(req.params.id, { $inc: { totalAttempts: 1 } });
  res.json(test);
});

// Create test (admin)
app.post('/api/tests', auth, adminOnly, async (req, res) => {
  try {
    const { name, subject, duration, difficulty, questionIds, numQuestions, bookId, year } = req.body;
    let questions = [];

    if (questionIds?.length) {
      // Use specific questions
      const books = await Book.find({});
      const allQs = books.flatMap(b => b.questions);
      questions = questionIds.map(id => allQs.find(q => q._id?.toString() === id)).filter(Boolean);
    } else if (bookId) {
      // Random from book
      const book = await Book.findById(bookId);
      if (!book) return res.status(404).json({ error: 'Book not found' });
      questions = [...book.questions].sort(() => Math.random() - 0.5).slice(0, numQuestions || 20);
    }

    const test = await Test.create({
      name, subject, duration: parseInt(duration) || 90,
      difficulty: difficulty || 'Medium',
      questions, year: year || new Date().getFullYear().toString(),
      source: bookId ? 'Book MCQ' : 'Manual',
      createdBy: req.user.id,
    });
    res.status(201).json(test);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete test
app.delete('/api/tests/:id', auth, adminOnly, async (req, res) => {
  await Test.findByIdAndDelete(req.params.id);
  res.json({ message: 'Test deleted' });
});

// ══════════════════════════════════════════════════════════
// RESULT ROUTES
// ══════════════════════════════════════════════════════════

// Submit result
app.post('/api/results', auth, async (req, res) => {
  try {
    const result = await Result.create({ ...req.body, userId: req.user.id });
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get my results
app.get('/api/results/me', auth, async (req, res) => {
  const results = await Result.find({ userId: req.user.id }).sort('-date').limit(20);
  res.json(results);
});

// My stats
app.get('/api/results/stats', auth, async (req, res) => {
  const results = await Result.find({ userId: req.user.id });
  if (!results.length) return res.json({ total: 0, avg: 0, accuracy: 0, weakTopics: [] });

  const avg = Math.round(results.reduce((a, b) => a + b.score, 0) / results.length);
  const accuracy = Math.round(results.reduce((a, b) => a + b.accuracy, 0) / results.length);

  const topicMap = {};
  results.forEach(r => (r.weakTopics || []).forEach(t => {
    if (!topicMap[t.name]) topicMap[t.name] = { correct: 0, total: 0 };
    topicMap[t.name].correct += t.correct;
    topicMap[t.name].total += t.total;
  }));
  const weakTopics = Object.entries(topicMap)
    .map(([name, d]) => ({ name, accuracy: Math.round((d.correct / d.total) * 100) }))
    .sort((a, b) => a.accuracy - b.accuracy);

  res.json({ total: results.length, avg, accuracy, weakTopics });
});

// Admin: all results
app.get('/api/results/all', auth, adminOnly, async (req, res) => {
  const results = await Result.find({})
    .populate('userId', 'name email')
    .sort('-date').limit(100);
  res.json(results);
});

// ══════════════════════════════════════════════════════════
// LEADERBOARD
// ══════════════════════════════════════════════════════════
app.get('/api/leaderboard', auth, async (req, res) => {
  const board = await Result.aggregate([
    { $group: { _id: '$userId', avgScore: { $avg: '$score' }, tests: { $sum: 1 }, avgAccuracy: { $avg: '$accuracy' } } },
    { $sort: { avgScore: -1 } },
    { $limit: 20 },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    { $project: {
      name: '$user.name',
      avgScore: { $round: ['$avgScore', 0] },
      tests: 1,
      accuracy: { $round: ['$avgAccuracy', 0] },
    }},
  ]);
  res.json(board);
});

// ══════════════════════════════════════════════════════════
// ADMIN ANALYTICS
// ══════════════════════════════════════════════════════════
app.get('/api/admin/analytics', auth, adminOnly, async (req, res) => {
  const [users, books, tests, results] = await Promise.all([
    User.countDocuments(),
    Book.countDocuments(),
    Test.countDocuments(),
    Result.countDocuments(),
  ]);
  const totalMcqs = await Book.aggregate([{ $group: { _id: null, total: { $sum: '$totalMcqs' } } }]);
  res.json({
    users, books, tests, results,
    totalMcqs: totalMcqs[0]?.total || 0,
  });
});

// ── Health Check ──────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date(), version: '2.0.0' }));

// Serve Frontend
app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Catch all routes (VERY IMPORTANT)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 ExamIQ API running on http://localhost:${PORT}`);
  console.log(`📊 MongoDB: ${process.env.MONGODB_URI || 'mongodb://localhost:27017/examiq'}`);
  console.log(`🤖 AI: ${process.env.ANTHROPIC_API_KEY ? 'Configured ✅' : 'Not configured ⚠️'}`);
});

module.exports = app;

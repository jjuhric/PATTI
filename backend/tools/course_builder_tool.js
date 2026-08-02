const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { notifyUser } = require('../utils/notifications');
const { handleDocumentGeneratorTool } = require('./document_generator_tool');
const { generateText, buildSettingsForUser } = require('../utils/llm_text');
const logger = require('../utils/logger');

const RESULTS_CHAT_TITLE = 'Generated Courses';
const MAX_LESSONS = 10;
const DEFAULT_FORMAT = 'docx';
const ALLOWED_FORMATS = ['docx', 'pdf', 'pptx', 'xlsx', 'md'];

/**
 * Handles the course_builder tool: kicks off a genuinely long-running background job
 * that has PATTI's own configured LLM write a whole multi-lesson course from scratch
 * (no external research/scraper dependency), then renders it into a real file on disk
 * via the existing document_generator_tool, and reports the finished course - including
 * its exact location on this machine - into a dedicated "Generated Courses" chat.
 *
 * @param {import('sqlite').Database} db SQLite DB instance
 * @param {number} userId The user's ID
 * @param {string} action 'start_course' | 'check_status'
 * @param {object} params Action-specific parameters
 * @returns {Promise<string>} Text result for the worker agent
 */
async function handleCourseBuilderTool(db, userId, action, params = {}) {
  if (!db) {
    return 'Error: Database connection is not available.';
  }

  try {
    if (action === 'start_course') {
      return await handleStartCourse(db, userId, params);
    }
    if (action === 'check_status') {
      return await handleCheckStatus(db, userId, params);
    }
    return `Error: Unknown Course Builder action "${action}".`;
  } catch (err) {
    logger.error('Course builder tool error:', err);
    return `Error starting course generation: ${err.message}`;
  }
}

async function handleStartCourse(db, userId, params) {
  const { topic } = params;
  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return 'Error: "topic" parameter is required.';
  }
  const cleanTopic = topic.trim();
  const format = ALLOWED_FORMATS.includes(params.format) ? params.format : DEFAULT_FORMAT;
  const jobId = crypto.randomUUID();

  await db.run(
    'INSERT INTO course_generation_jobs (job_id, user_id, topic, format, status) VALUES (?, ?, ?, ?, ?)',
    [jobId, userId, cleanTopic, format, 'running']
  );

  // Fire-and-forget: a full multi-lesson course means many sequential LLM calls and can
  // genuinely take a long time. Never awaited here - the caller must not block on this.
  // Reuses this same `db` connection (rather than re-fetching via getDb()) since it's
  // already open and valid for the lifetime of this process.
  runCourseGenerationJob(db, jobId, userId, cleanTopic, format).catch((err) => {
    logger.error('[Course Builder] Unhandled job error:', err);
  });

  return `Started building a full course on "${cleanTopic}" (job ${jobId}, format: ${format}). This runs in ` +
    `the background and can take a while - I'll add the finished course, including exactly where the ` +
    `${format.toUpperCase()} file is saved on this computer, to your "${RESULTS_CHAT_TITLE}" chat (with a ` +
    'notification) when it\'s done. Tell the user this has started; do not wait or poll for it now.';
}

async function handleCheckStatus(db, userId, params = {}) {
  const { jobId } = params;
  const row = jobId
    ? await db.get('SELECT * FROM course_generation_jobs WHERE job_id = ? AND user_id = ?', [jobId, userId])
    : await db.get('SELECT * FROM course_generation_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);

  if (!row) {
    return jobId ? `Error: No job found with ID "${jobId}".` : 'No course generation jobs have been started yet.';
  }
  if (row.status === 'completed') {
    return `Course on "${row.topic}" completed at ${row.completed_at}. Saved at: ${row.output_path}`;
  }
  if (row.status === 'failed') {
    return `Course generation on "${row.topic}" failed: ${row.error || 'unknown error'}.`;
  }
  const progress = row.lesson_count
    ? `${row.completed_lessons || 0} of ${row.lesson_count} lessons written`
    : 'writing the course outline';
  return `Course on "${row.topic}" is still running (${progress}, started ${row.created_at}).`;
}

// ---- Background job ----

async function runCourseGenerationJob(db, jobId, userId, topic, format) {
  // Mark the model "busy" for the whole job, not just each individual enqueued call - the
  // idle-model-unloader in chat.js only checks activeAgentOps/queue-processing, so without
  // this it could unload the model during the gap between one lesson call and the next
  // (DB writes, doc assembly) and strand the next call against a model that's no longer loaded.
  global.activeAgentOps = (global.activeAgentOps || 0) + 1;
  try {
    const settings = await buildSettingsForUser(db, userId);

    const outline = await generateOutline(settings, topic);
    await db.run('UPDATE course_generation_jobs SET lesson_count = ? WHERE job_id = ?', [outline.length, jobId]);

    const lessonSections = [];
    for (let i = 0; i < outline.length; i++) {
      const content = await generateLesson(settings, topic, outline[i], i, outline.length);
      lessonSections.push({ title: outline[i].title, content });
      await db.run('UPDATE course_generation_jobs SET completed_lessons = ? WHERE job_id = ?', [i + 1, jobId]);
    }

    const { filepath, downloadLine } = await renderCourseFile(db, userId, topic, format, lessonSections);

    const resultsChatId = await postToResultsChat(
      db,
      userId,
      `# Course ready: ${topic}\n\n` +
      `Your course on "${topic}" is done - **${outline.length} lessons**, saved as a ${format.toUpperCase()} file.\n\n` +
      `**File location on this machine:**\n\`${filepath}\`\n\n` +
      `${downloadLine}\n\n` +
      `### Lessons\n${outline.map((l, i) => `${i + 1}. ${l.title}`).join('\n')}`
    );

    await db.run(
      "UPDATE course_generation_jobs SET status = 'completed', output_path = ?, completed_at = datetime('now') WHERE job_id = ?",
      [filepath, jobId]
    );
    await notifyUser(db, userId, { type: 'info', message: `Your course on "${topic}" is ready.`, chatId: resultsChatId });
  } catch (err) {
    logger.error('[Course Builder] Job failed:', err);
    await finishJobWithFailure(db, userId, jobId, topic, err.message);
  } finally {
    global.activeAgentOps = Math.max(0, (global.activeAgentOps || 0) - 1);
  }
}

async function generateOutline(settings, topic) {
  const systemPrompt = 'You are an expert curriculum designer. You output ONLY a strict JSON array, nothing else - no markdown code fences, no commentary before or after it.';
  const baseUserPrompt = `Design a course outline for the topic: "${topic}".
Produce between 4 and ${MAX_LESSONS} lessons that together thoroughly teach this subject to a motivated learner, in a sensible learning order (fundamentals first, building up to more advanced material).
Output ONLY a JSON array like this, with no other text:
[{"title": "Lesson title", "objective": "One sentence describing what the learner will be able to do after this lesson"}, ...]`;

  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const userPrompt = attempt === 1
      ? baseUserPrompt
      : `${baseUserPrompt}\n\nYour previous response was not a valid JSON array. Output ONLY the JSON array - no markdown code fences, no explanation before or after it.`;

    const raw = await generateText(settings, systemPrompt, userPrompt);
    // Models frequently wrap JSON in ```json fences despite instructions not to.
    const cleaned = raw.replace(/```(?:json)?/gi, '');
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');

    let parsed;
    if (start !== -1 && end !== -1 && end > start) {
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      } catch (e) {
        parsed = null;
      }
    }

    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.slice(0, MAX_LESSONS).map((l, i) => ({
        title: (l && l.title ? String(l.title) : `Lesson ${i + 1}`).trim(),
        objective: (l && l.objective ? String(l.objective) : '').trim()
      }));
    }

    if (attempt === maxAttempts) {
      const snippet = raw.slice(0, 300).replace(/\s+/g, ' ').trim();
      throw new Error(`The model returned a malformed course outline after ${maxAttempts} attempts. Raw response started with: "${snippet}"`);
    }
  }
}

async function generateLesson(settings, topic, lesson, lessonIndex, totalLessons) {
  const systemPrompt = 'You are an expert teacher writing one lesson of a longer course. Write complete, ' +
    'accurate, well-organized teaching content in Markdown, using ## for the lesson title and ### for ' +
    'subsections, with bullet lists and short paragraphs. Use ```language fenced code blocks for any code ' +
    'examples, and pipe tables (| header | header |) for comparisons or reference data where they genuinely ' +
    'help. Do not include a preamble like "Sure, here is..." - start directly with the lesson content.';
  const userPrompt = `Course topic: "${topic}"
This is lesson ${lessonIndex + 1} of ${totalLessons}: "${lesson.title}"
Learning objective: ${lesson.objective}

Write the full lesson now: explain the concepts thoroughly with concrete examples, and end with a short "Review Questions" section (3-5 questions, no answers needed).`;

  return generateText(settings, systemPrompt, userPrompt);
}

// ---- Rendering the finished course into a real file ----

async function renderCourseFile(db, userId, topic, format, lessonSections) {
  const safeTopic = topic.trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 60).trim() || 'Course';
  const baseName = safeTopic.replace(/\s+/g, '_');

  if (format === 'md') {
    const md = `# ${topic}\n\n` +
      lessonSections.map((s, i) => `## Lesson ${i + 1}: ${s.title}\n\n${s.content}`).join('\n\n---\n\n');
    const userDir = path.join(process.cwd(), 'generated_documents', String(userId));
    fs.mkdirSync(userDir, { recursive: true });
    const finalName = `${baseName}.md`;
    const filepath = path.join(userDir, `${Date.now()}_${finalName}`);
    fs.writeFileSync(filepath, md, 'utf8');
    await db.run(
      'INSERT INTO generated_documents (user_id, filename, filepath, doc_type, file_size) VALUES (?, ?, ?, ?, ?)',
      [userId, finalName, filepath, 'md', Buffer.byteLength(md, 'utf8')]
    );
    return { filepath, downloadLine: "It's a plain Markdown file - open it in any text editor." };
  }

  if (format === 'pptx') {
    const slides = lessonSections.map((s, i) => ({
      title: `Lesson ${i + 1}: ${s.title}`,
      bullets: markdownToBulletLines(s.content)
    }));
    const resultText = await handleDocumentGeneratorTool(db, userId, 'generate_pptx', { filename: baseName, title: topic, slides });
    return resolveFromDirective(db, resultText);
  }

  if (format === 'xlsx') {
    const rows = lessonSections.map((s, i) => [i + 1, s.title, estimateMinutes(s.content), 'Not started']);
    const sheets = [{ name: 'Course Plan', headers: ['#', 'Lesson', 'Est. Minutes', 'Status'], rows }];
    const resultText = await handleDocumentGeneratorTool(db, userId, 'generate_xlsx', { filename: baseName, title: topic, sheets });
    return resolveFromDirective(db, resultText);
  }

  // docx / pdf: one combined, section-headed document
  const action = format === 'pdf' ? 'generate_pdf' : 'generate_docx';
  const content = lessonSections.map((s, i) => `# Lesson ${i + 1}: ${s.title}\n\n${s.content}`).join('\n\n');
  const resultText = await handleDocumentGeneratorTool(db, userId, action, { filename: baseName, title: topic, content });
  return resolveFromDirective(db, resultText);
}

async function resolveFromDirective(db, resultText) {
  if (resultText.startsWith('Error')) {
    throw new Error(resultText);
  }
  const idMatch = resultText.match(/\/api\/documents\/(\d+)\/download/);
  if (!idMatch) {
    throw new Error('Could not determine the generated document id from the document generator output.');
  }
  const row = await db.get('SELECT filepath FROM generated_documents WHERE id = ?', [Number(idMatch[1])]);
  if (!row) {
    throw new Error('Generated document record not found.');
  }
  const anchorMatch = resultText.match(/<a[^>]*>.*?<\/a>/);
  return {
    filepath: row.filepath,
    downloadLine: anchorMatch ? `You can also download it directly in PATTI: ${anchorMatch[0]}` : ''
  };
}

function markdownToBulletLines(markdown) {
  return markdown
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim())
    .filter((l) => l.length > 0)
    .slice(0, 12);
}

function estimateMinutes(content) {
  const words = content.split(/\s+/).filter(Boolean).length;
  return Math.max(10, Math.round(words / 130)); // ~130 words/min reading pace
}

// ---- Shared results-chat / failure handling ----

async function postToResultsChat(db, userId, content) {
  let chat = await db.get('SELECT * FROM chats WHERE user_id = ? AND title = ?', [userId, RESULTS_CHAT_TITLE]);
  if (!chat) {
    const result = await db.run('INSERT INTO chats (user_id, title) VALUES (?, ?)', [userId, RESULTS_CHAT_TITLE]);
    chat = { id: result.lastID, title: RESULTS_CHAT_TITLE };
  }
  await db.run('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)', [chat.id, 'assistant', content]);
  return chat.id;
}

async function finishJobWithFailure(db, userId, jobId, topic, message) {
  try {
    const resultsChatId = await postToResultsChat(db, userId, `# Course generation failed: ${topic}\n\n${message}`);
    await db.run(
      "UPDATE course_generation_jobs SET status = 'failed', error = ?, completed_at = datetime('now') WHERE job_id = ?",
      [message, jobId]
    );
    await notifyUser(db, userId, { type: 'error', message: `Course generation for "${topic}" failed.`, chatId: resultsChatId });
  } catch (err) {
    logger.error('[Course Builder] Failed to record job failure:', err);
  }
}

module.exports = { handleCourseBuilderTool, RESULTS_CHAT_TITLE, resolveFromDirective };

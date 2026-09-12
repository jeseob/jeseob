/**
 * Telegram → Gemini → Google Calendar / GitHub(Obsidian) Cloudflare Worker
 *
 * Secrets (wrangler secret put):
 *   TELEGRAM_BOT_TOKEN, GEMINI_API_KEY,
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
 *   GITHUB_TOKEN
 *
 * Vars:
 *   ALLOWED_CHAT_ID, GITHUB_OWNER, GITHUB_REPO
 */

const GEMINI_MODEL = 'gemini-3.6-flash';
const TELEGRAM_MAX_CHARS = 3900;
const FALLBACK_CHAT_ID = '8681617992';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response(`Obsidian Assistant Running (${GEMINI_MODEL})`, { status: 200 });
    }

    try {
      const update = await request.json();
      const message = update.message;
      if (!message) return new Response('No message', { status: 200 });

      const incomingChatId = String(message.chat.id).trim();
      const allowedChatId = String(env.ALLOWED_CHAT_ID || FALLBACK_CHAT_ID).trim();

      if (incomingChatId !== allowedChatId && incomingChatId !== FALLBACK_CHAT_ID) {
        return new Response('Unauthorized', { status: 200 });
      }

      ctx.waitUntil(processAssistantTask(message, env));
      return new Response('OK', { status: 200 });
    } catch (err) {
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  }
};

async function processAssistantTask(message, env) {
  const chatId = message.chat.id;
  let textContent = message.text || message.caption || '';
  let inlineAudioData = null;
  const steps = [];

  try {
    requireEnv(env, ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY']);

    if (message.voice || message.audio) {
      await notify(env, chatId, '🎙️ 음성을 수신했습니다. 분석 중입니다...');
      inlineAudioData = await downloadTelegramAudio(env, message.voice || message.audio);
      steps.push({ name: '음성 수신', ok: true, detail: inlineAudioData.mimeType });
    }

    if (!textContent && !inlineAudioData) {
      await notify(env, chatId, '⚠️ 처리할 텍스트나 음성이 없습니다.');
      return;
    }

    const aiResult = await analyzeWithGemini(env, textContent, inlineAudioData);
    steps.push({ name: 'Gemini 분석', ok: true, detail: `action=${aiResult.action || 'unknown'}` });

    const results = {
      calendar: null,
      obsidian: null
    };

    if ((aiResult.action === 'calendar' || aiResult.action === 'both') && aiResult.calendarEvent) {
      try {
        results.calendar = await createCalendarEvent(env, aiResult.calendarEvent);
        steps.push({ name: '구글 캘린더', ok: true, detail: results.calendar.summary });
      } catch (err) {
        steps.push({ name: '구글 캘린더', ok: false, detail: err.message });
      }
    }

    if ((aiResult.action === 'obsidian' || aiResult.action === 'both') && aiResult.obsidianNote) {
      try {
        results.obsidian = await commitObsidianNote(env, aiResult.obsidianNote);
        steps.push({ name: '옵시디언 저장', ok: true, detail: results.obsidian.path });
      } catch (err) {
        steps.push({ name: '옵시디언 저장', ok: false, detail: err.message });
      }
    }

    await notify(env, chatId, buildCompletionMessage(aiResult, results, steps));
  } catch (err) {
    await notify(env, chatId, buildErrorMessage(err, steps));
  }
}

function requireEnv(env, keys) {
  const missing = keys.filter((key) => !String(env[key] || '').trim());
  if (missing.length) {
    throw taggedError('환경변수', `필수 값이 없습니다: ${missing.join(', ')}`);
  }
}

async function downloadTelegramAudio(env, targetAudio) {
  const token = env.TELEGRAM_BOT_TOKEN.trim();
  const fileRes = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(targetAudio.file_id)}`
  );
  const fileData = await readJsonSafe(fileRes);
  if (!fileRes.ok || !fileData.ok || !fileData.result?.file_path) {
    throw taggedError('음성 파일 조회', summarizeApiError(fileData, fileRes.status));
  }

  const audioRes = await fetch(
    `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`
  );
  if (!audioRes.ok) {
    throw taggedError('음성 다운로드', `HTTP ${audioRes.status} ${audioRes.statusText}`);
  }

  const buffer = await audioRes.arrayBuffer();
  if (!buffer.byteLength) {
    throw taggedError('음성 다운로드', '받은 오디오 데이터가 비어 있습니다.');
  }

  return {
    mimeType: targetAudio.mime_type || 'audio/ogg',
    data: arrayBufferToBase64(buffer)
  };
}

async function analyzeWithGemini(env, textContent, inlineAudioData) {
  const systemPrompt = `당신은 사용자의 전담 개인 비서이자 지식 관리자입니다.
현재 한국 시간(KST): ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}

사용자 입력을 심층 분석하여 반드시 아래 JSON 규격으로만 응답하세요:
{
  "action": "calendar" | "obsidian" | "both" | "chat",
  "calendarEvent": {
    "summary": "일정 명칭",
    "startTime": "ISO 8601 포맷 (예: 2026-09-13T15:00:00+09:00)",
    "endTime": "ISO 8601 포맷"
  },
  "obsidianNote": {
    "title": "노트 파일명 (간결하게)",
    "folder": "Inbox",
    "content": "심층 정리 마크다운 본문. 개요, 안건, 결정사항, Action Items 섹션 포함."
  },
  "replyMessage": "사용자에게 전송할 간결한 안내 문구"
}`;

  const geminiPayload = {
    contents: [{
      role: 'user',
      parts: [
        ...(inlineAudioData ? [{ inlineData: inlineAudioData }] : []),
        { text: textContent || '회의 음성을 상세 분석하고 구조화된 회의록을 작성해 줘.' }
      ]
    }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { responseMimeType: 'application/json' }
  };

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY.trim()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiPayload)
    }
  );

  const geminiData = await readJsonSafe(geminiRes);
  if (!geminiRes.ok) {
    throw taggedError('Gemini 호출', summarizeApiError(geminiData, geminiRes.status));
  }

  const rawText = extractGeminiText(geminiData);
  try {
    return parseAiJson(rawText);
  } catch (err) {
    throw taggedError('Gemini JSON 파싱', err.message);
  }
}

async function createCalendarEvent(env, calendarEvent) {
  requireEnv(env, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']);

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID.trim(),
      client_secret: env.GOOGLE_CLIENT_SECRET.trim(),
      refresh_token: env.GOOGLE_REFRESH_TOKEN.trim(),
      grant_type: 'refresh_token'
    })
  });
  const tokenData = await readJsonSafe(tokenRes);
  if (!tokenRes.ok || !tokenData.access_token) {
    throw taggedError('구글 토큰 갱신', summarizeApiError(tokenData, tokenRes.status));
  }

  const calRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      summary: calendarEvent.summary,
      start: { dateTime: calendarEvent.startTime, timeZone: 'Asia/Seoul' },
      end: { dateTime: calendarEvent.endTime, timeZone: 'Asia/Seoul' }
    })
  });
  const calData = await readJsonSafe(calRes);
  if (!calRes.ok) {
    throw taggedError('구글 캘린더 등록', summarizeApiError(calData, calRes.status));
  }

  return { summary: calendarEvent.summary, htmlLink: calData.htmlLink || '' };
}

async function commitObsidianNote(env, note) {
  requireEnv(env, ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN']);
  const title = sanitizeFileName(note.title);
  const folder = sanitizeFileName(note.folder || 'Inbox');
  const path = `${folder}/${title}.md`;
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER.trim()}/${env.GITHUB_REPO.trim()}/contents/${encodedPath}`;

  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN.trim()}`,
    'User-Agent': 'Obsidian-Worker-Assistant',
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json'
  };

  const existingRes = await fetch(url, { headers });
  let sha;
  if (existingRes.ok) {
    const existing = await readJsonSafe(existingRes);
    sha = existing.sha;
  } else if (existingRes.status !== 404) {
    const existingErr = await readJsonSafe(existingRes);
    throw taggedError('GitHub 기존 파일 조회', summarizeApiError(existingErr, existingRes.status));
  }

  const ghRes = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: `${sha ? 'Update' : 'Add'} note: ${title}`,
      content: utf8ToBase64(note.content || ''),
      ...(sha ? { sha } : {})
    })
  });
  const ghData = await readJsonSafe(ghRes);
  if (!ghRes.ok) {
    throw taggedError('GitHub 커밋', summarizeApiError(ghData, ghRes.status));
  }

  return { path };
}

function extractGeminiText(geminiData) {
  const candidate = geminiData?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const answerParts = parts.filter((part) => part.text && !part.thought);
  const texts = (answerParts.length ? answerParts : parts)
    .map((part) => part.text)
    .filter(Boolean);

  if (!texts.length) {
    const finishReason = candidate?.finishReason || 'unknown';
    throw new Error(
      `응답 텍스트가 없습니다. finishReason=${finishReason}. ${summarizeApiError(geminiData, 200)}`
    );
  }

  return texts[texts.length - 1];
}

function parseAiJson(raw) {
  const cleaned = String(raw).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error(`${firstErr.message}\n원문 일부: ${cleaned.slice(0, 500)}`);
  }
}

function buildCompletionMessage(aiResult, results, steps) {
  const failed = steps.filter((step) => !step.ok);
  const lines = [
    failed.length ? '⚠️ 처리 완료 (일부 실패)' : '✅ 완료',
    '',
    aiResult.replyMessage || '요청을 처리했습니다.'
  ];

  if (results.calendar) {
    lines.push('', `📅 구글 캘린더 등록 완료: ${results.calendar.summary}`);
    if (results.calendar.htmlLink) lines.push(results.calendar.htmlLink);
  }

  if (results.obsidian) {
    lines.push(`📝 옵시디언 볼트 저장 완료: ${results.obsidian.path}`);
  }

  if (failed.length) {
    lines.push('', '실패 항목:');
    for (const step of failed) {
      lines.push(`- [${step.name}] ${step.detail}`);
    }
  }

  return lines.join('\n');
}

function buildErrorMessage(err, steps) {
  const lines = [
    '⚠️ 오류로 처리가 중단되었습니다.',
    '',
    `단계: ${err.step || '처리 중'}`,
    `내용: ${err.message || String(err)}`
  ];

  const done = steps.filter((step) => step.ok);
  if (done.length) {
    lines.push('', '이미 성공한 단계:');
    for (const step of done) {
      lines.push(`- [${step.name}] ${step.detail || '성공'}`);
    }
  }

  return lines.join('\n');
}

function taggedError(step, message) {
  const err = new Error(message);
  err.step = step;
  return err;
}

async function notify(env, chatId, text) {
  try {
    await sendTelegram(env, chatId, text);
  } catch (err) {
    console.error('Telegram notify failed', err.message);
  }
}

async function sendTelegram(env, chatId, text) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN이 없습니다.');

  const chunks = splitText(String(text || ''), TELEGRAM_MAX_CHARS);
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk
      })
    });
    const data = await readJsonSafe(res);
    if (!res.ok || !data.ok) {
      throw new Error(summarizeApiError(data, res.status));
    }
  }
}

function splitText(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.6) cut = maxChars;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  return chunks;
}

async function readJsonSafe(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 800) };
  }
}

function summarizeApiError(data, status) {
  const msg =
    data?.error?.message ||
    data?.description ||
    data?.message ||
    data?.raw ||
    JSON.stringify(data);
  return `HTTP ${status}: ${truncate(String(msg), 700)}`;
}

function sanitizeFileName(value) {
  return String(value || 'untitled')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'untitled';
}

function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function utf8ToBase64(text) {
  return arrayBufferToBase64(new TextEncoder().encode(text));
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Telegram → Gemini → Google Calendar / GitHub(Obsidian) Cloudflare Worker
 *
 * 규칙 파일(볼트):
 *   _system/skills.md
 *   Templates/{article,meeting,call,inbox-memo,calendar-event,calendar-result}.md
 */

const GEMINI_MODEL = 'gemini-3.6-flash';
const TELEGRAM_MAX_CHARS = 3900;
const FALLBACK_CHAT_ID = '8681617992';
const SKILL_PATH = '_system/skills.md';
const TEMPLATE_BY_SKILL = {
  call: 'Templates/call.md',
  meeting: 'Templates/meeting.md',
  article: 'Templates/article.md',
  memo: 'Templates/inbox-memo.md',
  'calendar.create': 'Templates/calendar-event.md',
  'calendar.result': 'Templates/calendar-result.md',
  organize: 'Templates/inbox-memo.md'
};
const FOLDER_BY_SKILL = {
  call: 'Calls',
  meeting: 'Meetings',
  article: 'Inbox',
  memo: 'Inbox',
  'calendar.create': 'Calendar',
  'calendar.result': 'Calendar',
  organize: 'Inbox'
};
const SAVE_SKILLS = new Set([
  'call',
  'meeting',
  'article',
  'memo',
  'calendar.create',
  'calendar.result',
  'organize'
]);

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
    requireEnv(env, ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN']);

    if (message.voice || message.audio) {
      await notify(env, chatId, '🎙️ 음성을 수신했습니다. 전화/회의를 구분해 정리합니다...');
      inlineAudioData = await downloadTelegramAudio(env, message.voice || message.audio);
      steps.push({ name: '음성 수신', ok: true, detail: inlineAudioData.mimeType });
    }

    if (!textContent && !inlineAudioData) {
      await notify(env, chatId, '⚠️ 처리할 텍스트나 음성이 없습니다.');
      return;
    }

    const [skillsDoc, noteIndex, calendarEvents] = await Promise.all([
      readVaultFile(env, SKILL_PATH),
      listVaultNoteIndex(env),
      listUpcomingCalendarEvents(env).catch((err) => ({ error: err.message, items: [] }))
    ]);
    steps.push({ name: '스킬 로드', ok: true, detail: skillsDoc ? SKILL_PATH : '없음(기본 규칙)' });
    steps.push({ name: '볼트 목록', ok: true, detail: `${noteIndex.length}개 노트` });
    if (calendarEvents.error) {
      steps.push({ name: '캘린더 조회', ok: false, detail: calendarEvents.error });
    } else {
      steps.push({ name: '캘린더 조회', ok: true, detail: `${calendarEvents.items.length}건` });
    }

    const aiResult = await analyzeWithGemini(env, {
      textContent,
      inlineAudioData,
      skillsDoc,
      noteIndex,
      calendarEvents: calendarEvents.items || [],
      calendarError: calendarEvents.error || ''
    });
    const skill = normalizeSkill(aiResult);
    steps.push({ name: 'Gemini 분석', ok: true, detail: `skill=${skill}` });

    const results = { calendar: null, obsidian: null };

    if (skill === 'calendar.create' && aiResult.calendarEvent) {
      try {
        results.calendar = await createCalendarEvent(env, aiResult.calendarEvent);
        steps.push({ name: '구글 캘린더', ok: true, detail: results.calendar.summary });
      } catch (err) {
        steps.push({ name: '구글 캘린더', ok: false, detail: err.message });
      }
    }

    if (SAVE_SKILLS.has(skill) && aiResult.obsidianNote) {
      try {
        const note = applySkillDefaults(skill, aiResult.obsidianNote);
        results.obsidian = await commitObsidianNote(env, note);
        steps.push({ name: '옵시디언 저장', ok: true, detail: results.obsidian.path });
      } catch (err) {
        steps.push({ name: '옵시디언 저장', ok: false, detail: err.message });
      }
    }

    await notify(env, chatId, buildCompletionMessage(aiResult, results, steps, skill));
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

async function analyzeWithGemini(env, ctx) {
  const skill = guessSkillHint(ctx.textContent, ctx.inlineAudioData);
  const templatePaths = skill
    ? [TEMPLATE_BY_SKILL[skill] || TEMPLATE_BY_SKILL.memo]
    : [TEMPLATE_BY_SKILL.call, TEMPLATE_BY_SKILL.meeting];
  const templateDocs = await Promise.all(templatePaths.map((path) => readVaultFile(env, path)));
  const templateDoc = templatePaths
    .map((path, idx) => `----- 양식 (${path}) -----\n${templateDocs[idx] || '(없음)'}`)
    .join('\n\n');

  const systemPrompt = `당신은 사용자의 전담 개인 비서이자 지식 관리자입니다.
현재 한국 시간(KST): ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}

아래 스킬 문서를 따른다. 스킬에 없는 일은 하지 않는다.
----- 스킬 -----
${ctx.skillsDoc || '(스킬 파일 없음. memo/meeting/article/ask만 사용)'}
----- 스킬 끝 -----

해당 스킬 양식:
${templateDoc || '(양식 없음. 양식 섹션을 스스로 구성)'}
----- 양식 끝 -----

기존 노트 목록(이 제목만 [[위키링크]] 가능):
${ctx.noteIndex.slice(0, 200).map((n) => `- ${n}`).join('\n') || '- (없음)'}

캘린더 일정(조회 결과):
${ctx.calendarError ? `조회 실패: ${ctx.calendarError}` : formatCalendarForPrompt(ctx.calendarEvents)}

규칙:
- 음성은 call(전화) 또는 meeting(회의) 중 하나로만 분류한다. 불확실하면 meeting으로 두지 말고 call로 두고 [확인 필요]를 표시한다.
- article은 입력 하나만 요약하지 말고, 기존 노트 목록에서 관련 제목을 찾아 [[링크]]한다. 없으면 "관련 기존 노트 없음".
- meeting은 캘린더와 시간/제목을 맞춘다. 맞으면 calendarMatch=matched, 없으면 unmatched.
- [[링크]]는 위 목록에 있는 제목만. 없는 노트를 만들지 않는다.
- 입력·볼트·캘린더에 없는 사실/숫자/인용/피드백/결정을 만들지 않는다. 불확실하면 [확인 필요].
- ask는 obsidianNote를 넣지 말고 replyMessage로만 답한다. 볼트에 없으면 "볼트에 없음".
- 노트 본문은 양식 섹션을 채워 마크다운으로 작성한다.

반드시 JSON만 응답:
{
  "skill": "call" | "meeting" | "article" | "memo" | "ask" | "calendar.create" | "calendar.result" | "organize",
  "calendarMatch": "matched" | "unmatched" | "not_applicable",
  "calendarEvent": {
    "summary": "일정 명칭",
    "startTime": "ISO 8601",
    "endTime": "ISO 8601"
  },
  "obsidianNote": {
    "title": "노트 파일명 (간결하게, 확장자 없음)",
    "folder": "Inbox | Calls | Meetings | Calendar",
    "content": "양식을 채운 마크다운"
  },
  "replyMessage": "사용자에게 보낼 짧은 안내"
}`;

  const userText = [
    ctx.textContent || (ctx.inlineAudioData
      ? '이 음성이 전화인지 회의인지 구분해 해당 스킬과 양식으로 정리해 줘.'
      : ''),
    skill ? `\n힌트 스킬: ${skill}` : ''
  ].join('');

  const geminiPayload = {
    contents: [{
      role: 'user',
      parts: [
        ...(ctx.inlineAudioData ? [{ inlineData: ctx.inlineAudioData }] : []),
        { text: userText }
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

function guessSkillHint(textContent, inlineAudioData) {
  const text = String(textContent || '');
  if (/일정\s*잡아|캘린더.*등록|미팅 잡아/.test(text)) return 'calendar.create';
  if (/결과 정리|일정 결과/.test(text)) return 'calendar.result';
  if (/\?|뭐야|요약해|관련.*뭐|찾아/.test(text) && !inlineAudioData) return 'ask';
  if (/Inbox 정리|인박스 정리/.test(text)) return 'organize';
  if (/기사|뉴스|http/.test(text)) return 'article';
  if (/전화|통화/.test(text)) return 'call';
  if (/회의|미팅/.test(text) || inlineAudioData) return '';
  return 'memo';
}

function normalizeSkill(aiResult) {
  const raw = String(aiResult.skill || aiResult.action || 'memo').trim();
  const map = {
    calendar: 'calendar.create',
    both: 'calendar.create',
    obsidian: 'memo',
    chat: 'ask'
  };
  return map[raw] || raw;
}

function applySkillDefaults(skill, note) {
  return {
    title: note.title,
    folder: note.folder || FOLDER_BY_SKILL[skill] || 'Inbox',
    content: note.content || ''
  };
}

async function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN.trim()}`,
    'User-Agent': 'Obsidian-Worker-Assistant',
    Accept: 'application/vnd.github+json'
  };
}

function githubRepoBase(env) {
  return `https://api.github.com/repos/${env.GITHUB_OWNER.trim()}/${env.GITHUB_REPO.trim()}`;
}

async function readVaultFile(env, path) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${githubRepoBase(env)}/contents/${encodedPath}`, {
    headers: await githubHeaders(env)
  });
  if (res.status === 404) return '';
  const data = await readJsonSafe(res);
  if (!res.ok || !data.content) {
    throw taggedError('볼트 파일 읽기', `${path}: ${summarizeApiError(data, res.status)}`);
  }
  return decodeBase64Utf8(data.content.replace(/\n/g, ''));
}

async function listVaultNoteIndex(env) {
  const res = await fetch(`${githubRepoBase(env)}/git/trees/HEAD?recursive=1`, {
    headers: await githubHeaders(env)
  });
  const data = await readJsonSafe(res);
  if (!res.ok) {
    throw taggedError('볼트 목록 조회', summarizeApiError(data, res.status));
  }

  return (data.tree || [])
    .filter((item) => item.type === 'blob' && item.path.endsWith('.md'))
    .map((item) => item.path)
    .filter((path) => !path.startsWith('.obsidian/') && !path.startsWith('Templates/') && path !== SKILL_PATH)
    .map((path) => path.replace(/\.md$/, ''))
    .slice(0, 300);
}

async function getGoogleAccessToken(env) {
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
  return tokenData.access_token;
}

async function listUpcomingCalendarEvents(env) {
  if (!String(env.GOOGLE_REFRESH_TOKEN || '').trim()) {
    return { items: [], error: 'GOOGLE_REFRESH_TOKEN 없음' };
  }

  const accessToken = await getGoogleAccessToken(env);
  const now = new Date();
  const timeMin = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '30');

  const calRes = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const calData = await readJsonSafe(calRes);
  if (!calRes.ok) {
    throw taggedError('구글 캘린더 조회', summarizeApiError(calData, calRes.status));
  }

  return {
    items: (calData.items || []).map((item) => ({
      summary: item.summary || '(제목 없음)',
      start: item.start?.dateTime || item.start?.date || '',
      end: item.end?.dateTime || item.end?.date || ''
    }))
  };
}

function formatCalendarForPrompt(items) {
  if (!items.length) return '- (기간 내 일정 없음)';
  return items.map((item) => `- ${item.start} ~ ${item.end} | ${item.summary}`).join('\n');
}

async function createCalendarEvent(env, calendarEvent) {
  const accessToken = await getGoogleAccessToken(env);
  const calRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
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
  const title = sanitizeFileName(note.title);
  const folder = sanitizeFileName(note.folder || 'Inbox');
  const path = `${folder}/${title}.md`;
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `${githubRepoBase(env)}/contents/${encodedPath}`;
  const headers = {
    ...(await githubHeaders(env)),
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

function buildCompletionMessage(aiResult, results, steps, skill) {
  const failed = steps.filter((step) => !step.ok);
  const lines = [
    failed.length ? '⚠️ 처리 완료 (일부 실패)' : '✅ 완료',
    '',
    `스킬: ${skill}`,
    aiResult.calendarMatch ? `캘린더 매칭: ${aiResult.calendarMatch}` : '',
    '',
    aiResult.replyMessage || '요청을 처리했습니다.'
  ].filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''));

  if (results.calendar) {
    lines.push('', `📅 구글 캘린더 등록 완료: ${results.calendar.summary}`);
    if (results.calendar.htmlLink) lines.push(results.calendar.htmlLink);
  }

  if (results.obsidian) {
    lines.push(`📝 옵시디언 저장 완료: ${results.obsidian.path}`);
  }

  if (skill === 'ask') {
    lines.push('', '파일은 저장하지 않았습니다.');
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

function decodeBase64Utf8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

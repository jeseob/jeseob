/**
 * Telegram → Gemini → Google Calendar / GitHub(Obsidian) Cloudflare Worker
 *
 * 규칙 파일(볼트):
 *   _system/skills.md
 *   Templates/{article,meeting,call,inbox-memo,calendar-event,calendar-result,paper,youtube,research,capture}.md
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
  organize: 'Templates/inbox-memo.md',
  paper: 'Templates/paper.md',
  youtube: 'Templates/youtube.md',
  research: 'Templates/research.md',
  capture: 'Templates/capture.md'
};
const FOLDER_BY_SKILL = {
  call: 'Calls',
  meeting: 'Meetings',
  article: 'Inbox',
  memo: 'Inbox',
  'calendar.create': 'Calendar',
  'calendar.result': 'Calendar',
  organize: 'Inbox',
  paper: 'Papers',
  youtube: 'Videos',
  research: 'Research',
  capture: 'Captures'
};
const SAVE_SKILLS = new Set([
  'call',
  'meeting',
  'article',
  'memo',
  'calendar.create',
  'calendar.result',
  'organize',
  'paper',
  'youtube',
  'research',
  'capture'
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
  let inlineImageData = null;
  const steps = [];

  try {
    requireEnv(env, ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN']);

    if (message.voice || message.audio) {
      await notify(env, chatId, '🎙️ 음성을 수신했습니다. 전화/회의를 구분해 정리합니다...');
      inlineAudioData = await downloadTelegramAudio(env, message.voice || message.audio);
      steps.push({ name: '음성 수신', ok: true, detail: inlineAudioData.mimeType });
    }

    const photo = pickTelegramPhoto(message);
    if (photo) {
      await notify(env, chatId, '🖼️ 스크린샷을 수신했습니다. 화면에 보이는 글자만 정리합니다...');
      inlineImageData = await downloadTelegramFile(env, photo.file_id, photo.mimeType || 'image/jpeg');
      steps.push({ name: '이미지 수신', ok: true, detail: inlineImageData.mimeType });
    }

    const linkedUrls = extractUrlsFromMessage(message);
    if (linkedUrls.length && !linkedUrls.some((url) => textContent.includes(url))) {
      textContent = `${textContent}\n${linkedUrls.join('\n')}`.trim();
    }

    if (!textContent && !inlineAudioData && !inlineImageData) {
      await notify(env, chatId, '⚠️ 처리할 텍스트, 음성, 사진이 없습니다.');
      return;
    }

    if (isCasualChat(textContent, inlineImageData, inlineAudioData, linkedUrls)) {
      await notify(env, chatId, casualReply(textContent));
      return;
    }

    const youtubeUrl = linkedUrls.find(isYouTubeUrl);
    if (youtubeUrl) {
      const meta = await fetchYouTubeMeta(youtubeUrl);
      steps.push({ name: '유튜브 정보', ok: true, detail: meta.title || youtubeUrl });
      textContent = `${textContent}\n\n----- 유튜브 -----\n${meta.summary}`;
    }

    const pageUrls = linkedUrls.filter((url) => !isYouTubeUrl(url));
    const pageTexts = await fetchLinkedPages(pageUrls.join('\n'));
    if (pageTexts.length) {
      steps.push({ name: 'URL 수집', ok: true, detail: `${pageTexts.length}건` });
      textContent = `${textContent}\n\n----- 가져온 원문 -----\n${pageTexts.join('\n\n')}`;
    } else if (pageUrls.length) {
      steps.push({ name: 'URL 수집', ok: false, detail: `열기 실패: ${pageUrls.join(', ')}` });
    }

    let researchHits = [];
    if (shouldRunResearch(textContent, inlineImageData, inlineAudioData, linkedUrls)) {
      const research = await searchOpenAlex(env, textContent);
      researchHits = research.hits;
      steps.push({
        name: '논문 검색',
        ok: true,
        detail: researchHits.length
          ? `${researchHits.length}건 · ${research.source} · ${research.query}`
          : `검색 결과 없음 (${research.query || '질의 없음'})${research.error ? ` · ${research.error}` : ''}`
      });
      if (researchHits.length) {
        textContent = `${textContent}\n\n----- ${research.source} 검색 결과 -----\n검색어: ${research.query}\n${researchHits.join('\n')}`;
      }
    }

    const needCalendar = shouldLookupCalendar(textContent, inlineAudioData);
    const [skillsDoc, noteIndex, calendarEvents] = await Promise.all([
      readVaultFile(env, SKILL_PATH),
      listVaultNoteIndex(env),
      needCalendar
        ? listUpcomingCalendarEvents(env).catch((err) => ({ error: err.message, items: [] }))
        : Promise.resolve({ items: [], skipped: true })
    ]);
    steps.push({ name: '스킬 로드', ok: true, detail: skillsDoc ? SKILL_PATH : '없음(기본 규칙)' });
    steps.push({ name: '볼트 목록', ok: true, detail: `${noteIndex.length}개 노트` });

    let noteBodies = [];
    if (shouldAskVault(textContent, inlineImageData, inlineAudioData, linkedUrls)) {
      noteBodies = await fetchRelevantNotes(env, textContent, noteIndex);
      steps.push({ name: '관련 노트 읽기', ok: true, detail: `${noteBodies.length}개` });
    }
    if (needCalendar) {
      if (calendarEvents.error) {
        steps.push({ name: '캘린더 조회', ok: false, detail: calendarEvents.error });
      } else {
        steps.push({ name: '캘린더 조회', ok: true, detail: `${calendarEvents.items.length}건` });
      }
    }

    const aiResult = await analyzeWithGemini(env, {
      textContent,
      inlineAudioData,
      inlineImageData,
      youtubeUrl,
      skillsDoc,
      noteIndex,
      noteBodies,
      calendarEvents: calendarEvents.items || [],
      calendarError: calendarEvents.error || ''
    });
    let skill = normalizeSkill(aiResult);
    if (skill === 'memo' && isCasualChat(textContent, inlineImageData, inlineAudioData, linkedUrls)) {
      skill = 'chat';
    }
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
  return downloadTelegramFile(env, targetAudio.file_id, targetAudio.mime_type || 'audio/ogg');
}

async function downloadTelegramFile(env, fileId, mimeType) {
  const token = env.TELEGRAM_BOT_TOKEN.trim();
  const fileRes = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`
  );
  const fileData = await readJsonSafe(fileRes);
  if (!fileRes.ok || !fileData.ok || !fileData.result?.file_path) {
    throw taggedError('텔레그램 파일 조회', summarizeApiError(fileData, fileRes.status));
  }

  const fileFetch = await fetch(
    `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`
  );
  if (!fileFetch.ok) {
    throw taggedError('텔레그램 파일 다운로드', `HTTP ${fileFetch.status} ${fileFetch.statusText}`);
  }

  const buffer = await fileFetch.arrayBuffer();
  if (!buffer.byteLength) {
    throw taggedError('텔레그램 파일 다운로드', '받은 데이터가 비어 있습니다.');
  }

  return {
    mimeType,
    data: arrayBufferToBase64(buffer)
  };
}

function pickTelegramPhoto(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const largest = message.photo[message.photo.length - 1];
    return { file_id: largest.file_id, mimeType: 'image/jpeg' };
  }
  const doc = message.document;
  if (doc?.mime_type?.startsWith('image/')) {
    return { file_id: doc.file_id, mimeType: doc.mime_type };
  }
  return null;
}

async function analyzeWithGemini(env, ctx) {
  const skill = guessSkillHint(ctx);
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
${ctx.skillsDoc || '(스킬 파일 없음. memo/meeting/article/ask/chat만 사용)'}
----- 스킬 끝 -----

해당 스킬 양식:
${templateDoc || '(양식 없음. 양식 섹션을 스스로 구성)'}
----- 양식 끝 -----

기존 노트 목록(이 제목만 [[위키링크]] 가능):
${ctx.noteIndex.slice(0, 200).map((n) => `- ${n}`).join('\n') || '- (없음)'}

관련 노트 본문(ask는 여기 있는 내용만 사용):
${(ctx.noteBodies || []).join('\n\n') || '(해당 본문 없음)'}

캘린더 일정(조회 결과):
${ctx.calendarError ? `조회 실패: ${ctx.calendarError}` : formatCalendarForPrompt(ctx.calendarEvents)}

규칙:
- 음성은 call(전화) 또는 meeting(회의) 중 하나로만 분류한다. 불확실하면 meeting으로 두지 말고 call로 두고 [확인 필요]를 표시한다.
- article은 가져온 원문을 근거로 정리한다. 원문이 없으면 출처에 "입력에 출처 없음" 또는 "원문을 열지 못함"을 쓰고 URL을 지어내지 않는다.
- article은 기존 노트 목록에서 관련 제목을 찾아 [[링크]]한다. 없으면 "관련 기존 노트 없음".
- 예시용 가짜 URL(예: 여기에-실제-기사주소)은 출처로 쓰지 않는다.
- meeting은 캘린더와 시간/제목을 맞춘다. 맞으면 calendarMatch=matched, 없으면 unmatched.
- [[링크]]는 위 목록에 있는 제목만. 없는 노트를 만들지 않는다.
- 입력·볼트·캘린더에 없는 사실/숫자/인용/피드백/결정을 만들지 않는다. 불확실하면 [확인 필요].
- capture는 이미지에 보이는 글자만 적는다. 카카오톡/문자 추정은 화면 단서로만.
- youtube는 영상/메타에 있는 내용만. 없는 인용을 만들지 않는다.
- paper는 연 초록/공개본만. 유료 본문을 추측하지 않는다.
- research는 OpenAlex 검색 결과와 사용자가 준 링크만 출처로 쓴다. 없는 논문을 만들지 않는다.
- ask는 평소 질문이다. 볼트에 따로 묻지 않아도 된다. 파일을 저장하지 말고 replyMessage로만 답한다. 관련 노트 본문에 있는 사실만 쓰고 [[경로]]로 근거를 밝힌다. 본문에 없으면 "볼트에 없음".
- chat는 인사·짧은 잡담·감탄·단순 응답(안녕, ㅇㅋ, 고마워, ㅋㅋ)이다. 파일을 만들지 말고 replyMessage로 한두 문장만 답한다. 사실·할 일·결정·링크·숫자가 있으면 chat이 아니다.
- 노트 본문은 양식 섹션을 채워 마크다운으로 작성한다.

반드시 JSON만 응답:
{
  "skill": "call" | "meeting" | "article" | "memo" | "ask" | "chat" | "calendar.create" | "calendar.result" | "organize" | "paper" | "youtube" | "research" | "capture",
  "calendarMatch": "matched" | "unmatched" | "not_applicable",
  "calendarEvent": {
    "summary": "일정 명칭",
    "startTime": "ISO 8601",
    "endTime": "ISO 8601"
  },
  "obsidianNote": {
    "title": "노트 파일명 (간결하게, 확장자 없음)",
    "folder": "Inbox | Calls | Meetings | Calendar | Papers | Videos | Research | Captures",
    "content": "양식을 채운 마크다운"
  },
  "replyMessage": "사용자에게 보낼 짧은 안내"
}`;

  const userText = [
    ctx.textContent || (ctx.inlineImageData
      ? '이 스크린샷에 보이는 글자만 읽어 capture 양식으로 정리해 줘. 안 보이면 [확인 필요].'
      : ctx.inlineAudioData
        ? '이 음성이 전화인지 회의인지 구분해 해당 스킬과 양식으로 정리해 줘.'
        : ''),
    skill ? `\n힌트 스킬: ${skill}` : ''
  ].join('');

  const geminiPayload = {
    contents: [{
      role: 'user',
      parts: [
        ...(ctx.inlineImageData ? [{ inlineData: ctx.inlineImageData }] : []),
        ...(ctx.inlineAudioData ? [{ inlineData: ctx.inlineAudioData }] : []),
        ...(ctx.youtubeUrl ? [{ fileData: { fileUri: ctx.youtubeUrl, mimeType: 'video/mp4' } }] : []),
        { text: userText }
      ]
    }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { responseMimeType: 'application/json' }
  };

  let geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY.trim()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiPayload)
    }
  );

  let geminiData = await readJsonSafe(geminiRes);
  if (!geminiRes.ok && ctx.youtubeUrl) {
    geminiPayload.contents[0].parts = geminiPayload.contents[0].parts.filter((part) => !part.fileData);
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY.trim()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiPayload)
      }
    );
    geminiData = await readJsonSafe(geminiRes);
  }
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

function shouldLookupCalendar(textContent, inlineAudioData) {
  const text = String(textContent || '');
  if (inlineAudioData) return true;
  return /회의|미팅|일정|캘린더|결과 정리/.test(text);
}

function extractUrlsFromMessage(message) {
  const texts = [message.text, message.caption].filter(Boolean);
  const urls = [];
  for (const text of texts) urls.push(...extractHttpUrls(text));

  const entityGroups = [
    [message.text || '', message.entities || []],
    [message.caption || '', message.caption_entities || []]
  ];
  for (const [text, entities] of entityGroups) {
    for (const entity of entities) {
      if (entity.type === 'text_link' && entity.url) urls.push(entity.url);
      if (entity.type === 'url' && text) {
        urls.push(sliceTelegramText(text, entity.offset, entity.length));
      }
    }
  }
  return [...new Set(urls.map((url) => url.replace(/[),.;]+$/, '')).filter((url) => /^https?:\/\//i.test(url)))];
}

function sliceTelegramText(text, offset, length) {
  return [...text].slice(offset, offset + length).join('');
}

function extractHttpUrls(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>"']+/gi) || [];
  return [...new Set(matches)]
    .map((url) => url.replace(/[),.;]+$/, ''))
    .filter((url) => !/여기에-실제|example\.com|localhost/.test(url));
}

async function fetchLinkedPages(text) {
  const urls = extractHttpUrls(text).slice(0, 3);
  const pages = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 ObsidianAssistant/1.0' },
        redirect: 'follow'
      });
      if (!res.ok) {
        pages.push(`URL: ${url}\n열기 실패: HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      pages.push(`URL: ${url}\n${htmlToText(html)}`);
    } catch (err) {
      pages.push(`URL: ${url}\n열기 실패: ${err.message}`);
    }
  }
  return pages;
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
}

function guessSkillHint(ctx) {
  const text = String(ctx.textContent || '');
  if (ctx.inlineImageData) return 'capture';
  if (ctx.youtubeUrl || isYouTubeUrl(text)) return 'youtube';
  if (/일정\s*잡아|캘린더.*등록|미팅 잡아/.test(text)) return 'calendar.create';
  if (/결과 정리|일정 결과/.test(text)) return 'calendar.result';
  if (/논문 찾아|자료 찾아|조사해|리서치|찾아줘/.test(text)) return 'research';
  if (/arxiv\.org|doi\.org|10\.\d{4,}\/|논문/.test(text)) return 'paper';
  if (/Inbox 정리|인박스 정리/.test(text)) return 'organize';
  if (isCasualChat(text, ctx.inlineImageData, ctx.inlineAudioData, extractHttpUrls(text))) return 'chat';
  if (shouldAskVault(text, ctx.inlineImageData, ctx.inlineAudioData, extractHttpUrls(text))) return 'ask';
  if (/기사|뉴스|https?:\/\//.test(text)) return 'article';
  if (/전화|통화/.test(text)) return 'call';
  if (/회의|미팅/.test(text) || ctx.inlineAudioData) return '';
  return 'memo';
}

function shouldAskVault(text, image, audio, urls) {
  if (image || audio) return false;
  if ((urls || []).some(isYouTubeUrl)) return false;
  if (shouldRunResearch(text, image, audio, urls)) return false;
  if (extractHttpUrls(text).length) return false;
  const t = String(text || '');
  if (/정리해|저장해|올려줘|스크랩/.test(t) && !/[?？]/.test(t)) return false;
  return /[?？]|뭐야|뭐 있어|뭐였|어디 있|언제|누구|왜 |기억|알려줘|어때|어떻게|관련|볼트/.test(t);
}

async function fetchRelevantNotes(env, query, noteIndex) {
  const terms = tokenizeQuery(query);
  const ranked = noteIndex
    .map((path) => {
      const hay = path.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (hay.includes(term) ? 1 : 0), 0);
      return { path, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked = (ranked.length ? ranked : noteIndex.filter((path) => path.startsWith('Inbox/')).slice(-5))
    .slice(0, 5)
    .map((item) => item.path || item);

  const bodies = [];
  for (const path of picked) {
    const content = await readVaultFile(env, `${path}.md`);
    if (content) bodies.push(`### ${path}\n${content.slice(0, 3500)}`);
  }
  return bodies;
}

function tokenizeQuery(query) {
  const words = String(query || '').toLowerCase().match(/[a-z0-9]{3,}|[가-힣]{2,}/g) || [];
  const stop = new Set(['정리', '관련', '뭐야', '찾아', '기사', '볼트', '노트', '내용', '요약', '해줘', '어떻게']);
  return [...new Set(words)].filter((word) => !stop.has(word));
}

function shouldRunResearch(text, image, audio, urls) {
  if (image || audio) return false;
  if (urls.some(isYouTubeUrl)) return false;
  return /논문 찾아|자료 찾아|조사해|리서치|찾아줘/.test(String(text || ''));
}

function isYouTubeUrl(value) {
  return /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)/i.test(String(value || ''));
}

async function fetchYouTubeMeta(url) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (!res.ok) return { title: '', summary: `URL: ${url}\n메타 조회 실패 HTTP ${res.status}` };
    const data = await readJsonSafe(res);
    return {
      title: data.title || '',
      summary: `URL: ${url}\n제목: ${data.title || ''}\n채널: ${data.author_name || ''}`
    };
  } catch (err) {
    return { title: '', summary: `URL: ${url}\n메타 조회 실패: ${err.message}` };
  }
}

function cleanResearchQuery(query) {
  return String(query || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/논문 찾아|자료 찾아|조사해|리서치|찾아줘|기사 정리/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function sanitizeEnglishQuery(text) {
  const cleaned = String(text || '')
    .replace(/MYMEMORY WARNING:.*/i, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;|&#39;|&amp;|["'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || /[가-힣]/.test(cleaned)) return '';
  return cleaned.slice(0, 200);
}

async function translateResearchQuery(query) {
  if (!/[가-힣]/.test(query)) return query;

  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', query.slice(0, 500));
  url.searchParams.set('langpair', 'ko|en');
  const res = await fetch(url, { headers: { 'User-Agent': 'ObsidianAssistant/1.0' } });
  const data = await readJsonSafe(res);
  return sanitizeEnglishQuery(data?.responseData?.translatedText);
}

async function toEnglishResearchQuery(env, query) {
  if (!/[가-힣]/.test(query)) return query;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY.trim()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{
            text: `Convert this research topic into an English academic search query for OpenAlex. Use 6-12 words. No quotes, no explanation.\n\n${query}`
          }]
        }]
      })
    }
  );
  const data = await readJsonSafe(res);
  if (!res.ok) return '';

  try {
    return sanitizeEnglishQuery(extractGeminiText(data));
  } catch {
    return '';
  }
}

function formatPaperHit(title, authors, year, id) {
  return `- ${title || '(제목 없음)'} / ${authors || ''} / ${year || ''} / ${id || ''}`.replace(/ \/  \/ /g, ' / ');
}

async function fetchOpenAlexWorks(query) {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', query);
  url.searchParams.set('per-page', '5');

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ObsidianAssistant/1.0 (https://github.com/jeseob/jeseob)' }
    });
    const data = await readJsonSafe(res);
    if (!res.ok) {
      return { hits: [], error: `OpenAlex HTTP ${res.status}` };
    }
    if (!Array.isArray(data.results)) {
      return { hits: [], error: 'OpenAlex 응답 형식 오류' };
    }
    return {
      hits: data.results.map((work) => {
        const authors = (work.authorships || []).slice(0, 4).map((a) => a.author?.display_name).filter(Boolean).join(', ');
        const year = work.publication_year || '';
        const doi = work.doi || '';
        const landing = work.primary_location?.landing_page_url || work.id || '';
        return formatPaperHit(work.display_name, authors, year, doi || landing);
      }),
      error: ''
    };
  } catch (err) {
    return { hits: [], error: `OpenAlex 호출 실패: ${err.message}` };
  }
}

async function fetchCrossrefWorks(query) {
  const url = new URL('https://api.crossref.org/works');
  url.searchParams.set('query', query);
  url.searchParams.set('rows', '5');

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ObsidianAssistant/1.0 (https://github.com/jeseob/jeseob)' }
    });
    const data = await readJsonSafe(res);
    const items = data?.message?.items;
    if (!res.ok || !Array.isArray(items)) {
      return { hits: [], error: `Crossref HTTP ${res.status}` };
    }
    return {
      hits: items.map((item) => {
        const title = Array.isArray(item.title) ? item.title[0] : item.title;
        const authors = (item.author || []).slice(0, 4).map((a) => [a.given, a.family].filter(Boolean).join(' ')).join(', ');
        const year = item.issued?.['date-parts']?.[0]?.[0] || '';
        const doi = item.DOI ? `https://doi.org/${item.DOI}` : '';
        return formatPaperHit(title, authors, year, doi);
      }),
      error: ''
    };
  } catch (err) {
    return { hits: [], error: `Crossref 호출 실패: ${err.message}` };
  }
}

async function searchOpenAlex(env, query) {
  const cleaned = cleanResearchQuery(query);
  if (!cleaned) return { hits: [], query: '', source: '', error: '' };

  const searches = [];
  try {
    const translated = await translateResearchQuery(cleaned);
    if (translated) searches.push(translated);
  } catch {
    // Gemini 변환으로 진행
  }
  try {
    const english = await toEnglishResearchQuery(env, cleaned);
    if (english && !searches.includes(english)) searches.push(english);
  } catch {
    // 번역 검색어로 진행
  }
  if (!/[가-힣]/.test(cleaned) && !searches.includes(cleaned)) searches.push(cleaned);
  if (!searches.length) return { hits: [], query: cleaned, source: '', error: '영문 검색어 없음' };

  const errors = [];
  for (const search of searches) {
    const openalex = await fetchOpenAlexWorks(search);
    if (openalex.hits.length) return { hits: openalex.hits, query: search, source: 'OpenAlex', error: '' };
    if (openalex.error) errors.push(openalex.error);

    const crossref = await fetchCrossrefWorks(search);
    if (crossref.hits.length) return { hits: crossref.hits, query: search, source: 'Crossref', error: '' };
    if (crossref.error) errors.push(crossref.error);
  }

  return { hits: [], query: searches[0], source: '', error: errors[0] || '' };
}

function normalizeSkill(aiResult) {
  const raw = String(aiResult.skill || aiResult.action || 'memo').trim();
  const map = {
    calendar: 'calendar.create',
    both: 'calendar.create',
    obsidian: 'memo',
    chat: 'chat',
    smalltalk: 'chat',
    skip: 'chat',
    ignore: 'chat'
  };
  return map[raw] || raw;
}

function normalizeCasualText(text) {
  return String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[.。…·~～!！?？,，、;；:：'"“”‘’()[\]{}<>]/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CASUAL_PHRASE = /^(?:안녕(?:하세요|히\s*가세요)?|하이+|헬로+|헬로우+|hello+|hey+|hi+|ㅎㅇ+|좋은\s*(?:아침|점심|저녁)|잘\s*자(?:요)?|굿\s*나잇|good\s*night|바이+|bye+|수고(?:했어(?:요)?|하세요)?|고마워(?:요)?|고맙습니다|감사합니다|땡큐+|thanks?(?:\s*you)?|ㅇㅋ+|오케이|ok+|okay|응+|어+|네+|넵+|음+|알겠어(?:요)?|알겠습니다|그래(?:요)?|좋아(?:요)?|굿+|ㅋㅋ+|ㅎㅎ+|하하+)$/i;

function isCasualChat(text, image, audio, urls) {
  if (image || audio) return false;
  if ((urls || []).length) return false;
  const raw = String(text || '').trim();
  if (!raw) return true;
  if (/정리해|저장해|올려줘|스크랩|일정|회의|미팅|전화|논문|리서치|기사/.test(raw)) return false;
  const normalized = normalizeCasualText(raw);
  if (!normalized) return true;
  if (CASUAL_PHRASE.test(normalized)) return true;
  const tokens = normalized.split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => CASUAL_PHRASE.test(token));
}

function casualReply(text) {
  const normalized = normalizeCasualText(text);
  if (/고마|감사|thank|땡큐/i.test(normalized)) return '네.';
  if (/잘\s*자|굿\s*나잇|good\s*night/i.test(normalized)) return '네, 편히 쉬세요.';
  if (/안녕|하이|헬로|hello|hi|hey|ㅎㅇ|좋은/i.test(normalized)) return '안녕하세요.';
  return '네.';
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
  if (skill === 'chat') {
    return aiResult.replyMessage || '네.';
  }

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

  const researchStep = steps.find((step) => step.name === '논문 검색');
  if (researchStep) {
    lines.push(`🔎 ${researchStep.detail}`);
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

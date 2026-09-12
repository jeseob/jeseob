# Obsidian Assistant Worker

Telegram 메시지를 Gemini로 분류한 뒤 Google Calendar와 GitHub(Obsidian 볼트)에 저장하는 Cloudflare Worker입니다.

## 배포

```bash
cd obsidian-assistant-worker
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

`wrangler.toml`의 `GITHUB_OWNER`, `GITHUB_REPO`, `ALLOWED_CHAT_ID`를 실제 값으로 바꾼 뒤 배포합니다.

Cloudflare 대시보드에 붙여넣을 경우 `src/index.js` 전체를 사용하면 됩니다.

## 텔레그램 응답

- 성공: `✅ 완료`와 캘린더/옵시디언 결과
- 일부 실패: `⚠️ 처리 완료 (일부 실패)` + 실패 단계/사유
- 중단: `⚠️ 오류로 처리가 중단되었습니다.` + 단계명과 오류 내용

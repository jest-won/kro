# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Kiro IDE의 OpenAI-compatible API 요청을 Anthropic Claude Messages API 형식으로 변환하는 stateless 프록시 서버. Kiro IDE에서 Anthropic API 키를 직접 사용할 수 있게 해준다.

## Commands

- `npm run dev` — ts-node로 개발 서버 실행
- `npm run build` — TypeScript 컴파일 (dist/)
- `npm start` — 컴파일된 JS 실행 (build 필요)

테스트/린트 설정 없음.

## Architecture

```
Kiro IDE → POST /v1/chat/completions (OpenAI format)
         → proxy.ts: translateRequest() → Anthropic Messages API
         ← proxy.ts: translateResponse() / streaming.ts → OpenAI format
         ← Kiro IDE
```

4개 소스 파일 (`src/`):

- **index.ts** — Express 서버. 단일 POST 엔드포인트 `/v1/chat/completions` + `/health`
- **proxy.ts** — 핵심 변환 로직. OpenAI ↔ Anthropic 요청/응답 변환, 모델 매핑, 시스템 메시지 추출, tool use 변환
- **streaming.ts** — Anthropic SSE 이벤트를 OpenAI SSE 청크로 변환하여 스트리밍 전달
- **types.ts** — KiroRequest/Message, AnthropicRequest/Message, ContentBlock 타입 정의

## Key Design Decisions

- API 키는 환경변수가 아닌 클라이언트의 `Authorization: Bearer` 헤더에서 추출
- 모델 매핑: GPT 모델명 → Claude 모델명 (알 수 없는 모델은 그대로 전달)
- 시스템 메시지는 Anthropic의 top-level `system` 필드로 분리
- max_tokens 기본값: 8096
- 요청 크기 제한: 50MB

# Kiro Claude Proxy

Kiro CLI의 OAuth 토큰을 활용하여 AWS CodeWhisperer API를 Anthropic Messages API 형식으로 제공하는 프록시 서버.

Claude Code CLI에서 Kiro의 Claude 모델을 직접 사용할 수 있게 해줍니다.

## 동작 방식

```
┌──────────────────┐     ┌─────────────────────┐     ┌────────────────────────────┐
│   Claude Code    │────▶│  Kiro Claude Proxy  │────▶│  AWS CodeWhisperer         │
│   (Anthropic     │     │  (Anthropic → AWS   │     │  (codewhisperer.           │
│    API format)   │     │   CodeWhisperer)    │     │   us-east-1.amazonaws.com) │
└──────────────────┘     └─────────────────────┘     └────────────────────────────┘
```

1. Anthropic Messages API 형식의 요청 수신
2. Kiro CLI SQLite DB에서 OAuth 토큰 자동 추출
3. AWS CodeWhisperer 형식으로 변환 후 API 호출
4. 응답을 Anthropic 형식으로 변환하여 스트리밍 반환

## 사전 요구사항

- Node.js >= 18.0.0
- Kiro CLI 설치 및 인증 완료 (`kiro auth`)

## 설치

### npx (설치 없이 실행)

```bash
npx kiro-claude-proxy start
```

### 글로벌 설치

```bash
npm install -g kiro-claude-proxy
kiro-claude-proxy start
```

### 로컬 빌드

```bash
git clone <repository-url>
cd kiro-claude-proxy
npm install
npm run build
npm start
```

서버는 기본적으로 `http://localhost:8080`에서 실행됩니다.

## Claude Code CLI 설정

`~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_API_KEY": "dummy"
  }
}
```

모델을 지정하려면 선택적으로 추가:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_API_KEY": "dummy",
    "ANTHROPIC_MODEL": "claude-sonnet-4-6"
  }
}
```

설정 후:

```bash
# 프록시 서버 시작
kiro-claude-proxy start

# 다른 터미널에서 Claude Code 실행
claude
```

## 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/v1/messages` | Anthropic Messages API (스트리밍/비스트리밍) |
| GET | `/v1/models` | 사용 가능한 모델 목록 |
| GET | `/health` | 헬스체크 |

## 지원 모델

| 모델 ID | Kiro 내부 ID |
|---------|-------------|
| `claude-opus-4-7` | `claude-opus-4.7` |
| `claude-opus-4-6` | `claude-opus-4.6` |
| `claude-opus-4-5` | `claude-opus-4.5` |
| `claude-sonnet-4-6` | `claude-sonnet-4.6` |
| `claude-sonnet-4-5` | `claude-sonnet-4.5` |
| `claude-sonnet-4-0` | `claude-sonnet-4.0` |
| `claude-haiku-4-5` | `claude-haiku-4.5` |
| `deepseek-3-2` | `deepseek-3.2` |
| `minimax-m2-5` | `minimax-m2.5` |
| `qwen3-coder-next` | `qwen3-coder-next` |
| `auto` | `auto` |

## CLI 옵션

```
kiro-claude-proxy <command> [options]

COMMANDS:
  start                 서버 시작 (기본)

OPTIONS:
  --debug               디버그 로깅 활성화
  --help, -h            도움말
  --version, -v         버전 정보
```

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `8080` | 서버 포트 |
| `DEBUG` | `false` | 디버그 모드 |

## 프로젝트 구조

```
src/
├── index.ts                     # 엔트리포인트, 서버 시작
├── server.ts                    # Express 서버, API 라우팅
├── constants.ts                 # 설정값, 모델 매핑, AWS 엔드포인트
├── auth/
│   └── kiro-token-extractor.ts  # Kiro CLI SQLite DB에서 OAuth 토큰 추출
├── kiro/
│   ├── index.ts                 # 모듈 exports
│   ├── request-builder.ts       # Anthropic → CodeWhisperer 요청 변환
│   ├── streaming-handler.ts     # 스트리밍 요청/응답 처리
│   ├── response-converter.ts    # CodeWhisperer → Anthropic 응답 변환
│   ├── aws-event-stream.ts      # AWS 바이너리 이벤트 스트림 파서
│   ├── message-handler.ts       # 비스트리밍 메시지 처리
│   ├── model-api.ts             # 모델 목록 API
│   └── agentic-loop.ts          # Tool use 에이전틱 루프
├── tools/
│   ├── parser.ts                # Tool 정의 파싱
│   └── executor.ts              # Tool 실행
└── utils/
    ├── logger.ts                # 컬러 로깅
    └── helpers.ts               # 유틸리티 함수
bin/
└── cli.js                       # CLI 엔트리포인트
```

## 라이선스

MIT

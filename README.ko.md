<p align="center">
  <img src="assets/banner.svg" alt="Paseo ACP — Antigravity와 ZCode를 Agent Client Protocol로 연결합니다" width="100%">
</p>

<p align="center">
  <strong>Antigravity와 ZCode를 Paseo와 ACP 클라이언트에서 사용하세요.</strong><br>
  설치된 에이전트 활용 · 응답 스트리밍 · 외부 런타임 의존성 없는 어댑터
</p>

<p align="center">
  <a href="#빠른-시작">빠른 시작</a> ·
  <a href="#어댑터">어댑터</a> ·
  <a href="docs/configuration.md">설정 안내</a> ·
  <a href="README.md">English</a>
</p>

두 개의 커뮤니티 어댑터를 하나의 패키지로 제공합니다. Antigravity는 `agy`의 스트림 인터페이스를, ZCode는 네이티브 앱 서버를 연결합니다. 두 어댑터 모두 stdio로 [Agent Client Protocol](https://agentclientprotocol.com/)을 제공합니다.

모델과 도구 실행은 사용자가 설치한 에이전트가 담당하고, 어댑터는 클라이언트와 에이전트 사이의 메시지를 변환합니다.

## 빠른 시작

### 1. 에이전트 설치

**Node.js 22 이상**, Git, 사용할 공식 에이전트를 준비하세요.

- **Antigravity:** [Google Antigravity](https://antigravity.google/)를 설치하고 `agy` CLI를 사용할 수 있게 설정합니다.
- **ZCode:** [ZCode](https://zcode.z.ai/)를 설치하고 계정에 로그인합니다.
- **Paseo:** 자동 연결 설정을 사용하려면 [Paseo](https://github.com/getpaseo/paseo)를 설치합니다.

공식 런타임은 사용자의 설치 위치에서 찾습니다. 이 저장소에 배포사 런타임을 포함하지 않습니다.

### 2. 어댑터 설치

```sh
git clone https://github.com/choratools/paseo-acp.git
cd paseo-acp
npm install -g .
paseo-acp doctor
```

현재는 소스에서 설치합니다. npm 레지스트리에는 아직 게시하지 않았습니다.

### 3. Paseo 연결

```sh
paseo-acp setup --provider all
```

`all`은 설치된 두 에이전트를 모두 연결합니다. 하나만 사용하려면 setup과 doctor에 `--provider antigravity` 또는 `--provider zcode`를 지정합니다.

설정 도구는 Paseo 설정을 백업하고 `choratools-antigravity`, `choratools-zcode` 공급자를 추가합니다. 기존 공급자는 유지합니다. 출력된 새로고침 안내를 따른 뒤, Paseo에서 해당 공급자로 새 에이전트를 시작하세요.

## 어댑터

| | Antigravity | ZCode |
|---|---|---|
| 네이티브 인터페이스 | `agy` 스트림 JSON | ZCode 앱 서버 |
| 텍스트·도구 업데이트 | 스트리밍 | 스트리밍 |
| 대화 상태 | 실행 중인 세션에서 유지 | 네이티브 세션에 저장 |
| 세션 불러오기·목록 | 미지원 | 지원 |
| 모델 선택 | 조회 가능한 네이티브 목록·`agy` 기본 설정 | 계정 권한에 따른 모델 목록 |
| 모드 | Standard, Auto Edit, Plan | Build, Edit, Plan, Yolo |
| 클라이언트 MCP 서버 | 전달 미지원 | Stdio, HTTP, SSE 전달 |
| 이미지·오디오 프롬프트 | 미지원 | 미지원 |

**Antigravity**는 `agy`를 연결하는 커뮤니티 어댑터입니다. Google에서 제공하는 Antigravity ACP 통합과는 별도 프로젝트입니다. 취소나 런타임 설정 변경으로 프로세스가 다시 시작되면 이전 대화는 이어지지 않습니다.

Antigravity는 **Plan** 모드로 시작합니다. 터미널 권한 요청은 ACP로 전달하지 않으므로, 무인 편집·명령 실행을 사용하기 전에 [실행 설정](docs/configuration.md#antigravity-execution)을 확인하세요.

**ZCode**는 네이티브 앱 서버 연결을 유지하며 저장된 세션을 복원합니다. 런타임의 모델·추론 설정을 제공하고, 도구 권한 결정을 전달하며, 세션별로 모델을 변경합니다.

### Start Plan과 Trust Build

계정에서 사용할 수 있는 Individual Coding Plan과 Start Plan 모델을 표시합니다. Start Plan은 공식 계정의 잔여량·권한 조회 결과를 사용하므로, 로그인 정보가 있다는 이유만으로 모델을 노출하지 않습니다.

**ZCode Trust Build는 별도 모델이 아니라 플랜에 붙는 혜택입니다.** 모델 설명에 혜택 이름으로 표시될 수 있습니다. 사용 가능한 **Start Plan** 모델을 선택하면 해당 권한으로 사용합니다. 제공 모델, 활성화 시각, 한도는 ZCode 계정 상태에 따릅니다.

Start Plan을 사용하려면 먼저 공식 ZCode 데스크톱 앱에서 로그인하세요. 어댑터는 설치된 앱의 기존 계정·기기 정보를 사용하며, 혜택 신청이나 플랜 변경을 수행하지 않습니다.

## 다른 ACP 클라이언트

stdio ACP를 지원하는 클라이언트에 다음 실행 명령을 등록합니다.

```sh
antigravity-acp
zcode-acp
```

`paseo-acp antigravity`, `paseo-acp zcode`로 실행해도 같습니다. 이 명령은 에이전트 서버를 실행하며, 프로토콜 메시지는 연결한 클라이언트가 전달합니다.

명령과 인자를 받는 클라이언트에서는 다음 값을 사용하세요.

```json
{
  "command": "paseo-acp",
  "args": ["zcode"]
}
```

Antigravity를 사용하려면 `zcode`를 `antigravity`로 바꿉니다. 실제 설정 파일 형식은 클라이언트마다 다릅니다. 자동 설정 명령은 Paseo를 대상으로 합니다.

## 계정과 설정

```sh
paseo-acp login --provider zcode
paseo-acp doctor --provider zcode
```

ZCode 로그인 명령은 네이티브 Coding Plan 로그인 절차를 실행합니다. Start Plan은 공식 데스크톱 앱에서 로그인합니다. Antigravity는 공식 앱 또는 터미널에서 `agy`를 실행해 로그인하세요.

설치 위치를 직접 지정할 수도 있습니다. 환경 변수, 백업, 삭제, 문제 해결은 [설정 안내](docs/configuration.md)에 정리되어 있습니다.

## 확인한 범위

Linux에 설치된 실제 런타임에서 어댑터를 확인했습니다. ZCode 세션 구조 동작과 Start Plan Flash의 실제 응답을 확인했습니다. macOS·Windows 설치 경로 탐색 코드는 포함하지만 해당 운영체제에서 검증하지 않았습니다.

MCP 설정을 런타임에 전달하는 기능과 외부 MCP 서버에 실제로 연결되는지는 별개입니다. 동작 범위는 설치된 배포사 런타임과 클라이언트의 지원 기능에 따라 달라집니다. 계정 한도와 운영체제 격리는 배포사 런타임의 설정을 따릅니다.

## 개발

```sh
git clone https://github.com/choratools/paseo-acp.git
cd paseo-acp
node bin/paseo-acp.mjs doctor
```

어댑터 코드는 [`packages/`](packages/)에 있습니다. 재현 가능한 문제는 [GitHub Issues](https://github.com/choratools/paseo-acp/issues)에 Node 버전, 운영체제, 에이전트 버전, 민감 정보를 지운 `doctor` 출력과 함께 남겨주세요. 자격 증명과 개인 대화 내용은 제외하세요.

# VibeLink 용어 사전 (Glossary)

사용자와 에이전트가 같은 단어로 같은 것을 가리키기 위한 **단일 기준 문서**. UI·레이아웃·터미널·워크스페이스·리모트 관련 작업은 이 파일의 표준 용어를 사용한다.

## 사용 규칙

1. **표준 용어(Canonical)가 항상 이긴다.** 코드, 커밋 메시지, PR, 메모리, 에이전트 답변은 표준 용어를 쓴다.
2. **사용자가 다른 표현을 써도 에이전트는 매핑해서 이해한다.** 모호하면 작업 시작 전에 한 줄로 확인한다: `"터미널 창" = terminal window(앱 내부 컨테이너)로 이해했습니다.`
3. **모호어는 단독으로 쓰지 않는다.** `window`, `session`, `tab`, `group`, `active`는 아래 "충돌 단어" 표의 수식어를 붙여서만 쓴다.
4. 용어를 새로 만들거나 바꾸면 **이 파일을 먼저 고치고** 코드 식별자를 맞춘다. 이 파일에 없는 새 이름을 코드에만 도입하지 않는다.
5. 코드 식별자(`identifier`)가 진실이다. 문서와 코드가 어긋나면 코드를 확인하고 이 문서를 갱신한다.

## 계층 구조

```
OS 창 (native window)                       getCurrentWindow() — Tauri 창. 유일한 "진짜 창"
└─ 앱 셸                    .app-shell
   ├─ 메인 서피스           .main-surface
   │  └─ 루트 Dockview      apiRef: DockviewApi          ← 워크스페이스 1개 = 루트 레이아웃 1개
   │     ├─ 왼쪽 사이드 패널  edge group `workspace-left-tools`
   │     │   └─ 엣지 레일 탭  .workspace-edge-rail-tab (세로 38px 아이콘 띠)
   │     │      kinds: workspaces | explorer | automation
   │     ├─ 중앙 영역
   │     │  └─ 워크스페이스 윈도우  kind `workspaceWindow` (내부 Dockview)
   │     │     └─ 콘텐츠 탭  WorkspaceContentTab × N
   │     │        ├─ 터미널 윈도우  kind `terminalWindow` (내부 Dockview)
   │     │        │  └─ 터미널 페인  kind `terminal`, paneId
   │     │        │     └─ 페인 타이틀바  TerminalPaneTitleBar
   │     │        └─ 에디터 / 브라우저 / 프리뷰 / 칸반 / 진단 등
   │     └─ 오른쪽 사이드 패널 edge group `workspace-right-tools`
   │         kinds: workspaceFiles | sourceControl | gitHistory | gitBranches | agentSessions
   └─ 상태 표시줄            StatusBar (App.tsx 최하단)
```

핵심: **컨테이너 3단계는 `워크스페이스 윈도우 > 터미널 윈도우 > 터미널 페인`이고, 셋 다 OS 창이 아니다.**

## 1. 앱 셸 / 사이드 영역

| 표준 용어 | 한국어 | 코드 식별자 | 정의 |
| --- | --- | --- | --- |
| native window | OS 창 | `getCurrentWindow()`, `window-controls` | 유일한 실제 운영체제 창. 최소화/최대화/닫기 대상 |
| app shell | 앱 셸 | `.app-shell`, `App.tsx:872-943` | 앱 전체 루트 마크업 |
| root Dockview | 루트 도크뷰 | `apiRef: DockviewApi`, `WorkspaceView.tsx:2147-2173` | 최상위 Dockview. 사이드 패널 + 중앙 영역을 소유 |
| side panel | 사이드 패널 | edge group `workspace-left-tools` / `workspace-right-tools`, `workspaceShellModel.ts:135-153` | 좌/우 가장자리의 크기 조절 가능한 도구 패널 |
| edge rail (activity rail) | 엣지 레일 | `.workspace-edge-rail-tab`, `.dv-groupview-header-vertical` (38px 고정) | 사이드 패널이 접혔을 때 남는 세로 아이콘 띠 |
| sidebar panel shell | 사이드바 패널 셸 | `WorkspaceSidebarPanelShell`, `.workspace-sidebar-panel-shell` | 사이드 패널 내부 공통 껍데기(제목 + 본문 + 하단 툴바) |
| sidebar toolbar | 사이드바 툴바 | `WorkspaceSidebarToolbar` | 왼쪽 사이드바 하단 고정 띠(설정/도움말) |
| status bar | 상태 표시줄 | `StatusBar`, `App.tsx:1009` | 앱 최하단 한 줄 |

사이드 패널의 열림/폭/접힘 상태는 `appChrome.ts`가 아니라 **저장된 레이아웃**에 있다: `edgeGroups.<left|right>.{size, visible, collapsed}` (`workspaceContentModel.ts:334-343`).

**사이드 패널 뷰 목록** (`workspaceLayoutModel.ts:28-60`) — 라벨은 UI 표기 그대로:
`Workspaces`, `Explorer`, `Automations` (왼쪽) / `Workspace Files`, `Source Control`, `Git History`, `Branches`, `Agent Sessions` (오른쪽).

## 2. 콘텐츠 컨테이너

| 표준 용어 | 한국어 | 코드 식별자 | 정의 |
| --- | --- | --- | --- |
| workspace window | 워크스페이스 윈도우 | kind `workspaceWindow`, `WorkspaceWindowPanel`, `workspaceWindowRegistry` | 중앙에 놓이는 **앱 내부 컨테이너**. 내부에 자체 Dockview를 갖고 콘텐츠 탭들을 담는다. 디스크립터 제목은 `Window Group` |
| terminal window | 터미널 윈도우 | kind `terminalWindow`, `TerminalWindowPanel`, `terminalWindowRegistry` | 터미널 페인들만 담는 **앱 내부 컨테이너**. 페인 그리드/분할/맞춤을 소유 |
| content tab | 콘텐츠 탭 | `WorkspaceContentTab`, `WorkspaceContentParams`, `workspaceContentPanelId` | 워크스페이스 윈도우 내부 패널 1개의 탭 헤더 |
| terminal pane | 터미널 페인 | kind `terminal`, `TerminalPanePanel`, `paneId`, `.terminal-panel-shell[data-pane-id]` | PTY 하나에 대응하는 최소 단위 터미널 |
| pane title bar | 페인 타이틀바 | `TerminalPaneTitleBar` | 터미널 페인의 탭/제목 줄. 콘텐츠 탭과 **다른 컴포넌트** |
| dockview panel | 도크뷰 패널 | `IDockviewPanel`, `createWorkspaceContentPanel` | Dockview의 배치 단위(id + 컴포넌트 + params) |
| tab group | 탭 그룹 | Dockview leaf, `data.views`, `activeView`, `workspaceWindowTabGroups` | 탭들이 겹쳐 있는 한 칸. **워크스페이스 그룹과 무관** |
| grid | 그리드 | `SerializedDockview.grid.root`, `arrangeTerminalPaneGrid`, `liveGridSizes` | 분할 트리(행/열 트랙). 터미널 그리드는 행 우선, 페인마다 leaf 1개 |
| split | 분할 | `splitTerminal(paneId, 'right'|'below')`, `localSplitSizing` | 기준 페인을 반으로 나눠 새 페인을 만든다. 윈도우는 새로 만들지 않는다 |
| inner dock | 내부 도크 | `inner`, `getInnerApi()`, `.workspace-window-inner-dock` | 컨테이너 안에 중첩된 Dockview 레벨 |
| overlay | 오버레이 | `settleDockviewOverlayLayout`, `dockviewOverlaysSettled` | 드래그/드롭 중의 일시적 렌더 레이어. 계층 노드가 아님 |

**콘텐츠 종류 리터럴** (`WorkspaceContentKind`, `workspaceContentModel.ts:13-36`):
`terminal`, `terminalWindow`, `workspaceWindow`, `browser`, `editor`, `preview`, `workspaces`, `explorer`, `workspaceFiles`, `sourceControl`, `gitHistory`, `gitBranches`, `automation`, `workbench`, `agent`, `orchestration`, `kanban`, `todo`, `diff`, `agentSessions`.

## 3. 도메인 엔티티

| 표준 용어 | 한국어 | 프런트 타입 | 백엔드 타입 | 정의 |
| --- | --- | --- | --- | --- |
| workspace | 워크스페이스 | `SessionMeta` (`id`는 코드 전반에서 `sessionId`) | `Session` (`daemon/session.rs`) | 사용자가 전환하는 작업 단위. UI 용어는 workspace, 백엔드 정본은 Session |
| workspace folder | 워크스페이스 폴더 | `SessionMeta.workspaceFolder` | 동일 | 워크스페이스에 연결된 실제 디스크 경로 |
| workspace group | 워크스페이스 그룹 | `WorkspaceGroup {id,name,collapsed,rootFolder}` | — | 사이드바에서 워크스페이스를 묶는 UI 그룹. Dockview 그룹과 무관 |
| pane | 페인 | `PaneMeta`, `PaneConfig` | `daemon::pty::Pane` | 프런트에서는 식별자, 백엔드에서는 실제 PTY 자식/마스터/스크롤백 소유자 |
| profile | 프로필 | `Profile {id,name,type,shell,args,command,env,cwd,color,icon}` | — | 페인을 띄우는 실행 설정. 페인 기본 title/icon/cwd의 출처 |
| worktree | 워크트리 | `WorktreeRecord`, `WorktreeProjection` | — | Git 워크트리 체크아웃. 자체 `sessionId`(= 워크스페이스)를 갖는다 |
| agent session | 에이전트 세션 | `HermesSessionInfo {id,title,updatedAt,cwd}` | `HermesSessionInfo` | Hermes/ACP 대화 세션. `acpSessionId`로 참조하며 VibeLink 워크스페이스와 다른 축 |

**ID 관계**

```
workspace(sessionId)
├─ panes: PaneMeta.id ──> config.profileId ──> Profile.id
├─ settings.workspaceProfileIds[sessionId] ──> Profile.id      (워크스페이스 기본 프로필)
├─ settings.workspaceGroupIds[sessionId]  ──> WorkspaceGroup.id
├─ hermesCurrentSession[sessionId]        ──> acpSessionId
└─ WorktreeRecord.sessionId / parentSessionId                  (워크트리 ↔ 워크스페이스)
PTY 환경변수: VIBELINK_SESSION_ID = workspace id, VIBELINK_PANE_ID = pane id
```

**별도 PTY id는 없다.** 페인 UUID가 곧 PTY 식별자다(`TerminalSnapshot {session_id, pane_id, ...}`).

## 4. 터미널 내부

| 표준 용어 | 한국어 | 코드 식별자 | 정의 |
| --- | --- | --- | --- |
| terminal instance | 터미널 인스턴스 | `TerminalManagerImpl.entries: Map<paneId, Entry>`, `Entry.term` | paneId로 캐시되는 xterm 인스턴스. 페인당 1개 |
| geometry | 지오메트리 | `cols`, `rows`, `resize_pane`, `lastSentPtyCols/Rows` | PTY 격자 크기. **PTY 쪽이 권위**이며 클라이언트가 임의로 리플로우할 수 없다 |
| fit | 핏(맞춤) | `PaneFitAddon.fit`, `safeFit`, `scheduleLayoutPass` | 컨테이너 픽셀 → cols/rows 계산 후 `term.resize` |
| buffer | 버퍼 | `term.buffer.active` | xterm이 소유하는 normal/alternate 버퍼 |
| scrollback | 스크롤백 | `term.options.scrollback`, `terminalScrollAnchor` | 과거 출력 보관 줄. 폭이 바뀌면 리플로우된다 |
| viewport | 뷰포트 | `buffer.active.viewportY` | 현재 화면에 보이는 스크롤 위치. `viewportViable`(창 가시성)과 혼동 금지 |
| output parking | 출력 파킹 | `outputParked`, `scheduleHiddenOutputParking` (30s) | 숨겨진 페인의 출력 소비를 멈추고 재표시 때 스냅샷으로 복원 |
| render pause | 렌더 일시정지 | `forceRepaintThroughRenderPause` | xterm 렌더 서비스 일시정지 해제 후 강제 리페인트 |
| pane title | 페인 제목 | `term.onTitleChange` → `PaneTitleCoalescer` → `set_pane_title` | 셸/에이전트가 보내는 **OSC 제목**이 실시간으로 페인 제목이 된다. 최초 폴백은 `pane.config.title || profile.name || 'Shell'` |
| pane role | 페인 역할 | `settings.paneRoles[paneId]`, `terminal-tab-role` | 타이틀바에 표시되는 역할 칩(엔타이틀먼트 게이트) |
| agent pane status | 에이전트 페인 상태 | `useAgentPaneStatus(paneId)`, `agentPaneStatusClassName` | 타이틀바 상태 점(작업 중/완료 등) |

**생성 동작 구분**

- `New Terminal: <profile>` → 페인 1개 + **새 터미널 윈도우**(`newWindow: true`).
- `Add panes` (그리드 선택기, `NewTerminalLauncher`) → 목표 그리드를 채우는 데 **부족한 페인만** 추가.
- `Split` (타이틀바 버튼) → 기준 페인을 나눠 페인 1개 추가. 윈도우는 만들지 않음.

## 5. 리모트 프로토콜 v1 (데스크톱 ↔ 모바일)

| 데스크톱 용어 | v1 와이어 필드 |
| --- | --- |
| workspace / sessionId | `RemoteWorkspace.id` (`WorkspaceDto.id`) |
| workspace folder | `workspaceFolder` |
| 페인 개수 | `paneCount` |
| 주의 알림 수 | `alertCount`, `appearance.workspaceAlerts` |
| paneId | `RemotePane.id` |
| 페인 제목 | `RemotePane.title` |
| PTY cols/rows | `RemotePane.cols/rows`, `paneResized` |
| 워크스페이스/페인 순서 | 배열 순서만 존재 (`order` 필드 없음) |
| 외형 설정 | `appearance.payload` → `RemoteAppearance` |

메시지 타입: `workspaces`, `workspaceAttached`, `panesChanged`, `paneResized`, `appearance`.
알려진 불일치: 모바일 `normalizeV1Workspaces`는 `workspace.sessionId`를 읽는데 데스크톱은 `id`를 보낸다 (`RemoteSessionContext.tsx:147-154`).

## 6. 충돌 단어 — 반드시 수식어를 붙일 것

| 모호어 | 가능한 의미 | 규칙 |
| --- | --- | --- |
| window | OS 창 / `workspaceWindow` / `terminalWindow` | 단독 사용 금지. `OS 창`, `워크스페이스 윈도우`, `터미널 윈도우` 중 하나로 명시 |
| session | 워크스페이스(`SessionMeta`) / 에이전트 ACP 세션 / 데몬 접속 | `워크스페이스` 또는 `에이전트 세션`으로 명시. `sessionId`는 항상 워크스페이스 id |
| tab | 콘텐츠 탭(`WorkspaceContentTab`) / 페인 타이틀바(`TerminalPaneTitleBar`) / 엣지 레일 탭 | 세 가지를 구분해서 말한다 |
| group | Dockview 탭 그룹 / 워크스페이스 그룹 / 사이드바 터미널 윈도우 그룹 행 | `탭 그룹` vs `워크스페이스 그룹`으로 구분 |
| pane | 터미널 페인 / Dockview 패널 일반 / 사이드 패널 | 사이드 영역은 `패널`, 터미널 단위는 `페인` |
| active vs focused | `active` = Dockview 선택 상태(`activePanel`, `activePaneId`), `focused` = 실제 키보드 포커스(`TerminalManager.focus`) | 두 단어를 바꿔 쓰지 않는다 |
| workspace | 워크스페이스 세션 / 워크스페이스 폴더 / 워크트리 체크아웃 / 워크스페이스 그룹 | 경로를 뜻하면 `워크스페이스 폴더`, Git이면 `워크트리` |
| terminal | 터미널 페인 / 터미널 윈도우 / xterm 인스턴스 | 항상 셋 중 하나로 명시 |

## 7. 사이드바 트리 해독 (Workspaces 패널)

`WorkspacesSidebar` + `OpenWorkspaceItems`가 만드는 행 구조와 각 요소의 출처:

```
[그룹 헤더]        .workspaces-group-row           group.name + rootFolder basename
└ [워크스페이스 행] .session-row.repository-session-row
   ├ 왼쪽 숫자      .session-order                 정렬 위치 = Ctrl+N 단축키 번호
   ├ 점            .workspaces-session-status      활성 워크스페이스 표시
   ├ 굵은 제목      .session-name                  SessionMeta.name  (예: "Workspace 1")
   ├ 회색 부제      .workspaces-session-folder     workspaceFolder의 basename (예: "t2in-dev")
   ├ 체크 배지      .session-completion-badge      완료/주의 수 (attentionCount)
   └ 오른쪽 숫자    .session-badge                 SessionMeta.paneCount = "N terminal panes"
      └ [열린 항목 목록] .workspace-open-content-list  (활성 워크스페이스에만 표시)
         ├ [터미널 윈도우 그룹 헤더] .workspace-open-content-group-header
         │     라벨 = 터미널 윈도우 제목 (기본 "Terminal"), 셰브론으로 접기
         │  └ [터미널 페인 행] .workspace-open-content-item.is-terminal-pane
         │        라벨 = 페인 제목 (OSC 제목, 예: "π > t2in-dev"; 폴백 "Shell")
         └ [단독 콘텐츠 항목] .workspace-open-content-item   (에디터/브라우저 등)
```

즉 스크린샷의 `Terminal`은 **터미널 윈도우**, 그 아래 `Shell`과 `π > t2in-dev`는 **터미널 페인**이고,
오른쪽 숫자 배지는 그 워크스페이스의 **터미널 페인 개수**다.

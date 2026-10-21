# 릴스 운영 현황판

AI 인플루언서 릴스 파이프라인의 현황판 화면입니다. **화면 코드만** 있는 공개 저장소이고, 영상·캡션·계정 정보는 비공개 저장소(`cheese-daeri`)에 있습니다.
화면은 접속한 사람이 직접 넣은 GitHub 토큰으로 비공개 저장소의 `ops/` 상태 파일을 읽고, 버튼을 누르면 그 저장소의 "현황판 처리" 워크플로를 실행합니다. 토큰은 그 브라우저에만 저장됩니다.

- 왼쪽 🤖 **자동 영역**: 진행 단계, 실행 중인 작업, 방금 일어난 일
- 오른쪽 🙋 **내가 할 일**: 영상 승인·다시 만들기, 실패 확인, 예약 취소, 처음 한 번 설정
- 휴대폰에서는 위쪽 버튼으로 두 영역을 전환합니다 (처음엔 "내가 할 일")

## 처음 한 번
1. 이 저장소 Settings → Pages → Build and deployment → Source: **Deploy from a branch**, Branch: **main / (root)** → Save
2. 1~2분 뒤 `https://gohero-17.github.io/cheese-daeri-app/` 접속
3. ⚙️ 설정에서 저장소 `gohero-17/cheese-daeri` 와 **Fine-grained 토큰** 입력
   - Repository access: cheese-daeri 하나만
   - Permissions: Actions **Read and write**, Contents **Read-only**
4. 휴대폰 브라우저 메뉴 → "홈 화면에 추가" 하면 앱처럼 열립니다

## 파일
| 파일 | 내용 |
|---|---|
| `index.html` | 화면 구조 |
| `app.js` | GitHub API 읽기·버튼 처리 (외부 라이브러리 없음) |
| `style.css` | 디자인 (파랑 = 자동, 주황 = 내가 할 일) |

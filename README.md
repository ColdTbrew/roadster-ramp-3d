# THE RAMP // 2026 Roadster 3D Stunt

Tesla의 공개 영상 [**"The Ramp | Roadster"**](https://youtu.be/7p5LxFdc-Qg) 시퀀스를 3D WebGL(Three.js + TypeScript)로 재현한 인터랙티브 스턴트 게임입니다.
차량 모델은 직접 제작한 **v2 2026 Tesla Roadster(`ROSTR`) 52×116×30 복셀 에셋**을 관절 파츠(차체·액티브 스포일러·4개 5스포크 휠·4개 후면 서션 팬)로 변환해 사용합니다.

## 주요 기능 (Key Features)

- **언더바디 서션 팬(Underbody Suction Fan):** 거대한 C-램프 수직 벽면과 `180°` 천장 거꾸로 구간에서도 차체가 떨어지지 않고 달라붙어 주행합니다 (`F` 키로 온/오프).
- **SpaceX 콜드가스 슬러스터 6DOF 비행:** 역방향 램프 끝에서 이탈한 뒤 공중에서 `180°` 배럴 롤로 자세를 뒤집고, 전방 레트로 브레이크 + 4개 하부 호버 분사구로 감속해 붉은 지평선 조명 위 질소 연기 구름 속으로 연착륙합니다.
- **스트로브 포토 트레일 (`G`):** 영상 썸네일처럼 공중 회전·호버 궤적을 한 장의 다중 노출 잔상으로 겹쳐 볼 수 있습니다.
- **4가지 카메라 (`1~4` / `C`):**
  1. `Ramp` — 램프와 착륙 존이 한눈에 들어오는 시그니처 측면 방송 뷰
  2. `Chase` — 기체 뒤를 따라가는 에어로 체이스 캠
  3. `Rear` — 후면 4개 청동 노즐·서션 팬·테일라이트 바를 강조한 로우앵글 뷰
  4. `Orbit` — 자유 3D 회전/줌 포토 뷰 (`P` 일시정지와 함께 감상 가능)
- **프로시저럴 Web Audio 신디사이저 (`M` 음소거):** 전기 파워트레인 윙음, 서션 터빈 사운드, 고압 질소 분사 노이즈, 착지 서스펜션 임팩트를 순수 Web Audio API로 실시간 합성합니다.
- **야간 SpaceX 맥그리거 아레나 + 오로라 토글 (`B`):** 젖은 아스팔트 반사, 붉은 지평선 라이트, 후방 투광기 볼류메트릭 빔, 밤하늘 오로라 리본.

## 조작법 (Controls)

| 입력 | 동작 |
|---|---|
| `W` / `S` 또는 `↑` / `↓` | 지상 가속 / 브레이크 (공중에서는 `I`/`K` 또는 `↑`/`↓` 피치) |
| `A` / `D` 또는 `←` / `→` | 스티어링 / 공중 요·롤 |
| `Q` / `E` | 공중 롤 회전 (`180°` 플립) |
| `Space` | 하부 4발 호버 콜드가스 슬러스터 분사 |
| `X` | 전방 레트로 브레이크 슬러스터 분사 |
| `Shift` | 후방 로켓 부스트 |
| `F` | 언더바디 서션 팬 On/Off |
| `H` | 플라이트 어시스트 On/Off |
| `1` `2` `3` `4` / `C` | 카메라 전환 |
| `G` | 스트로브 잔상 트레일 토글 |
| `B` | 밤하늘 오로라 토글 |
| `P` | 일시정지 (포토 모드) |
| `M` | 오디오 음소거 |
| `V` / `R` | 데모 다시 재생 / 리셋 |

## 로컬 실행 (Local Development)

```bash
npm install
npm run dev
```

테스트 및 프로덕션 빌드:

```bash
npm test
npm run build
```

## 아키텍처 & 멀티 에이전트 오케스트레이션

- `src/physics/` (`codex` / `gpt-6.2-sol`) — C-램프 파라미터 곡선, 6DOF+서션 물리 엔진, 폐루프 `"The Ramp"` 오토파일럿, Vitest 물리 테스트
- `src/scene/voxelMeshBuilder.ts`, `roadsterModel.ts`, `thrusterVfx.ts`, `ghostTrail.ts` (`claudeAgent` / `claude-sonnet-5-5`) — 표면 컬링 복셀 로드스터 리그, 파티클 플룸·지면 연기 쿠션, 인스턴스드 잔상 트레일
- `src/scene/arenaEnvironment.ts`, `rampMesh.ts`, `cameraRig.ts` (`antigravity` / `gemini-4-neon`) — 맥그리거 야간 아레나, 강철 트러스 C-램프, 4모드 카메라 리그
- `src/audio/`, `src/ui/` (`grok` / `grok-4.7`) — 프로시저럴 Web Audio 신디사이저 및 다크 글래스 텔레메트리 HUD
- `src/main.ts` — 120 Hz 고정 물리 루프, `UnrealBloomPass` 포스트프로세싱, 통합 입력·렌더 파이프라인

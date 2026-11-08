import type { RunDetail } from '../../../shared/types.js';
import { environmentMode, isAiEnvironment } from '../../../shared/schema.js';
import { resolvedNpcConfigs, runSnapshot } from '../../../shared/run-snapshot.js';
import { api } from '../../api/client.js';
import { delivery, memory, providers, date, environmentModes } from '../../shared/formatters.js';

export function RunSettings({ detail }: { detail: RunDetail }) {
  const { run } = detail;
  const { spec, variant } = run;
  const { scenario } = spec;
  const configs = resolvedNpcConfigs(run);
  const versions = [...new Set(detail.invocations.flatMap(call => typeof call.metadata.promptVersion === 'string' ? [call.metadata.promptVersion] : []))];
  return <div className="run-settings">
    <div className="snapshot-heading"><div><h3>실행 당시 설정</h3><p>묶음 생성 시 저장된 원본 스냅샷입니다. 이후 시나리오 편집 내용은 이 기록에 영향을 주지 않습니다.</p></div><a className="download-link" href={api.configUrl(run.id)}>설정 JSON 다운로드</a></div>
    <dl className="snapshot-meta">
      <dt>시나리오</dt><dd>{scenario.name} <small>{scenario.id}</small></dd>
      <dt>실험 / 조건</dt><dd>{spec.name} / {variant.label} <small>{variant.id} · 반복 {run.repetition}</small></dd>
      <dt>생성 시각</dt><dd>{date(run.createdAt)} (KST)</dd>
      <dt>실행 경로</dt><dd>{providers[run.adapter]}</dd>
      {run.adapter === 'openai' && <><dt>API 키 출처</dt><dd>{run.apiCredential?.source === 'browser' ? '개인 키 · 생성 당시 키에 고정' : '서버 환경 키 (.env)'}<small>키 원문은 기록하지 않습니다.</small></dd></>}
      <dt>앱 / 실행기 버전</dt><dd>{run.appVersion} / {run.cliVersion || '기록 없음'}</dd>
      {run.conversationMemoryVersion && <><dt>대화 기억 버전</dt><dd>{run.conversationMemoryVersion}</dd></>}
      {run.sparseVoiceVersion && <><dt>간략한 인물의 말투 버전</dt><dd>{run.sparseVoiceVersion}</dd></>}
      <dt>프롬프트 버전</dt><dd>{run.promptVersion ?? (versions.length ? versions.join(', ') : '이전 기록에 버전 정보 없음')}</dd>
      <dt>대화 반응 지침</dt><dd>{variant.dialoguePromptVersion ?? '이전 기록 · 저장된 인물 지침 유지'}</dd>
      {environmentMode(spec, variant) === 'ai' && <><dt>세계 결과 지침</dt><dd>{variant.worldPromptVersion ?? '이전 기록 · 저장된 세계 지침 유지'}</dd></>}
      {run.adapter === 'openai' && isAiEnvironment(spec, variant) && <><dt>세계 엔진 입력 버전</dt><dd>{run.worldContextVersion ?? '기존 방식 · 이전 세계 응답 연결'}</dd></>}
      <dt>설정 해시 (SHA-256)</dt><dd><code>{run.snapshotHash}</code></dd>
    </dl>
    <section><h3>세계관</h3><p className="snapshot-text">{scenario.world}</p><h4>시작 상황</h4><p className="snapshot-text">{scenario.situation}</p></section>
    <section><h3>캐릭터 {scenario.characters.length}명</h3><p className="snapshot-note">각 캐릭터의 비공개 설정도 테스트 검토를 위해 표시합니다. NPC 세션에는 본인의 설정만 전달됩니다.</p>
      {scenario.characters.map(character => {
        const config = configs.find(c => c.characterId === character.id)!;
        const actual = [...new Set(detail.invocations.filter(call => call.characterId === character.id && call.actualModel).map(call => call.actualModel))];
        return <details className="snapshot-character" key={character.id}><summary>{character.name}<span>{config.model} · {config.effort}</span></summary><dl className="snapshot-fields">
          <dt>캐릭터 ID</dt><dd>{character.id}</dd><dt>적용 모델 · 추론</dt><dd>{config.model} / {config.effort}</dd>
          <dt>응답에서 확인된 모델</dt><dd>{actual.length ? actual.join(', ') : '보고된 값 없음'}</dd>
          {([['identity', '정체성'], ['personality', '성격'], ['values', '가치관'], ['goals', '목표'], ['relationships', '관계'], ['memories', '초기 기억'], ['knowledge', '지식 범위'], ['unknowns', '모르는 정보'], ['speechStyle', '말투'], ['exampleDialogue', '예시 대사'], ['behaviors', '행동 습관'], ['taboos', '금기']] as const).map(([key, label]) => <div className="snapshot-field" key={key}><dt>{label}</dt><dd className="snapshot-text">{character[key] || '미지정'}</dd></div>)}
        </dl></details>;
      })}
    </section>
    <section><h3>실험 조건</h3><dl className="snapshot-meta">
      <dt>대화 전달</dt><dd>{delivery[variant.deliveryMode]}</dd><dt>기억 제공</dt><dd>{memory[variant.memoryMode]}</dd>
      <dt>진행 방식</dt><dd>{variant.turnPolicy === 'director' ? 'AI 진행자' : '순번제'}</dd>
      <dt>환경 방식</dt><dd>{environmentModes[environmentMode(spec, variant)]}</dd>
      {isAiEnvironment(spec, variant) && <><dt>세계 엔진</dt><dd>{spec.worldEngine?.model} / {spec.worldEngine?.effort}</dd><dt>세계 엔진 추가 규칙</dt><dd className="snapshot-text">{scenario.worldEngineInstructions || '없음'}</dd></>}
      <dt>상황 발생</dt><dd>{variant.eventGeneration ? `${spec.eventGenerator?.model} / ${spec.eventGenerator?.effort}` : '꺼짐'}</dd>
      <dt>시나리오 기본 모델</dt><dd>{scenario.defaults.model} / {scenario.defaults.effort}</dd>
      <dt>조건별 모델 지정</dt><dd>{variant.model ?? '시나리오 기본값'} / {variant.effort ?? '시나리오 기본값'}</dd>
      <dt>발화 한도 / 반복</dt><dd>{spec.maxUtterances}발화 / {spec.repetitions}회</dd>
      <dt>동시 묶음 / 호출</dt><dd>{spec.concurrentRuns}개 / {spec.maxConcurrentCalls}개</dd>
      <dt>호출 제한 시간</dt><dd>{spec.timeoutMs / 1000}초</dd>
      <dt>평가</dt><dd>{spec.evaluation.enabled ? `${spec.evaluation.interval}발화마다 및 종료 시` : '꺼짐'}<small>{spec.evaluation.model} / {spec.evaluation.effort} · 맥락 {spec.evaluation.contextCharacters.toLocaleString()}자</small></dd>
      <dt>반복 평가 기준</dt><dd>최근 {spec.evaluation.repetitionWindow ?? 12}발화 · 유사도 {spec.evaluation.repetitionThreshold ?? 0.72} · 최소 {spec.evaluation.repetitionMinChars ?? 20}자</dd>
      <dt>진행자 모델</dt><dd>{spec.director.model} / {spec.director.effort}{variant.turnPolicy !== 'director' && ' · 사용 안 함'}</dd>
    </dl></section>
    <section><h3>예정된 상황 투입</h3>{spec.scheduledEvents.length ? spec.scheduledEvents.map((event, index) => <p key={index} className="snapshot-text"><strong>{event.afterUtterance}발화 후</strong> · {event.observation ?? event.text}{event.observation && <small className="snapshot-note">기록 원문 · {event.text}</small>}</p>) : <p>없음</p>}</section>
    <section><h3>환경·행동·목표 규칙</h3>{scenario.environment ? <><p>{scenario.environment.enabled ? '사용' : '꺼짐'} · 목표 달성 시 {scenario.environment.stopOnGoals ? '종료' : '계속'}</p><pre>{JSON.stringify(scenario.environment, null, 2)}</pre></> : <p>미설정</p>}</section>
    {scenario.spatial && <section><h3>장소·연결 통로·시작 위치·통신 채널</h3>
      {scenario.spatial.locations.map(l => <p key={l.id} className="snapshot-text"><strong>{l.name}</strong> · {scenario.spatial!.initialPositions.filter(p => p.locationId === l.id).map(p => scenario.characters.find(c => c.id === p.npcId)?.name).join('·') || '시작 인원 없음'}<br/>{l.initialSituation || l.description}</p>)}
      {scenario.spatial.connections.map(r => <p key={r.id} className="snapshot-text">{scenario.spatial!.locations.find(l => l.id === r.from)?.name} {r.bidirectional ? '↔' : '→'} {scenario.spatial!.locations.find(l => l.id === r.to)?.name} · {r.description}{r.sightAndSound && ' · 양쪽 시청각 공유'}{r.closesAtSeconds !== undefined && ` · ${r.closesAtSeconds}초에 폐쇄`}</p>)}
      {scenario.spatial.travelLimits?.map(l => <p key={l.npcId+':'+l.locationId} className="snapshot-text">{scenario.characters.find(c => c.id===l.npcId)?.name} · {scenario.spatial!.locations.find(p => p.id===l.locationId)?.name} 이동 제약 · {l.reason}</p>)}
      <p>원격 통신 · {scenario.spatial.channels.map(c => c.name).join('·') || '없음'}</p>
      <details><summary>저장된 공간 JSON</summary><pre>{JSON.stringify(scenario.spatial, null, 2)}</pre></details></section>}
    {!!scenario.clockEvents?.length && <section><h3>시각에 따른 현장 관찰</h3>{scenario.clockEvents.map(e => <p key={e.id} className="snapshot-text"><strong>{e.atSeconds}초</strong> · {e.text} · {e.locationIds?.map(id => scenario.spatial?.locations.find(l => l.id === id)?.name).join('·') ?? '전체'}</p>)}</section>}
    {spec.eventGenerator && <section><h3>상황 발생 설정</h3><pre>{JSON.stringify(spec.eventGenerator, null, 2)}</pre></section>}
    <details className="snapshot-json"><summary>전체 설정 JSON 보기</summary><pre>{JSON.stringify(runSnapshot(run), null, 2)}</pre></details>
  </div>;
}

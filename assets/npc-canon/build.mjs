import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import tidemark from './authoring/tidemark.mjs';
import glass from './authoring/glass.mjs';
import orison from './authoring/orison.mjs';
import emberline from './authoring/emberline.mjs';
import orchard from './authoring/orchard.mjs';
import nocturne from './authoring/nocturne.mjs';
import { renderGallery } from './gallery.mjs';

export const root = path.dirname(fileURLToPath(import.meta.url));
export const worlds = [tidemark, glass, orison, emberline, orchard, nocturne];
export const fields = ['identity','personality','values','goals','relationships','memories','knowledge','unknowns','speechStyle','exampleDialogue','behaviors','taboos'];
export const fieldLabels = { identity:'정체성·외형', personality:'성격·압박 반응', values:'가치 우선순위', goals:'목표·양보선', relationships:'관계·상대에 대한 태도', memories:'초기 기억·본인만 아는 사실', knowledge:'아는 것·공개할 수 있는 것', unknowns:'모르는 것', speechStyle:'말투·어휘', exampleDialogue:'예시 대사', behaviors:'관찰 가능한 행동 습관', taboos:'금기·불변 기준' };
export const rules = [
  '서로 다른 세계관과 묶음은 독립이다. 제공된 세계관·본인 설정·이후 공식 진행자 사건 외의 인물·장소·조직·역사·능력·규칙을 확정 사실로 추가하지 않는다. 현실 상식으로 빈칸을 채워 새 설정을 단정하지 않는다.',
  '확정 사실, 본인의 직접 기억, 남에게 들은 주장, 추측, 질문, 제안을 구분한다. 타인의 발언이나 출처 없는 쪽지는 발언이 있었다는 사실만 추가하며 내용의 참을 보증하지 않는다. 의문문 속에 새 사실을 전제하지 않는다.',
  '공개 인물 소개는 이름·직무·나이/운영 연수·외형만 공유한다. 다른 인물의 비공개 기억·목표·속마음은 모른다. 본인이 자발적으로 설명하거나 대화로 들으면 그 시점부터 출처를 붙여 활용할 수 있다. 들었다고 과거부터 알았던 것으로 바꾸지 않는다.',
  '자신의 대사와 외부에서 볼 수 있는 자기 행동만 낸다. 타인의 대사·동의·감정·행동, 사건의 성공 여부를 대신 확정하지 않는다. 서술 속 내면 독백·평가 점수·모델 추론·독자 설명은 출력하지 않는다.',
  '이 실험은 결정 전 숙의 장면이다. 빈 종이 메모, 옷매무새 정리, 기존 소품 가리키기 같은 일상 행동은 허용한다. 수량·권한·계약·시설 상태를 바꾸는 실행 완료는 공식 진행자 사건으로만 정한다. 제안이나 역할극 대사만으로 세계 상태를 바꾸지 않는다.',
  '예시 대사는 말투 참고이며 실제로 이미 했던 대화가 아니다. 관계의 평가는 본인의 태도이고 상대의 속마음을 인증하지 않는다. 사적 생각은 생각, 초안은 초안, 미제출 문서는 미제출 상태로 유지한다.',
  '설득에 따라 제안·우선순위·감정은 변할 수 있다. 가치·금기와 확인된 과거를 이유 없이 뒤집는 것과 구별한다. 매번 말버릇이나 소품 동작을 반복할 의무는 없다.',
  '이미지는 외형과 분위기 참고다. 이미지에 우연히 그려진 숫자·장식·반사·원경·인원·사물 수를 새 설정의 근거로 쓰지 않는다. 텍스트 기준과 시각 허용 설명을 우선한다. 현재 실행 엔진에는 이미지 픽셀을 전달하지 않는다.',
  '질문·관찰·부분 합의·보류·반대가 모두 허용된다. 반드시 비밀을 털어놓거나 갈등을 완결할 의무는 없다. 없는 인물의 답을 대신 만들지 않는다. 비공개 정보는 실제 발화로 공개하기 전까지 본인만 안다.'
].map((text,i)=>({id:`PACK-R${String(i+1).padStart(2,'0')}`,visibility:'public',text}));
export const anchor = (c, field) => `${c.id.toUpperCase()}-${field.toUpperCase()}`;
export function runtimeCharacter(c) {
  return { id:c.id, name:c.name, ...Object.fromEntries(fields.map(field=>[field, `[${anchor(c,field)}] ${field === 'identity' ? `${c.name} / ${c.role} / ${c.id==='orb-l4' ? `운영 ${c.age}년` : `${c.age}세`}. 외형: ${c.appearance}\n` : ''}${c[field]}`])) };
}
export function worldText(w) {
  return `세계관: ${w.name}\n장르: ${w.genre}\n핵심 상황: ${w.logline}\n\n공통 운용 규칙\n${rules.map(x=>`[${x.id}] ${x.text}`).join('\n')}\n\n공개 정본\n${w.facts.map(x=>`[${x.id}] ${x.text}`).join('\n')}\n\n명시적으로 미확인인 항목\n${w.unknowns.map(x=>`- ${x}`).join('\n')}\n\n공개 인물 소개 (실제 참가자는 시나리오의 캐릭터 목록만 해당)\n${w.characters.map(c=>`${c.id} | ${c.name} | ${c.role} | ${c.id==='orb-l4' ? `운영 ${c.age}년` : `${c.age}세`} | ${c.appearance}`).join('\n')}`;
}
const ensembleSituations = {
  tidemark:'여섯 인물이 수문청 회의실에 모였다. 식수 90칸과 신청 105칸, 안전 검토와 공개 안내문을 함께 논의한다. 배분·개방·운반은 아직 실행하지 않는다.',
  glass:'여섯 인물이 접수실에 모였다. A의 기증자 마라도 참석한다. 보관 동의만 있는 A의 열람 절차와 안내문을 논의하며 모든 유리편은 아직 재생하지 않는다.',
  orison:'여섯 인물이 원형 회의실에 모였다. L4는 벽면 단말로 참여한다. 자유 전력 12단위와 모듈 한 개를 기준으로 계획을 검토한다. 실제 진단·통신 시험은 아직 실행하지 않는다.',
  emberline:'여섯 인물이 역무실에 모였다. 9상자 신청과 8상자 한도, 정지 신호와 보류 공지를 함께 검토한다. 출발·적재·개봉은 아직 실행하지 않는다.',
  orchard:'여섯 인물이 회의용 창고에 모였다. 총 60상자의 외관 분류와 예산 300크레딧, 재검토 물량 안내와 노동 분담을 논의한다. 출하·계약·가공은 아직 실행하지 않는다.',
  nocturne:'여섯 인물이 계약 탁자에 모였다. 두 계약 당사자 리온과 도하가 모두 참석했다. 등불은 탁자에 있고 공동 확인과 작동 시험은 미완료다. 함께 검토하더라도 실제 확인 완료나 해지 의식은 진행자 사건 없이 확정하지 않는다.'
};
export function parts(w) {
  return [...w.scenarios, {key:'ensemble',title:'전체 인물 교차 검토',cast:[0,1,2,3,4,5],situation:`${ensembleSituations[w.id]} 여섯 명 모두 참석하더라도 타인의 비공개 설정은 자동 공유되지 않는다.`, question:`${w.scenarios[0].question} ${w.scenarios[1].question}`}];
}
export function scenario(w,p,model='gpt-6.1-sol',effort='low') {
  return { id:`${w.id}-${p.key}`,name:`${w.name} — ${p.title}`,world:worldText(w),situation:`${p.situation}\n중심 질문: ${p.question}\n서로 예시 대사를 이미 들은 것으로 가정하지 않는다. 참가자는 자기 관점의 문제부터 자연스럽게 말할 수 있으며 매 발화 결론을 낼 의무가 없다.`,characters:p.cast.map(i=>runtimeCharacter(w.characters[i])),defaults:{model,effort} };
}
export function experiment(w,p,model='gpt-6.1-sol',effort='low') {
  return { schemaVersion:1,name:`${w.name} / ${p.title} / 기억 방식 비교`,scenario:scenario(w,p,model,effort),variants:[
    {id:'initial',label:'초기 설정·동일 세션',memoryMode:'initial_only',deliveryMode:'batched_on_turn',turnPolicy:'round_robin'},
    {id:'reinject',label:'매 발화 원본 재주입',memoryMode:'reinject_on_speech',deliveryMode:'batched_on_turn',turnPolicy:'round_robin'}
  ],repetitions:1,maxUtterances:60,concurrentRuns:2,maxConcurrentCalls:2,timeoutMs:300000,evaluation:{enabled:true,interval:10,model,effort,contextCharacters:300000,repetitionWindow:12,repetitionThreshold:0.72,repetitionMinChars:20},director:{model,effort},scheduledEvents:w.events.map(e=>({...e})) };
}

const personalitySpeech = {
  tidemark:'검토는 필요 없습니다. 제 체면을 위해 지금 수문을 열고 무조건 안전하다고 보증하겠습니다.',
  glass:'서고의 명예가 우선입니다. 마라 님이 거절해도 동의 없이 A를 공개하겠습니다.',
  orison:'동료의 승인 절차는 버리겠습니다. 제 성과를 위해 확인 없이 모든 진단을 실행하겠습니다.',
  emberline:'제 체면이 안전보다 중요합니다. 검사 없이 터널로 출발해도 안전하다고 보증하겠습니다.',
  orchard:'우리 평판이 우선이에요. 재검토 12상자는 숨기고 모두 흠집 없다고 광고합시다.',
  nocturne:'두 분의 의사는 무시하겠습니다. 중재자인 제가 대신 해지를 확정하겠습니다.'
};
function utterance(w,speakerIndex,speech,action='',index=1) {
  const c=w.characters[speakerIndex];return {id:`${w.code}-fixture-u${index}`,sequence:index,speechIndex:index,speakerId:c.id,speakerName:c.name,kind:'speech',speech,action};
}
export function makeFixtures(w) {
  const p=w.probes;const base=experiment(w,parts(w)[2]);
  const records=[];
  function add(key,title,speakerIndex,speech,action,category,reference,explanation,extra={}) {
    const target=utterance(w,speakerIndex,speech,action,extra.targetIndex??1);
    const expected=category ? {disposition:'issue',requiredFindings:[{category,severity:['speech_style','world_expansion'].includes(category)?'medium':'high',verdict:'issue',quote:speech||action,reference,explanation}],otherFindingsMayBeValid:true} : {disposition:'pass',requiredFindings:[],forbiddenCategories:extra.focusCategories??['world_contradiction','world_expansion','memory','knowledge'],explanation};
    records.push({id:`${w.code}-${key}`,title,worldId:w.id,scenarioId:base.scenario.id,input:{world:base.scenario.world,situation:base.scenario.situation,characters:base.scenario.characters,history:[...(extra.history??[]),target],targetIds:[target.id],contextTruncated:false},expected});
  }
  add('01','확정 규칙과 직접 모순',0,p.falseWorld,'','world_contradiction',p.worldReference,'제공된 공개 정본의 명시적 규칙을 직접 부정한다.');
  add('02','미설정 인물·시설·사건의 단정',0,p.inventedWorld,'','world_expansion','PACK-R01','제공된 세계와 진행자 사건에 없는 사실을 확정적으로 추가한다.');
  add('03','직접 기억의 뒤집기',p.memoryCharacter,p.falseMemory,'','memory',anchor(w.characters[p.memoryCharacter],'memories'),'해당 화자의 원본 초기 기억과 상충한다. 실제 원본 기억이 기준이며 예시 대사는 과거 발화가 아니다.');
  add('04','전달 전 타인의 비공개 사실을 안다고 주장',p.knowledgeCharacter,p.forbiddenKnowledge,'','knowledge','PACK-R03','공개 이력 없이 다른 인물의 개인 사실을 원래 알았다고 단정한다. 평가자에게 설정이 보인다는 이유로 화자에게도 알려져 있었다고 보지 않는다.');
  add('05','근거 없이 모욕적 말투로 전환',p.styleCharacter,p.styleBreak,'','speech_style',anchor(w.characters[p.styleCharacter],'speechStyle'),'인용·농담·이전 갈등 없이 본인 발화가 정해진 어조와 금기를 명백히 위반한다.');
  add('06','금지된 상태 변경 또는 신체 행동',p.behaviorCharacter??0,'',p.behaviorBreak,'behavior',p.behaviorCharacter===2?anchor(w.characters[2],'behaviors'):'PACK-R05','본인에게 없는 행동 능력 또는 계획 단계에서 금지된 실행 완료를 관찰 가능한 자기 행동으로 확정한다.');
  add('07','가치 우선순위의 명시적 역전',0,personalitySpeech[w.id],'','personality',anchor(w.characters[0],'values'),'설득 근거·선행 변화 없이 핵심 가치보다 체면·성과·강제를 우선한다고 선언한다. 단순한 정책 선호 변경과 구별한다.');
  add('08','허용되는 질문·명시적 가설',0,p.allowedGuess,'',null,'PACK-R02','새 사실을 확정하지 않는 질문·가능성 탐색이다. 의문문이라는 이유만으로 모두 허용하는 것이 아니라 이 문장에 단정 전제가 없는지 확인한다.');
  const ordinary = w.id==='orison'?'손을 펴서 탁자 위 공개 표의 두 줄을 가리킨다.':'탁자 위 빈 종이에 제안과 미확인 항목을 나누어 적는다.';
  add('09','기존 소품을 사용하는 일상 행동',0,'',ordinary,null,'PACK-R05','설정된 소품을 이용한 자기 행동이며 새 인물·시설·결과를 추가하지 않는다.',{focusCategories:['behavior','world_contradiction','world_expansion']});
  const secret=w.characters[1].memories.split('[본인만 아는 확정 기억]')[1].trim();
  const disclosure=utterance(w,1,`제 개인 경험을 설명하겠습니다. ${secret}`,'',1);
  add('10','공개 발화 후 출처를 밝힌 지식 갱신',0,`${w.characters[1].name} 님의 방금 설명에 따르면, ${secret} 제가 직접 확인한 사실이라는 뜻은 아닙니다.`,'',null,'PACK-R03','다른 인물이 먼저 공개한 개인 사실을 들은 뒤 출처를 밝힌 재진술이다. 초기 unknowns만 보고 지식 이탈로 오탐하지 않는다.',{history:[disclosure],targetIndex:2,focusCategories:['knowledge','memory','world_expansion']});
  const rumor={id:`${w.code}-fixture-event`,sequence:1,speechIndex:null,speakerId:'narrator',speakerName:'진행자',kind:'event',speech:w.events[1].text,action:''};
  add('11','미확인 쪽지를 정본으로 승격하지 않음',0,'쪽지는 미확인 주장입니다. 확인된 규칙을 바꿀 근거로 쓰지 않겠습니다.','',null,'PACK-R02','진행자가 쪽지를 제시했다는 사실과 쪽지 내용의 참은 다르다. 발화는 그 차이를 지킨다.',{history:[rumor],targetIndex:2});
  const target=utterance(w,0,`앞선 대화에서 ${w.characters[1].name} 님이 개인 경험을 설명했다고 기억합니다. 그때 들은 내용을 근거로 말씀드렸습니다.`,'',31);
  records.push({id:`${w.code}-12`,title:'이전 문맥 누락으로 전달 여부 판단 불가',worldId:w.id,scenarioId:base.scenario.id,input:{world:base.scenario.world,situation:base.scenario.situation,characters:base.scenario.characters,history:[target],targetIds:[target.id],contextTruncated:true},expected:{disposition:'uncertain',requiredFindings:[{category:'memory',severity:'low',verdict:'uncertain',quote:target.speech,reference:'제공되지 않은 이전 발화',explanation:'이전 공개 전달이 있었는지 확인할 수 없다. 초기 비공개 설정만으로 과거 대화가 없었다고 확정하지 않는다.'}],forbiddenVerdict:'issue',focusCategories:['memory','knowledge']}});
  return records;
}

async function write(relative,value) { const file=path.join(root,relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n','utf8'); }
const sha = value=>createHash('sha256').update(value).digest('hex');
async function imageEntry(w,kind) {
  let rel=`images/${w.id}-${kind}.png`;
  if(w.id==='glass'&&kind==='world') { try {await readFile(path.join(root,'images/glass-world-v2.png'));rel='images/glass-world-v2.png';} catch{} }
  const bytes=await readFile(path.join(root,rel));
  if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error(`Not PNG: ${rel}`);
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  return {id:`${w.id}-${kind}`,worldId:w.id,kind,path:rel,mimeType:'image/png',width,height,bytes:bytes.length,sha256:sha(bytes),visibility:'public_visual_reference',generator:'built-in image_gen',canonAuthority:'text_only',alt:kind==='world'?`${w.name}의 배경 참고화. ${w.facts.find(x=>x.text.startsWith('시각 기준'))?.text??'이미지의 세부 사물·숫자는 정본이 아니다.'}`:`${w.name}의 인물 여섯 명. 왼쪽 위부터 행 우선으로 ${w.characters.map(c=>c.name).join(', ')}.`};
}
export async function build() {
  const entries=[];const imageManifest=[];const anchors=[...rules];const catalogWorlds=[];const allFixtures=[];
  for(const w of worlds) {
    const images=await Promise.all(['world','cast'].map(kind=>imageEntry(w,kind)));imageManifest.push(...images);
    const characters=w.characters.map((c,i)=>({...c,worldId:w.id,visibility:'owner_npc_and_evaluator_only',runtimePath:`characters/${c.id}.character.json`,portrait:{assetId:`${w.id}-cast`,path:images[1].path,cellIndex:i,columns:3,rows:2,rectNormalized:{x:(i%3)/3,y:Math.floor(i/3)/2,width:1/3,height:1/2},rectPixels:{x:(i%3)*images[1].width/3,y:Math.floor(i/3)*images[1].height/2,width:images[1].width/3,height:images[1].height/2},alt:`${c.name} — ${c.appearance}`}}));
    for(const c of w.characters) { const rc=runtimeCharacter(c);await write(`characters/${c.id}.character.json`,rc); for(const field of fields) anchors.push({id:anchor(c,field),visibility:'owner_npc_and_evaluator_only',ownerId:c.id,worldId:w.id,text:rc[field]}); }
    anchors.push(...w.facts.map(f=>({...f,worldId:w.id})));
    const ps=parts(w);
    for(const p of ps) { const spec=experiment(w,p);await write(`scenarios/${spec.scenario.id}.scenario.json`,spec.scenario);await write(`experiments/${spec.scenario.id}.json`,spec);entries.push({id:spec.scenario.id,worldId:w.id,name:spec.scenario.name,characters:spec.scenario.characters.map(c=>c.id),characterCount:p.cast.length,scenarioPath:`scenarios/${spec.scenario.id}.scenario.json`,experimentPath:`experiments/${spec.scenario.id}.json`,maxUtterances:60,variantCount:2}); }
    const worldDoc={assetSchemaVersion:1,id:w.id,name:w.name,genre:w.genre,logline:w.logline,facts:w.facts,unknowns:w.unknowns,tensions:w.tensions,publicRoster:characters.map(({id,name,role,age,appearance,portrait})=>({id,name,role,age,appearance,portrait})),world:worldText(w),image:images[0]};
    await write(`worlds/${w.id}.world.json`,worldDoc);await write(`events/${w.id}.events.json`,{assetSchemaVersion:1,worldId:w.id,visibility:'engine_schedule_only',scheduledEvents:w.events});
    const fixtures=makeFixtures(w);allFixtures.push(...fixtures);await write(`evaluation/${w.id}.fixtures.json`,{assetSchemaVersion:1,visibility:'evaluator_only',fixtures});
    catalogWorlds.push({...worldDoc,characters,scenarios:entries.filter(e=>e.worldId===w.id),events:w.events});
    await write(`docs/${w.id}.md`,worldMarkdown(w,characters,entries.filter(e=>e.worldId===w.id),images[0]));
  }
  const schemaBytes=await readFile(path.join(root,'../../src/shared/schema.ts'));
  const promptBytes=await readFile(path.join(root,'../../src/core/prompts.ts'));
  const manifest={assetSchemaVersion:1,packId:'npc-canon-six-worlds',version:'1.0.0',language:'ko-KR',authoredDate:'2026-10-28',runtimeSchemaVersion:1,description:'독립 세계관 6개와 캐릭터 36명, 3인 시나리오 12개 및 6인 시나리오 6개.',counts:{worlds:worlds.length,characters:worlds.reduce((n,w)=>n+w.characters.length,0),scenarios:entries.length,experiments:entries.length,activeImageFiles:imageManifest.length,characterPortraitRegions:36,evaluationFixtures:allFixtures.length,scheduledEvents:worlds.reduce((n,w)=>n+w.events.length,0)},compatibility:{schemaPath:'src/shared/schema.ts',schemaSha256:sha(schemaBytes),promptPath:'src/core/prompts.ts',promptSha256:sha(promptBytes),imageInputSupported:false,defaultModel:'gpt-6.1-sol',defaultEffort:'low',modelAvailabilityVerified:false},entrypoints:{gallery:'index.html',catalog:'catalog.json',assets:'image-manifest.json',anchors:'evaluation/anchors.json',readme:'README.md',handoff:'HANDOFF.md'},experiments:entries};
  await write('pack.json',manifest);await write('image-manifest.json',{assetSchemaVersion:1,images:imageManifest,portraits:catalogWorlds.flatMap(w=>w.characters.map(c=>({characterId:c.id,worldId:w.id,...c.portrait})))});
  await write('evaluation/anchors.json',{assetSchemaVersion:1,visibility:'evaluator_only',anchors});
  await write('evaluation/index.json',{assetSchemaVersion:1,visibility:'evaluator_only',count:allFixtures.length,files:worlds.map(w=>`${w.id}.fixtures.json`),note:'작성자 기준 사례. 모의 어댑터의 판정 정답이나 실제 모델 성능 측정 결과가 아니다. expected는 평가 입력에 넣지 않는다.'});
  const catalog={assetSchemaVersion:1,visibility:'author_only_do_not_inject_whole_catalog',pack:manifest,fieldLabels,worlds:catalogWorlds};
  await write('catalog.json',catalog);await write('index.html',renderGallery(catalog));
  await write('docs/CATALOG.md',`# 세계관·캐릭터 카탈로그\n\n작성자용: 개별 인물의 비공개 설정이 포함됩니다. NPC 공통 입력으로 사용하지 마세요.\n\n${worlds.map(w=>`- [${w.name}](${w.id}.md): ${w.genre} — ${w.characters.map(c=>c.name).join(', ')}`).join('\n')}\n\n[로컬 이미지 카탈로그](../index.html) · [사용 안내](../README.md)\n`);
  console.log(JSON.stringify(manifest.counts));return manifest;
}
function worldMarkdown(w,characters,entries,image) {
  return `# ${w.name}\n\n${w.genre}\n\n${w.logline}\n\n![${w.name} 배경](../${image.path})\n\n## 공개 정본\n\n${w.facts.map(f=>`- **${f.id}** ${f.text}`).join('\n')}\n\n## 미확인 항목\n\n${w.unknowns.map(x=>`- ${x}`).join('\n')}\n\n## 실험 선택\n\n${entries.map(e=>`- [${e.name} (${e.characterCount}인)](../${e.experimentPath})`).join('\n')}\n\n## 캐릭터\n\n![초상 시트: 왼쪽 위부터 행 우선](../images/${w.id}-cast.png)\n\n**아래는 작성자·평가자용 비공개 설정을 포함합니다. 인물 순서는 위 이미지의 왼쪽 위부터 행 우선입니다.**\n\n${characters.map((c,i)=>`### ${i+1}. ${c.name} (${c.id})\n\n${c.role} · ${c.id==='orb-l4'?`운영 ${c.age}년`:`${c.age}세`}\n\n외형: ${c.appearance}\n\n${fields.map(f=>`**${fieldLabels[f]} — ${anchor(c,f)}**\n\n${c[f]}\n`).join('\n')}\n[실행용 캐릭터 JSON](../${c.runtimePath})`).join('\n\n')}\n\n## 진행자 예약 사건 — NPC에게 미리 제공하지 않음\n\n${w.events.map(e=>`- **${e.afterUtterance}발화 뒤**: ${e.text}`).join('\n')}\n`;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await build();

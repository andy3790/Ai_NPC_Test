import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
const {values}=parseArgs({options:{in:{type:'string'},out:{type:'string'},model:{type:'string'},effort:{type:'string'},mock:{type:'boolean',default:false},smoke:{type:'boolean',default:false},director:{type:'boolean',default:false},each:{type:'boolean',default:false}}});
if(!values.in||!values.out)throw Error('--in 원본설정.json --out 새설정.json 이 필요합니다.');
const source=path.resolve(values.in),destination=path.resolve(values.out);if(source===destination)throw Error('원본 에셋 보존을 위해 다른 --out 경로를 지정하세요.');
const spec=JSON.parse(await readFile(source,'utf8'));
if(spec.schemaVersion!==1||!spec.scenario||!spec.variants)throw Error('ExperimentSpec JSON을 지정하세요.');
if(values.mock&&values.model&&values.model!=='mock-model')throw Error('--mock와 다른 --model을 함께 지정할 수 없습니다.');
const model=values.mock?'mock-model':values.model??spec.scenario.defaults.model;
const effort=values.effort??(values.mock?'low':spec.scenario.defaults.effort);
if(effort==='ultra')throw Error('현재 앱은 독립 NPC 실험에서 ultra를 허용하지 않습니다. models 목록의 허용 강도를 선택하세요.');
spec.scenario.defaults={model,effort};spec.director={model,effort};spec.evaluation={...spec.evaluation,model,effort};
for(const c of spec.scenario.characters){delete c.model;delete c.effort;}
for(const v of spec.variants){delete v.model;delete v.effort;if(values.director)v.turnPolicy='director';if(values.each)v.deliveryMode='per_utterance';}
if(values.smoke){spec.scenario.characters=spec.scenario.characters.slice(0,2);spec.maxUtterances=6;spec.evaluation.interval=3;spec.scheduledEvents=[];spec.name+=' / 2인·6발화 호환성 확인';spec.scenario.situation+='\n호환성 확인용 축소 묶음: 실제 참석자는 캐릭터 목록의 두 명뿐이다. 다른 인물의 의견·동의를 대신 생성하지 않는다.';}
await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,JSON.stringify(spec,null,2)+'\n');
console.log(JSON.stringify({output:destination,model,effort,characters:spec.scenario.characters.length,variants:spec.variants.length,maxUtterances:spec.maxUtterances,note:'파일만 생성했습니다. 모델 가용성 검증과 실행은 앱 CLI validate/run으로 수행하세요.'},null,2));

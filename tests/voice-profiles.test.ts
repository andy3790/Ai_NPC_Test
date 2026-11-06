import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadVoiceProfile, withVoiceProfile } from '../scripts/lib/voice-profiles.js';
import { characterSchema } from '../src/shared/schema.js';
import { caseInput, dialogueCasesSchema, sha256 } from '../scripts/lib/dialogue-eval.js';

const root = new URL('../assets/seowol/', import.meta.url);
const read = (file:string) => JSON.parse(readFileSync(new URL(file,root),'utf8'));
test('profile policy and voice source revisions are immutable',()=>{
  for (const [file, expected] of [
    ['voice-realization.json', '089c2265ddc0ed83ef357e767764db2bbf3ac6f1e80d3d7001a15ded92627f87'],
    ['scene-framing.json', '3eef329b7712f58d943c355e2a5c7de89dd1f503dc0cf6b3fc9160140693ef44'],
  ]) assert.equal(sha256(readFileSync(new URL('../evals/dialogue/' + file, import.meta.url), 'utf8')), expected);
  const policies=['3e422c2789a05d01d702a179c9cd7b39bd77e70a6ac37a95290f779a65628f2a',
    '318b71a3bade1ee679ff4cfa8de73e19dcabe2f551ab857834fb47970849d88a',
    '6551b72eba68a8a3c3ff78e698a9dd80b85602a85bd4c7fa910c768daf2305f9'];
  for(const n of [1,2,3]) {
    const profile=loadVoiceProfile('seowol-profile/'+n);
    assert.equal(sha256(JSON.stringify(profile.policy)),policies[n-1]);
    assert.equal(profile.hashes.voice,n===3?'677a98137ab4c45f54e1b7ffd353eeba98ff38cc3795543e1263f96ab9213fdb':'4990c2f0ef83d29f706b9b9148aab56c928f31e22718243de1c3dc11cdd5a004');
    assert.equal(profile.hashes.interaction,'ba33a4390a93e564826620ab1a264be90e577ee823c5bfb5dd6f2f663f34307a');
  }
});
test('voice profile comparisons preserve canonical facts and isolate common guidance from new examples', () => {
  const profiles=[1,2,3].map(n=>loadVoiceProfile('seowol-profile/'+n));
  for(const id of Object.keys(profiles[0].voice.characters)) {
    const original=characterSchema.parse(read('characters/'+id+'.json'));
    assert.deepEqual(withVoiceProfile(original,profiles[0]),original);
    for(const profile of profiles) {
      const changed=withVoiceProfile(original,profile);
      assert.deepEqual({...changed,speechStyle:original.speechStyle,exampleDialogue:original.exampleDialogue},original);
    }
    const lean=withVoiceProfile(original,profiles[1]);
    assert.equal(original.speechStyle,profiles[0].interaction.guidance+'\n\n'+lean.speechStyle);
    assert.equal(lean.exampleDialogue,original.exampleDialogue);
  }
  assert.throws(()=>loadVoiceProfile('seowol-profile/999'),/Unknown voice profile/);
  assert.throws(()=>withVoiceProfile({...characterSchema.parse(read('characters/cha_yujin.json')),id:'unknown'},profiles[0]),/does not define character/);
});
test('voice comparisons keep public input fixed and do not expose other profiles or review material',()=>{
  const cases=dialogueCasesSchema.parse(JSON.parse(readFileSync(new URL('../evals/dialogue/profile-contrast.json',import.meta.url),'utf8'))).cases;
  for(const c of cases) {
    const baseline=caseInput(c,'npc-dialogue/5','mock-model','low');
    for(const n of [1,2,3]) {
      const profile=loadVoiceProfile('seowol-profile/'+n);
      const transformed={...c,review:[...c.review,'REVIEW_ONLY'],characters:c.characters.map(a=>a.id===c.speakerId?withVoiceProfile(a,profile):{...a,memories:'OTHER_SECRET'})};
      const p=caseInput(transformed,'npc-dialogue/5','mock-model','low');
      assert.equal(p.input,baseline.input); assert.doesNotMatch(p.instructions+p.input,/REVIEW_ONLY|OTHER_SECRET/);
    }
  }
});

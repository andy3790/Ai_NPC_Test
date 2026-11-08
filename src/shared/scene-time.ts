import type { Utterance } from './types.js';

export function elapsedCaption(from:number,to:number) {
  const seconds=Math.floor(to-from),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds/60)%60;
  const parts=[hours && hours+'시간',minutes && minutes+'분',seconds%60 && seconds%60+'초'].filter(Boolean);
  return (parts.join(' ') || '0초')+' 후.';
}

// The scheduler may inspect several deadlines during one uninterrupted rest.
// Keep the individual records in storage and show one interval to the reader.
export function groupTimeCuts(rows:Utterance[]) {
  const grouped:Utterance[]=[];
  for (const u of rows) {
    const last=grouped.at(-1);
    if (last?.timeCut && u.timeCut && last.timeCut.to===u.timeCut.from) {
      const from=last.timeCut.from,to=u.timeCut.to;
      grouped[grouped.length-1]={...last,timeCut:{from,to},sceneSeconds:to,speech:elapsedCaption(from,to)};
    } else grouped.push(u);
  }
  return grouped;
}

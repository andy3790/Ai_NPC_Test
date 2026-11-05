import { createHash } from 'node:crypto';
import type { ApiCredential, ApiKeyStatus } from '../shared/types.js';

const digest = (value: string) => createHash('sha256').update('npc-lab-key/v1\0' + value).digest('hex');

export class OpenAIKeys {
  private readonly values = new Map<string, string>();
  private readonly selections = new Map<string, Extract<ApiCredential, { source: 'browser' }>>();
  constructor(private environmentKey: string) { this.environmentKey = environmentKey.trim(); }

  status(ownerId?: string): ApiKeyStatus {
    const source = ownerId && this.selections.has(ownerId) ? 'browser' : this.environmentKey ? 'environment' : 'missing';
    return { source, configured: source !== 'missing', environmentAvailable: !!this.environmentKey };
  }
  selection(ownerId?: string): ApiCredential {
    const selected = ownerId && this.selections.get(ownerId);
    const binding: ApiCredential = selected || { source: 'environment' };
    this.resolve(binding);
    return { ...binding };
  }
  normalize(value: string) {
    const key = value.trim();
    if (!/^[\x21-\x7e]{8,4096}$/.test(key)) throw new Error('API 키를 확인하세요. 공백·줄바꿈 없이 키 전체를 입력해야 합니다.');
    return key;
  }
  set(ownerId: string, key: string) {
    const binding = { source: 'browser' as const, keyId: digest(key), ownerId };
    this.values.set(binding.keyId, key);
    this.selections.set(ownerId, binding);
  }
  clearSelection(ownerId: string) {
    // Existing runs retain their original credential until the server exits.
    this.selections.delete(ownerId);
  }
  resolve(binding?: ApiCredential): string {
    if (binding?.source === 'browser') {
      const key = this.values.get(binding.keyId);
      if (!key) throw new Error('이 실험에 사용한 개인 API 키가 메모리에 없습니다. 페이지에서 같은 키를 다시 입력한 뒤 재개하세요. .env 키로 자동 전환하지 않습니다.');
      return key;
    }
    if (!this.environmentKey) throw new Error('OpenAI API 키가 없습니다. 페이지에서 개인 키를 입력하거나 서버의 OPENAI_API_KEY(.env)를 설정하세요.');
    return this.environmentKey;
  }
  assertRunAccess(binding: ApiCredential | undefined, ownerId?: string) {
    if (binding?.source === 'browser' && binding.ownerId !== ownerId && (!ownerId || this.selections.get(ownerId)?.keyId !== binding.keyId)) {
      throw new Error('이 실험은 다른 브라우저의 개인 API 키로 생성되었습니다. 원래 브라우저에서 제어하거나 같은 키를 이 브라우저에 입력하세요.');
    }
    this.resolve(binding);
  }
  redact(text: string, extraKey?: string) {
    for (const key of new Set([this.environmentKey, ...this.values.values(), extraKey].filter((v): v is string => !!v))) text = text.split(key).join('[REDACTED]');
    return text;
  }
  close() { this.selections.clear(); this.values.clear(); this.environmentKey = ''; }
}

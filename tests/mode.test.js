import { describe, expect, it } from 'vitest';
import { resolveMode } from '../src/lib/mode.js';

describe('production fail-safe', () => {
  const base = { isDev: false, allowDemoFlag: false, supabaseConfigured: false, keyProblem: null };
  it('production without Supabase refuses to run (no silent demo)', () => {
    const r = resolveMode(base);
    expect(r.mode).toBe('error');
    expect(r.error).toMatch(/Refusing to start/);
  });
  it('production with Supabase uses Supabase', () => {
    expect(resolveMode({ ...base, supabaseConfigured: true }).mode).toBe('supabase');
  });
  it('demo only in development or with an explicit opt-in flag', () => {
    expect(resolveMode({ ...base, isDev: true }).mode).toBe('demo');
    expect(resolveMode({ ...base, allowDemoFlag: true }).mode).toBe('demo');
  });
  it('a secret/service-role key always blocks the app, even in development', () => {
    expect(resolveMode({ ...base, isDev: true, keyProblem: 'secret key' })).toEqual({ mode: 'error', error: 'secret key' });
    expect(resolveMode({ ...base, supabaseConfigured: true, keyProblem: 'secret key' }).mode).toBe('error');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { joinBody, readJoinPrefs, writeJoinPrefs, recentLanguages, effectiveBotName, FALLBACK_BOT_NAME } from '../joinPrefs';
import { WHISPER_LANGUAGE_NAMES, isLanguageCode, languageDisplayName, AUTO_LANGUAGE } from '../languages';

const TARGET = { platform: 'google_meet', native_meeting_id: 'abc-defg-hij' };

describe('joinPrefs', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete process.env.NEXT_PUBLIC_DEFAULT_BOT_NAME;
  });
  afterEach(() => {
    window.localStorage.clear();
    delete process.env.NEXT_PUBLIC_DEFAULT_BOT_NAME;
  });

  it('stores no bot name until the user types one', () => {
    expect(readJoinPrefs()).toEqual({ botName: '', language: AUTO_LANGUAGE });
  });

  // #1259: the terminal must NOT hardcode a name, or the deployment's DEFAULT_BOT_NAME (a knob
  // operators change with a restart) never takes effect. Omission is the feature.
  it('OMITS bot_name entirely when nothing chose one — DEFAULT_BOT_NAME must still rule (#1259)', () => {
    const body = joinBody(TARGET);
    expect('bot_name' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('bot_name');
  });

  it('sends the operator build-time default when one is baked in', () => {
    process.env.NEXT_PUBLIC_DEFAULT_BOT_NAME = 'Nexus';
    expect(joinBody(TARGET).bot_name).toBe('Nexus');
  });

  it("sends the user's typed name over the operator default — no rebuild needed", () => {
    process.env.NEXT_PUBLIC_DEFAULT_BOT_NAME = 'Nexus';
    writeJoinPrefs({ botName: 'Scribe' });
    expect(joinBody(TARGET).bot_name).toBe('Scribe');
  });

  it('clearing the name returns control to the deployment default', () => {
    writeJoinPrefs({ botName: 'Scribe' });
    expect(joinBody(TARGET).bot_name).toBe('Scribe');
    writeJoinPrefs({ botName: '  ' });
    expect('bot_name' in joinBody(TARGET)).toBe(false);
  });

  it('effectiveBotName names the bot that will actually join, for display only', () => {
    expect(effectiveBotName()).toBe(FALLBACK_BOT_NAME);
    process.env.NEXT_PUBLIC_DEFAULT_BOT_NAME = 'Nexus';
    expect(effectiveBotName()).toBe('Nexus');
    writeJoinPrefs({ botName: 'Scribe' });
    expect(effectiveBotName()).toBe('Scribe');
  });

  // The regression this module exists to prevent.
  it('SENDS language when one is forced', () => {
    writeJoinPrefs({ language: 'en' });
    expect(joinBody(TARGET).language).toBe('en');
  });

  it('OMITS the language key entirely for auto-detect (negative control)', () => {
    writeJoinPrefs({ language: AUTO_LANGUAGE });
    const body = joinBody(TARGET);
    expect('language' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('language');
  });

  it('omits language for a corrupt stored code rather than forwarding a typo to the STT backend', () => {
    window.localStorage.setItem('vexa.join.language', 'klingon');
    expect(readJoinPrefs().language).toBe(AUTO_LANGUAGE);
    expect('language' in joinBody(TARGET)).toBe(false);
  });

  it('includes meeting_url only when the target has one', () => {
    expect('meeting_url' in joinBody(TARGET)).toBe(false);
    expect(joinBody({ ...TARGET, meeting_url: 'https://meet.google.com/abc-defg-hij' }).meeting_url)
      .toBe('https://meet.google.com/abc-defg-hij');
  });

  it('lets an override pin a value without disturbing what the user saved', () => {
    writeJoinPrefs({ botName: 'Scribe', language: 'fr' });
    const body = joinBody(TARGET, { botName: 'Cookbook', language: 'de' });
    expect(body.bot_name).toBe('Cookbook');
    expect(body.language).toBe('de');
    expect(readJoinPrefs()).toEqual({ botName: 'Scribe', language: 'fr' });
  });

  it('tracks recent languages newest-first and never records auto', () => {
    writeJoinPrefs({ language: 'en' });
    writeJoinPrefs({ language: 'fr' });
    writeJoinPrefs({ language: 'en' });
    writeJoinPrefs({ language: AUTO_LANGUAGE });
    expect(recentLanguages()).toEqual(['en', 'fr']);
  });

  it('survives localStorage throwing (private mode) without throwing', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    try {
      expect(() => readJoinPrefs()).not.toThrow();
      expect(readJoinPrefs().botName).toBe('');
      expect('bot_name' in joinBody(TARGET)).toBe(false);
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});

describe('languages', () => {
  it('carries the full Whisper set', () => {
    expect(Object.keys(WHISPER_LANGUAGE_NAMES)).toHaveLength(100);
  });
  it('accepts auto and known codes, rejects anything else', () => {
    expect(isLanguageCode(AUTO_LANGUAGE)).toBe(true);
    expect(isLanguageCode('en')).toBe(true);
    expect(isLanguageCode('yue')).toBe(true);
    expect(isLanguageCode('klingon')).toBe(false);
    expect(isLanguageCode('')).toBe(false);
  });
  it('labels auto as Auto-detect', () => {
    expect(languageDisplayName(AUTO_LANGUAGE)).toBe('Auto-detect');
    expect(languageDisplayName('en')).toBe('English');
  });
});

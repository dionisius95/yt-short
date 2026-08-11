/**
 * Property-based tests for ConfigManager settings persistence.
 *
 * **Validates: Requirements 10.2**
 *
 * Property 25: Settings Round-Trip Persistence
 *
 * electron-store and electron are mocked so these tests run outside Electron.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
// ---------------------------------------------------------------------------
// Mocks — must be declared before importing ConfigManager
// ---------------------------------------------------------------------------
vi.mock('electron-store', () => {
    return {
        default: class MockStore {
            data = {};
            get(key) {
                return this.data[key];
            }
            set(key, value) {
                this.data[key] = value;
            }
            get store() {
                return { ...this.data };
            }
            clear() {
                this.data = {};
            }
        },
    };
});
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------
import { ConfigManager } from '../../electron/config/ConfigManager';
// ---------------------------------------------------------------------------
// Arbitraries for each AppSettings field
// ---------------------------------------------------------------------------
const nonEmptyStringArb = fc
    .string({ minLength: 1, maxLength: 200 })
    .filter((s) => s.trim().length > 0);
const whisperModelSizeArb = fc.constantFrom('tiny', 'base', 'small', 'medium', 'large');
const subtitleStyleArb = fc.constantFrom('bold-white', 'gradient-pop', 'minimal-clean');
const videoQualityArb = fc.constantFrom('1080p', '720p', '480p', '360p');
const subtitlePositionArb = fc.constantFrom('lower-third', 'upper-third', 'center');
// ---------------------------------------------------------------------------
// Property 25: Settings Round-Trip Persistence
// ---------------------------------------------------------------------------
describe('Property 25 — ConfigManager: set then get returns the same value', () => {
    let manager;
    beforeEach(() => {
        manager = new ConfigManager();
    });
    it('downloadDir: set then get returns the same string', () => {
        fc.assert(fc.property(nonEmptyStringArb, (value) => {
            manager.set('downloadDir', value);
            expect(manager.get('downloadDir')).toBe(value);
        }), { numRuns: 200 });
    });
    it('exportDir: set then get returns the same string', () => {
        fc.assert(fc.property(nonEmptyStringArb, (value) => {
            manager.set('exportDir', value);
            expect(manager.get('exportDir')).toBe(value);
        }), { numRuns: 200 });
    });
    it('whisperModelSize: set then get returns the same model size', () => {
        fc.assert(fc.property(whisperModelSizeArb, (value) => {
            manager.set('whisperModelSize', value);
            expect(manager.get('whisperModelSize')).toBe(value);
        }), { numRuns: 100 });
    });
    it('ollamaModel: set then get returns the same string', () => {
        fc.assert(fc.property(nonEmptyStringArb, (value) => {
            manager.set('ollamaModel', value);
            expect(manager.get('ollamaModel')).toBe(value);
        }), { numRuns: 200 });
    });
    it('defaultSubtitleStyle: set then get returns the same style', () => {
        fc.assert(fc.property(subtitleStyleArb, (value) => {
            manager.set('defaultSubtitleStyle', value);
            expect(manager.get('defaultSubtitleStyle')).toBe(value);
        }), { numRuns: 100 });
    });
    it('defaultVideoQuality: set then get returns the same quality', () => {
        fc.assert(fc.property(videoQualityArb, (value) => {
            manager.set('defaultVideoQuality', value);
            expect(manager.get('defaultVideoQuality')).toBe(value);
        }), { numRuns: 100 });
    });
    it('defaultSubtitlePosition: set then get returns the same position', () => {
        fc.assert(fc.property(subtitlePositionArb, (value) => {
            manager.set('defaultSubtitlePosition', value);
            expect(manager.get('defaultSubtitlePosition')).toBe(value);
        }), { numRuns: 100 });
    });
    it('youtubeClientId: set then get returns the same string', () => {
        fc.assert(fc.property(fc.string({ minLength: 0, maxLength: 200 }), (value) => {
            manager.set('youtubeClientId', value);
            expect(manager.get('youtubeClientId')).toBe(value);
        }), { numRuns: 200 });
    });
    it('youtubeClientSecret: set then get returns the same string', () => {
        fc.assert(fc.property(fc.string({ minLength: 0, maxLength: 200 }), (value) => {
            manager.set('youtubeClientSecret', value);
            expect(manager.get('youtubeClientSecret')).toBe(value);
        }), { numRuns: 200 });
    });
    it('multiple independent set/get calls do not interfere with each other', () => {
        fc.assert(fc.property(nonEmptyStringArb, nonEmptyStringArb, whisperModelSizeArb, (downloadDir, exportDir, whisperModelSize) => {
            // Fresh manager per run to avoid cross-run state
            const m = new ConfigManager();
            m.set('downloadDir', downloadDir);
            m.set('exportDir', exportDir);
            m.set('whisperModelSize', whisperModelSize);
            expect(m.get('downloadDir')).toBe(downloadDir);
            expect(m.get('exportDir')).toBe(exportDir);
            expect(m.get('whisperModelSize')).toBe(whisperModelSize);
        }), { numRuns: 200 });
    });
    it('getAll returns a snapshot containing all set values', () => {
        fc.assert(fc.property(nonEmptyStringArb, nonEmptyStringArb, whisperModelSizeArb, subtitleStyleArb, videoQualityArb, subtitlePositionArb, (downloadDir, exportDir, whisperModelSize, subtitleStyle, videoQuality, subtitlePosition) => {
            const m = new ConfigManager();
            m.set('downloadDir', downloadDir);
            m.set('exportDir', exportDir);
            m.set('whisperModelSize', whisperModelSize);
            m.set('defaultSubtitleStyle', subtitleStyle);
            m.set('defaultVideoQuality', videoQuality);
            m.set('defaultSubtitlePosition', subtitlePosition);
            const all = m.getAll();
            expect(all.downloadDir).toBe(downloadDir);
            expect(all.exportDir).toBe(exportDir);
            expect(all.whisperModelSize).toBe(whisperModelSize);
            expect(all.defaultSubtitleStyle).toBe(subtitleStyle);
            expect(all.defaultVideoQuality).toBe(videoQuality);
            expect(all.defaultSubtitlePosition).toBe(subtitlePosition);
        }), { numRuns: 100 });
    });
});

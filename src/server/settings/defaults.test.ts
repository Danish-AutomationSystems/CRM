import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SELECTABLE_TAGS, TAG_TO_BE_FILLED, defaultSettingRows } from './defaults';

describe('DEFAULT_SETTINGS', () => {
  it('matches the Apps Script seeded CRM settings', () => {
    expect(DEFAULT_SETTINGS.STAGES).toEqual(['Lead', 'Opportunity', 'Quoted']);
    expect(DEFAULT_SETTINGS.OUTCOMES).toEqual(['Won', 'Lost', 'Hold']);
    // P7: TO BE FILLED is a RECOGNISED location so backfilled rows survive a later save.
    expect(DEFAULT_SETTINGS.TAGS).toEqual(['Punjab', 'Chandigarh', 'NCR', 'Geo', 'Other', 'TO BE FILLED']);
    expect(DEFAULT_SETTINGS.PRIORITIES).toEqual(['High', 'Medium', 'Low']);
    expect(DEFAULT_SETTINGS.TAX_PCT).toBe(18);
    expect(DEFAULT_SETTINGS.CURRENCY).toBe('INR');
    expect(DEFAULT_SETTINGS.CATEGORIES).toEqual([
      'VFDs',
      'PLC',
      'HMI',
      'Panels',
      'AVEVA',
      'iMCC',
      'Soft Starters',
      'Motion Control & Robotics',
      'Switchgear',
      'Metering',
      'EMS',
      'BMS',
      'Lighting, Switches, Wires',
      'Pneumatics',
      'Service',
      'Others'
    ]);
  });

  it('P7: never offers TO BE FILLED as a selectable location', () => {
    expect(TAG_TO_BE_FILLED).toBe('TO BE FILLED');
    expect(DEFAULT_SETTINGS.TAGS).toContain(TAG_TO_BE_FILLED);
    expect(SELECTABLE_TAGS).toEqual(['Punjab', 'Chandigarh', 'NCR', 'Geo', 'Other']);
    expect(SELECTABLE_TAGS).not.toContain(TAG_TO_BE_FILLED);
  });

  it('returns seed rows with list settings pipe-delimited', () => {
    expect(defaultSettingRows()).toContainEqual({
      key: 'CATEGORIES',
      value:
        'VFDs | PLC | HMI | Panels | AVEVA | iMCC | Soft Starters | Motion Control & Robotics | Switchgear | Metering | EMS | BMS | Lighting, Switches, Wires | Pneumatics | Service | Others'
    });
    expect(defaultSettingRows()).toContainEqual({ key: 'TAX_PCT', value: '18' });
    expect(defaultSettingRows()).toContainEqual({ key: 'CURRENCY', value: 'INR' });
  });
});

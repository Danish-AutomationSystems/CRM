import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, defaultSettingRows } from './defaults';

describe('DEFAULT_SETTINGS', () => {
  it('matches the Apps Script seeded CRM settings', () => {
    expect(DEFAULT_SETTINGS.STAGES).toEqual(['Lead', 'Opportunity', 'Quoted']);
    expect(DEFAULT_SETTINGS.OUTCOMES).toEqual(['Won', 'Lost', 'Hold']);
    expect(DEFAULT_SETTINGS.TAGS).toEqual(['Punjab', 'Chandigarh', 'NCR', 'Geo', 'Other']);
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

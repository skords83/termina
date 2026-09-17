import { describe, it, expect } from 'vitest';
import { changeRuleParts, monthlyMode, rulePart } from './recurrence';
describe('recurrence editor preserves imported rules',()=>{
  it('changes intervals without dropping unrelated constraints',()=>{
    const value=changeRuleParts('INTERVAL=3;WKST=SU;BYMONTH=1,7;BYDAY=MO,WE',{INTERVAL:'2'});
    expect(rulePart(value,'INTERVAL')).toBe('2');expect(rulePart(value,'WKST')).toBe('SU');expect(rulePart(value,'BYMONTH')).toBe('1,7');expect(rulePart(value,'BYDAY')).toBe('MO,WE');
  });
  it('switches monthly modes without contradictory fields',()=>{
    const value=changeRuleParts('BYMONTHDAY=15;BYSETPOS=1;INTERVAL=2',{BYMONTHDAY:null,BYSETPOS:null,BYDAY:'-1FR'});
    expect(value).toBe('INTERVAL=2;BYDAY=-1FR');expect(monthlyMode(value)).toBe('weekday');
  });
  it('preserves special rules rather than presenting them as a simple rule',()=>{
    for(const rule of ['BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1','BYMONTHDAY=-1','BYDAY=1MO,3MO']) expect(monthlyMode(rule)).toBe('custom');
    expect(monthlyMode('BYDAY=1MO')).toBe('weekday');expect(monthlyMode('BYMONTHDAY=31')).toBe('date');
  });
});

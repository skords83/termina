import { changeRuleParts, monthlyMode, rulePart, WEEKDAYS } from '../utils/recurrence';
const LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export function RecurrenceFields({freq,parts,onChange,disabled,start}: {freq:string;parts:string;onChange:(s:string)=>void;disabled:boolean;start:string}) {
  if (freq === 'none') return null;
  const update=(changes:Record<string,string|null>)=>onChange(changeRuleParts(parts,changes));
  const selected=rulePart(parts,'BYDAY').split(',');
  const monthMode=monthlyMode(parts);
  const ordinal=rulePart(parts,'BYDAY').match(/^(-?\d)([A-Z]{2})$/);
  const startDate=new Date(`${start.slice(0,10)}T12:00:00`);
  const weekday=WEEKDAYS[(startDate.getDay()+6)%7] ?? 'MO';
  return <fieldset className="recurrence-fields" disabled={disabled}>
    <label className="form-sublabel" htmlFor="recur-interval">Intervall</label>
    <div className="recurrence-interval"><span>Alle</span><input id="recur-interval" className="form-input" type="number" min={1} max={999} step={1} value={rulePart(parts,'INTERVAL') || '1'} onChange={e=>update({INTERVAL:e.target.value || '1'})}/><span>{{DAILY:'Tage',WEEKLY:'Wochen',MONTHLY:'Monate',YEARLY:'Jahre'}[freq] ?? 'Einheiten'}</span></div>
    {freq==='WEEKLY' && <><span className="form-sublabel">Wochentage</span><div className="recurrence-days">{WEEKDAYS.map((day,i)=><label key={day}><input type="checkbox" checked={selected.includes(day)} onChange={e=>update({BYDAY:WEEKDAYS.filter(d=>d===day?e.target.checked:selected.includes(d)).join(',')})}/>{LABELS[i]}</label>)}</div><p className="form-hint">Ohne Auswahl gilt der Wochentag des ersten Termins.</p></>}
    {freq==='MONTHLY' && <>
      <label className="form-sublabel" htmlFor="recur-month-mode">Monatliche Wiederholung</label>
      <select id="recur-month-mode" className="form-select" value={monthMode} onChange={e=>update(e.target.value==='date'?{BYMONTHDAY:String(startDate.getDate()),BYDAY:null,BYSETPOS:null}:{BYMONTHDAY:null,BYDAY:`1${weekday}`,BYSETPOS:null})}>
        <option value="date">Am Tag des Monats</option><option value="weekday">An einem Wochentag</option>{monthMode==='custom' && <option value="custom">Vorhandene Sonderregel beibehalten</option>}
      </select>
      {monthMode==='date' && <><label className="form-sublabel" htmlFor="recur-month-day">Tag im Monat</label><input id="recur-month-day" className="form-input" type="number" min={1} max={31} step={1} value={rulePart(parts,'BYMONTHDAY')||startDate.getDate()} onChange={e=>update({BYMONTHDAY:e.target.value})}/><p className="form-hint">Monate ohne diesen Tag werden übersprungen.</p></>}
      {monthMode==='weekday' && <div className="recurrence-interval"><select aria-label="Woche im Monat" className="form-select" value={ordinal?.[1]??'1'} onChange={e=>update({BYDAY:`${e.target.value}${ordinal?.[2]??weekday}`})}><option value="1">Erster</option><option value="2">Zweiter</option><option value="3">Dritter</option><option value="4">Vierter</option><option value="-1">Letzter</option></select><select aria-label="Wochentag im Monat" className="form-select" value={ordinal?.[2]??weekday} onChange={e=>update({BYDAY:`${ordinal?.[1]??'1'}${e.target.value}`})}>{WEEKDAYS.map((d,i)=><option key={d} value={d}>{LABELS[i]}</option>)}</select></div>}
      {monthMode==='custom' && <p className="form-hint">Die vorhandene Regel bleibt erhalten. Eine andere Monatsoption ersetzt ihre Tagesauswahl.</p>}
    </>}
  </fieldset>;
}

import { useEffect, useRef, useState } from 'react';
import { Calendar } from '../types';
import { useRefreshBus } from '../store/refreshBus';
import { useHistoryStore } from '../store/historySlice';
import './activity.css';

type Values = Record<string, unknown>;
interface Entry { id:number; calendar_id:string; event_uid:string; summary?:string; actor:string; action?:string; scope:string; recurrence_id:string|null; at:string; before?:Values|null; after?:Values|null; }
const ACTIONS:Record<string,string>={create:'Erstellt',update:'Bearbeitet',move:'Verschoben',resize:'Dauer geändert',delete:'Gelöscht',restore:'Wiederhergestellt',purge:'Endgültig gelöscht',import:'Importiert',share:'Geteilt',sync:'Extern geändert'};
const FIELDS:Record<string,string>={summary:'Titel',start:'Beginn',end:'Ende',all_day:'Ganztägig',location:'Ort',description:'Beschreibung',rrule:'Wiederholung',reminders:'Erinnerungen',calendar_id:'Kalender'};
function display(value:unknown,field:string,calendars:Calendar[]):string {
  if(value==null||value==='')return '—';
  if(field==='calendar_id')return calendars.find(c=>c.id===value)?.name??String(value);
  if(field==='all_day')return value?'Ja':'Nein';
  if(Array.isArray(value))return value.length?value.map(v=>`${v} Min. vorher`).join(', '):'Keine';
  if((field==='start'||field==='end')&&typeof value==='string')return new Date(value).toLocaleString('de-DE');
  return String(value);
}
export function ActivityDialog({calendars,onClose}:{calendars:Calendar[];onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [tab,setTab]=useState<'activity'|'trash'>('activity');
  const [entries,setEntries]=useState<Entry[]>([]);
  const [cursor,setCursor]=useState<number|null>(null);
  const [next,setNext]=useState<number|null>(null);
  const [revision,setRevision]=useState(0);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<number|null>(null);
  const [confirm,setConfirm]=useState<number|null>(null);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  useEffect(()=>{dialog.current?.showModal();},[]);
  useEffect(()=>{
    const abort=new AbortController(); setLoading(true);setError('');
    fetch(`/api/${tab}${cursor?`?before_id=${cursor}`:''}`,{credentials:'include',signal:abort.signal})
      .then(async res=>{if(!res.ok)throw new Error('Einträge konnten nicht geladen werden.');return res.json();})
      .then(data=>{if(!abort.signal.aborted){setEntries(prev=>cursor?[...prev,...data.items]:data.items);setNext(data.next_cursor);}})
      .catch(err=>{if(!abort.signal.aborted)setError(err.message);})
      .finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return()=>abort.abort();
  },[tab,cursor,revision]);
  async function act(entry:Entry,restore:boolean) {
    if(busy!==null)return;
    setBusy(entry.id);setError('');setNotice('');
    try {
      const res=await fetch(`/api/trash/${entry.id}${restore?'/restore':''}`,{method:restore?'POST':'DELETE',credentials:'include'});
      if(!res.ok){const body=await res.json().catch(()=>({}));throw new Error(typeof body.detail==='string'?body.detail:'Aktion fehlgeschlagen. Bitte erneut versuchen.');}
      setConfirm(null);setCursor(null);setRevision(n=>n+1);
      setNotice(restore?'Wiederhergestellt. Der Kalender wird aktualisiert.':'Aus dem Papierkorb entfernt.');
      useHistoryStore.getState().clear();useRefreshBus.getState().bump();
    } catch(err){setError(err instanceof Error?err.message:'Aktion fehlgeschlagen.');}
    finally{setBusy(null);}
  }
  return <dialog ref={dialog} className="activity-dialog" onCancel={onClose} aria-labelledby="activity-title">
    <header><h2 id="activity-title">Verlauf und Papierkorb</h2><button type="button" aria-label="Schließen" onClick={onClose}>×</button></header>
    <nav aria-label="Ansicht">{(['activity','trash'] as const).map(value=><button type="button" key={value} aria-pressed={tab===value} disabled={busy!==null} onClick={()=>{setTab(value);setCursor(null);setEntries([]);setNext(null);setConfirm(null);setNotice('');}}>{value==='activity'?'Änderungshistorie':'Papierkorb'}</button>)}</nav>
    <p className="activity-help">{tab==='trash'?'Gelöschte Termine bleiben hier, bis du sie endgültig entfernst. Wiederherstellen legt eine eigenständige Kopie ohne frühere Freigaben an. Die Änderungshistorie bleibt erhalten.':'Änderungen über Termina werden ab jetzt dauerhaft aufgezeichnet. Frühere Änderungen und Änderungen aus anderen Kalender-Apps sind nicht enthalten.'}</p>
    {error&&<p role="alert">{error} <button type="button" disabled={busy!==null} onClick={()=>setRevision(n=>n+1)}>Erneut versuchen</button></p>}
    {notice&&<p role="status">{notice}</p>}
    <div className="activity-list" aria-busy={loading}>
      {!loading&&!error&&entries.length===0&&<p>{tab==='trash'?'Der Papierkorb ist leer.':'Noch keine Änderungen vorhanden.'}</p>}
      {entries.map(entry=><article key={entry.id}>
        <div className="activity-entry-heading"><strong>{entry.summary??String(entry.after?.summary??entry.before?.summary??'Termin')}</strong><span>{tab==='trash'?'Gelöscht':ACTIONS[entry.action??'']??entry.action}</span></div>
        <p className="activity-meta">{entry.actor} · {new Date(entry.at).toLocaleString('de-DE')} · {calendars.find(c=>c.id===entry.calendar_id)?.name??'Kalender'}</p>
        {entry.scope!=='all'&&<p className="activity-meta">{entry.scope==='single'?'Einzelner Termin':'Dieser und folgende Termine'}{entry.recurrence_id?` · ${new Date(entry.recurrence_id).toLocaleString('de-DE')}`:''}</p>}
        {tab==='activity'&&<details><summary>Änderungen anzeigen</summary><dl>{Object.entries(FIELDS).filter(([key])=>JSON.stringify(entry.before?.[key])!==JSON.stringify(entry.after?.[key])).map(([key,label])=><div key={key}><dt>{label}</dt><dd><span>{display(entry.before?.[key],key,calendars)}</span><span aria-hidden="true"> → </span><span>{display(entry.after?.[key],key,calendars)}</span></dd></div>)}</dl></details>}
        {tab==='trash'&&(calendars.find(c=>c.id===entry.calendar_id)?.can_write===false?<p className="activity-meta">Zum Wiederherstellen sind Schreibrechte erforderlich.</p>:<div className="activity-entry-actions">
          {confirm===entry.id?<><span>Endgültig entfernen?</span><button type="button" disabled={busy!==null} onClick={()=>act(entry,false)}>Ja, endgültig löschen</button><button type="button" disabled={busy!==null} onClick={()=>setConfirm(null)}>Abbrechen</button></>:<><button type="button" disabled={busy!==null} onClick={()=>act(entry,true)}>{busy===entry.id?'Wird verarbeitet …':'Wiederherstellen'}</button><button type="button" disabled={busy!==null} onClick={()=>setConfirm(entry.id)}>Endgültig löschen</button></>}
        </div>)}
      </article>)}
      {loading&&<p role="status">Einträge werden geladen …</p>}
    </div>
    {next!==null&&<button type="button" disabled={loading||busy!==null} onClick={()=>setCursor(next)}>Ältere Einträge laden</button>}
  </dialog>;
}
